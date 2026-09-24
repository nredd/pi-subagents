/**
 * subscription-usage.ts — OAuth-backed subscription quota collectors, a
 * normalized per-provider cache, and the dispatch decision built on it.
 *
 * A collector knows one usage endpoint (Anthropic `/api/oauth/usage`, Codex
 * `wham/usage`) and turns its payload into normalized windows. Collectors live
 * in a process-global registry so another pi extension, loaded through its own
 * module instance, can add one; `subscriptionProviderAliases` maps extra
 * provider names (a proxy, a second login) onto an existing collector.
 *
 * Fetching is deliberately conservative: successful reads are cached for five
 * minutes, `fresh` reads within a minute share one response, and a failed read
 * backs the provider off (1m, 2m, 5m, then 15m) so a throttled endpoint is not
 * hammered by every waiting dispatch. OAuth secrets never leave this module.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** How long a successful read is served from cache to plain `get` calls. */
const CACHE_TTL_MS = 5 * 60_000;
/** Minimum spacing between user-initiated (`force`) refreshes per provider. */
const MANUAL_REFRESH_INTERVAL_MS = 60_000;
/**
 * A `fresh` read reuses a snapshot retrieved this recently, so many concurrent
 * quota waiters or recoveries share one network read instead of one each.
 */
const FRESH_REUSE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Failure backoff steps; the last entry is the cap. Reset on the next success. */
const FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const;
/** Upper bound on a server-supplied `Retry-After`, so a bogus header cannot park a provider for days. */
const RETRY_AFTER_CEILING_MS = 60 * 60_000;
/**
 * Numeric reset times below this are Unix seconds, above it milliseconds.
 * 1e11 seconds is the year 5138; 1e11 milliseconds is March 1973 — no real
 * reset time falls on the wrong side of it in either unit.
 */
const SECONDS_VS_MS_THRESHOLD = 100_000_000_000;
/** Beta flag the Anthropic usage endpoint requires for OAuth bearer tokens. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
/**
 * Keep it: requests without a claude-code User-Agent land in an aggressively
 * 429'd bucket (anthropics/claude-code#31637).
 */
const ANTHROPIC_USER_AGENT = "claude-code/2.1";
/** Anthropic console API keys; they have no subscription window to report. */
const ANTHROPIC_API_KEY_PREFIX = "sk-ant-api";
/** JWT claim namespace carrying the ChatGPT account id in Codex access tokens. */
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REGISTRY_KEY: unique symbol = Symbol.for("pi-subagents.subscription-collectors");

/** `available`: fresh data. `stale`: old data kept after an expiry or failed refresh. */
export type SubscriptionUsageStatus = "available" | "stale" | "unavailable" | "error";

/** One normalized quota window. */
export interface SubscriptionUsageWindow {
  /** Provider-native window name, e.g. `five_hour`, `seven_day_opus`, `5h`. */
  name: string;
  /** 0-100; values over 100 are clamped to 100 so over-limit still blocks. */
  usedPercent: number;
  /** Epoch milliseconds, when known. */
  resetAt?: number;
  /** `provider` windows gate every model; `model` windows gate only matching `families`. */
  scope: "provider" | "model";
  /**
   * Model family tokens a `model`-scoped window applies to, e.g. `["opus"]`.
   * Matched as a whole token of the model id (see `modelMatchesFamily`).
   */
  families?: string[];
}

/** Normalized quota state for one provider at one point in time. */
export interface SubscriptionUsageSnapshot {
  provider: string;
  status: SubscriptionUsageStatus;
  windows: SubscriptionUsageWindow[];
  /** Paid credits. Only `unlimited` affects dispatch; a balance never bypasses a window. */
  credits?: { available: boolean; unlimited: boolean; balance?: string };
  retrievedAt: number;
  expiresAt: number;
  message?: string;
}

/** Result of `get`: the snapshot plus whether this call produced a new network read. */
export interface SubscriptionUsageResult {
  snapshot: SubscriptionUsageSnapshot;
  refreshed: boolean;
}

/** Side-effecting dependencies, injectable for tests. */
export interface SubscriptionUsageTransport {
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  getAccessToken(ctx: ExtensionContext, provider: string): Promise<string | undefined>;
}

/** What a collector extracts from a usage payload. */
export interface ParsedSubscriptionUsage {
  windows: SubscriptionUsageWindow[];
  credits?: SubscriptionUsageSnapshot["credits"];
}

/** A usage endpoint for one subscription family. Register with `registerSubscriptionCollector`. */
export interface SubscriptionCollector {
  /** Registry key; a provider name resolves to it directly or through `subscriptionProviderAliases`. */
  id: string;
  /** Usage endpoint, fetched with GET. */
  url: string;
  /** Request headers for the provider's access token. */
  headers(token: string): Record<string, string>;
  /** Normalize a 2xx JSON payload; `undefined` marks an unsupported shape. */
  parse(payload: unknown): ParsedSubscriptionUsage | undefined;
  /** Return false for credentials the endpoint cannot serve (e.g. API keys); no request is made. */
  acceptsToken?(token: string): boolean;
}

/** Outcome of `decisionFor`: whether dispatch on the model must wait, and why. */
export interface SubscriptionUsageDecision {
  block: boolean;
  message?: string;
  snapshot?: SubscriptionUsageSnapshot;
  window?: string;
  resetAt?: number;
}

type RegistryHost = typeof globalThis & { [REGISTRY_KEY]?: Map<string, SubscriptionCollector> };

function collectorRegistry(): Map<string, SubscriptionCollector> {
  const host = globalThis as RegistryHost;
  host[REGISTRY_KEY] ??= new Map();
  return host[REGISTRY_KEY];
}

/**
 * Register (or replace) a collector under `collector.id`. The registry is
 * shared through `globalThis`, so a collector registered by another extension
 * is visible here even when it imported a separate copy of this module.
 */
export function registerSubscriptionCollector(collector: SubscriptionCollector): void {
  collectorRegistry().set(collector.id, collector);
}

/** Look up a collector by id (not by provider name; aliases are resolved by the service). */
export function getSubscriptionCollector(id: string): SubscriptionCollector | undefined {
  return collectorRegistry().get(id);
}

/**
 * True when `family` appears in `modelId` as a whole token: bounded on each
 * side by the string edge or one of `-./:`, case-insensitive. So `opus` matches
 * `claude-opus-4-1`, `claude-3-opus-20240229` and `us.anthropic.claude-opus-4-1-v1:0`
 * but not a hypothetical `claude-magnopus`.
 */
export function modelMatchesFamily(modelId: string, family: string): boolean {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[-./:])${escaped}(?:$|[-./:])`, "i").test(modelId);
}

function errorSnapshot(provider: string, status: "error" | "unavailable", now: number, message: string): SubscriptionUsageSnapshot {
  return { provider, status, windows: [], retrievedAt: now, expiresAt: now, message };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms from Unix seconds, epoch ms, or an RFC 3339 / HTTP-date string. */
function timestamp(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const raw = finiteNumber(value);
  if (raw === undefined) return undefined;
  return raw < SECONDS_VS_MS_THRESHOLD ? raw * 1000 : raw;
}

function percentage(value: unknown): number | undefined {
  const raw = finiteNumber(value);
  if (raw === undefined || raw < 0) return undefined;
  return Math.min(raw, 100);
}

function isoMinute(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

function parseAnthropic(payload: unknown): ParsedSubscriptionUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const windows: SubscriptionUsageWindow[] = [];
  const specs = [
    ["five_hour", undefined],
    ["seven_day", undefined],
    ["seven_day_opus", ["opus"]],
    ["seven_day_sonnet", ["sonnet"]],
  ] as const;
  for (const [key, families] of specs) {
    const raw = root[key];
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const usedPercent = percentage(item.utilization ?? item.used_percentage);
    if (usedPercent === undefined) continue;
    windows.push({
      name: key,
      usedPercent,
      resetAt: timestamp(item.resets_at ?? item.reset_at),
      scope: families ? "model" : "provider",
      families: families ? [...families] : undefined,
    });
  }
  return windows.length === 0 ? undefined : { windows };
}

function parseCodex(payload: unknown): ParsedSubscriptionUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const rateLimit = root.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return undefined;
  const limits = rateLimit as Record<string, unknown>;
  const windows: SubscriptionUsageWindow[] = [];
  for (const [key, name] of [["primary_window", "5h"], ["secondary_window", "7d"]] as const) {
    const raw = limits[key];
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const usedPercent = percentage(item.used_percent);
    if (usedPercent === undefined) continue;
    windows.push({ name, usedPercent, resetAt: timestamp(item.reset_at), scope: "provider" });
  }
  if (windows.length === 0) return undefined;
  const rawCredits = root.credits;
  if (!rawCredits || typeof rawCredits !== "object") return { windows };
  const value = rawCredits as Record<string, unknown>;
  return {
    windows,
    credits: {
      available: value.has_credits === true,
      unlimited: value.unlimited === true,
      balance: typeof value.balance === "string" ? value.balance : undefined,
    },
  };
}

/** `chatgpt_account_id` from a Codex access-token JWT, or undefined when not decodable. */
function codexAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    if (!payload || typeof payload !== "object") return undefined;
    const claim = (payload as Record<string, unknown>)[CODEX_JWT_CLAIM_PATH];
    if (!claim || typeof claim !== "object") return undefined;
    const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

const BUILTIN_COLLECTORS: SubscriptionCollector[] = [
  {
    id: "anthropic",
    url: "https://api.anthropic.com/api/oauth/usage",
    headers: token => ({ Authorization: `Bearer ${token}`, "anthropic-beta": ANTHROPIC_OAUTH_BETA, "User-Agent": ANTHROPIC_USER_AGENT }),
    parse: parseAnthropic,
    acceptsToken: token => !token.startsWith(ANTHROPIC_API_KEY_PREFIX),
  },
  {
    id: "openai-codex",
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers: token => {
      const accountId = codexAccountId(token);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;
      return headers;
    },
    parse: parseCodex,
  },
];

// Set-if-absent: a second module instance must not clobber a replacement
// another extension registered under a built-in id.
for (const collector of BUILTIN_COLLECTORS) {
  if (!getSubscriptionCollector(collector.id)) registerSubscriptionCollector(collector);
}

/** `Retry-After` as milliseconds from `now`: delta-seconds or an HTTP-date. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

interface FetchOutcome {
  snapshot: SubscriptionUsageSnapshot;
  /** True when a network read was attempted and failed; drives the backoff. */
  failed: boolean;
  retryAfterMs?: number;
}

interface Backoff {
  failures: number;
  until: number;
}

/** Subscription quota state for OAuth-backed consumer plans. OAuth secrets never leave this service. */
export class SubscriptionUsageService {
  private readonly cache = new Map<string, SubscriptionUsageSnapshot>();
  private readonly lastManualRefreshAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<SubscriptionUsageSnapshot>>();
  private readonly backoff = new Map<string, Backoff>();
  /** Bumped per provider when its alias changes; stale in-flight reads are discarded. */
  private readonly generation = new Map<string, number>();
  private providerAliases: Record<string, string> = {};

  constructor(private readonly transport: SubscriptionUsageTransport = {
    fetch,
    now: () => Date.now(),
    getAccessToken: (ctx, provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
  }) {}

  /**
   * Map provider names onto collector ids (`subscriptionProviderAliases`). The
   * token and the cache stay keyed by the real provider name; only the
   * endpoint/parser is borrowed. Providers whose mapping changed lose their
   * cached data and backoff, since those came from a different collector.
   */
  setProviderAliases(aliases: Record<string, string> | undefined): void {
    const next = { ...aliases };
    for (const provider of new Set([...Object.keys(this.providerAliases), ...Object.keys(next)])) {
      if (this.providerAliases[provider] === next[provider]) continue;
      this.cache.delete(provider);
      this.backoff.delete(provider);
      // A read already in flight belongs to the old collector: detach it and
      // bump the generation so its result cannot repopulate the cache.
      this.inFlight.delete(provider);
      this.generation.set(provider, (this.generation.get(provider) ?? 0) + 1);
    }
    this.providerAliases = next;
  }

  /**
   * Current usage for `provider`.
   *   - plain: cached while younger than five minutes, else a network read.
   *   - `fresh`: bypasses the TTL, but reuses a read from the last minute.
   *   - `force`: user-initiated; limited to once per minute per provider.
   * During failure backoff none of them touch the network: the last snapshot
   * comes back as `stale` (or an `error` snapshot when there is none).
   * `signal` detaches only this caller; a shared in-flight read continues.
   */
  async get(ctx: ExtensionContext, provider: string, options: { force?: boolean; fresh?: boolean; signal?: AbortSignal } = {}): Promise<SubscriptionUsageResult> {
    const now = this.transport.now();
    const cached = this.cache.get(provider);
    const isManualRefresh = options.force === true;
    if (!isManualRefresh && cached?.status === "available") {
      if (!options.fresh && cached.expiresAt > now) return { snapshot: cached, refreshed: false };
      if (options.fresh && now - cached.retrievedAt < FRESH_REUSE_WINDOW_MS) return { snapshot: cached, refreshed: false };
    }
    const backoff = this.backoff.get(provider);
    if (backoff && backoff.until > now) {
      const until = new Date(backoff.until).toISOString();
      const message = isManualRefresh
        ? `Manual refresh skipped: backing off after a failed usage request until ${until}.`
        : `Backing off after a failed usage request until ${until}.`;
      return { snapshot: this.withStale(cached, provider, now, message), refreshed: false };
    }
    const lastManualRefreshAt = this.lastManualRefreshAt.get(provider) ?? 0;
    if (isManualRefresh && now - lastManualRefreshAt < MANUAL_REFRESH_INTERVAL_MS) {
      return { snapshot: this.withStale(cached, provider, now, "Manual refresh is limited to once per minute."), refreshed: false };
    }
    if (isManualRefresh) this.lastManualRefreshAt.set(provider, now);
    if (options.signal?.aborted) {
      return { snapshot: errorSnapshot(provider, "error", now, "Usage request was cancelled."), refreshed: false };
    }

    const snapshot = await this.waitForCaller(this.refresh(ctx, provider, now), options.signal);
    if (!snapshot) {
      return { snapshot: errorSnapshot(provider, "error", now, "Usage request was cancelled."), refreshed: false };
    }
    if (snapshot.status !== "available" && cached) {
      const stale = this.withStale(cached, provider, now, snapshot.message);
      this.cache.set(provider, stale);
      return { snapshot: stale, refreshed: false };
    }
    return { snapshot, refreshed: snapshot.status === "available" };
  }

  /** Cached snapshot without any network read; expired data is reported `stale`. */
  peek(provider: string): SubscriptionUsageSnapshot | undefined {
    const cached = this.cache.get(provider);
    if (!cached) return undefined;
    return cached.expiresAt > this.transport.now() ? cached : this.withStale(cached, provider, this.transport.now(), "Cached usage data is stale.");
  }

  /**
   * Whether dispatch on `model` must wait for included quota. Blocks when a
   * matching window is exhausted in fresh data, or in stale data whose known
   * reset is still ahead (staleness cannot make an exhausted window refill
   * early). Stale data with an unknown or past reset fails open. An unlimited
   * plan never blocks; a paid credit balance never bypasses a window.
   */
  decisionFor(model: { provider: string; id: string }): SubscriptionUsageDecision {
    const snapshot = this.peek(model.provider);
    if (!snapshot || (snapshot.status !== "available" && snapshot.status !== "stale")) return { block: false, snapshot };
    if (snapshot.credits?.unlimited === true) return { block: false, snapshot };
    const now = this.transport.now();
    const exhausted = snapshot.windows.find(window => window.usedPercent >= 100
      && (window.scope === "provider" || window.families?.some(family => modelMatchesFamily(model.id, family)) === true)
      // A known reset that has passed refilled the window, whatever the cache
      // says. An unknown reset blocks only on fresh data.
      && (window.resetAt === undefined ? snapshot.status === "available" : window.resetAt > now));
    if (!exhausted) return { block: false, snapshot };
    const reset = exhausted.resetAt ? new Date(exhausted.resetAt).toISOString() : "an unknown reset time";
    const staleNote = snapshot.status === "stale" ? " Usage data is stale, but that reset has not been reached yet." : "";
    return {
      block: true,
      snapshot,
      window: exhausted.name,
      resetAt: exhausted.resetAt,
      message: `Subscription quota blocked ${model.provider}/${model.id}: ${exhausted.name} is exhausted and resets ${reset}.${staleNote} Paid credits are not treated as subscription capacity.`,
    };
  }

  /** Human-readable one-liner for UI and tool output (local times, volatile messages). */
  format(snapshot: SubscriptionUsageSnapshot | undefined): string {
    if (!snapshot) return "usage unavailable (not checked)";
    if (snapshot.status !== "available") return `usage ${snapshot.status}: ${snapshot.message ?? "not available"}`;
    return snapshot.windows.map(window => {
      const reset = window.resetAt ? `, resets ${new Date(window.resetAt).toLocaleTimeString()}` : "";
      return `${window.name} ${Math.round(window.usedPercent)}% used${reset}`;
    }).join("; ");
  }

  /**
   * System-prompt rendering. Coarse 25% buckets, reset times in UTC to the
   * minute and only for exhausted windows, and no per-call messages: the text
   * changes only when capacity meaningfully changes, so the prompt-cache prefix
   * survives ordinary turns instead of being invalidated by every percent.
   */
  formatForPrompt(snapshot: SubscriptionUsageSnapshot | undefined): string {
    if (!snapshot) return "usage unavailable";
    // A stale snapshot keeps its last-known windows: rendering it as bare
    // `usage stale` would flip the prompt text every cache expiry and bust the
    // provider's prompt-cache prefix, while buckets rarely move in that time.
    if (snapshot.windows.length === 0) return `usage ${snapshot.status}`;
    return snapshot.windows.map(window => {
      const used = window.usedPercent;
      const bucket = used >= 100
        ? window.resetAt ? `exhausted until ${isoMinute(window.resetAt)}` : "exhausted, reset unknown"
        : used < 25 ? "<25%" : used < 50 ? "25-50%" : used < 75 ? "50-75%" : "75-100%";
      return `${window.name} ${bucket}`;
    }).join("; ");
  }

  private withStale(cached: SubscriptionUsageSnapshot | undefined, provider: string, now: number, message: string | undefined): SubscriptionUsageSnapshot {
    if (!cached) return errorSnapshot(provider, "error", now, message ?? "No cached usage data.");
    return { ...cached, status: "stale", expiresAt: now, message };
  }

  private refresh(ctx: ExtensionContext, provider: string, now: number): Promise<SubscriptionUsageSnapshot> {
    const existing = this.inFlight.get(provider);
    if (existing) return existing;

    const generation = this.generation.get(provider) ?? 0;
    const refresh = this.fetchSnapshot(ctx, provider, now)
      .then(outcome => {
        if ((this.generation.get(provider) ?? 0) !== generation) return outcome.snapshot;
        if (outcome.snapshot.status === "available") {
          this.cache.set(provider, outcome.snapshot);
          this.backoff.delete(provider);
        } else if (outcome.failed) {
          this.recordFailure(provider, outcome.retryAfterMs);
        }
        return outcome.snapshot;
      })
      .finally(() => {
        if (this.inFlight.get(provider) === refresh) this.inFlight.delete(provider);
      });
    this.inFlight.set(provider, refresh);
    return refresh;
  }

  private recordFailure(provider: string, retryAfter: number | undefined): void {
    const failures = (this.backoff.get(provider)?.failures ?? 0) + 1;
    const step = FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1];
    const delay = Math.min(Math.max(step, retryAfter ?? 0), RETRY_AFTER_CEILING_MS);
    this.backoff.set(provider, { failures, until: this.transport.now() + delay });
  }

  private async waitForCaller(
    refresh: Promise<SubscriptionUsageSnapshot>,
    signal: AbortSignal | undefined,
  ): Promise<SubscriptionUsageSnapshot | undefined> {
    if (!signal) return refresh;
    if (signal.aborted) return undefined;

    return new Promise(resolve => {
      let settled = false;
      const finish = (snapshot: SubscriptionUsageSnapshot | undefined) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(snapshot);
      };
      const abort = () => finish(undefined);
      signal.addEventListener("abort", abort, { once: true });
      void refresh.then(snapshot => finish(snapshot));
    });
  }

  private async fetchSnapshot(ctx: ExtensionContext, provider: string, now: number): Promise<FetchOutcome> {
    const unfetched = (status: "error" | "unavailable", message: string): FetchOutcome =>
      ({ snapshot: errorSnapshot(provider, status, now, message), failed: false });
    const collector = getSubscriptionCollector(this.providerAliases[provider] ?? provider);
    if (!collector) {
      const alias = this.providerAliases[provider];
      return unfetched("unavailable", alias === undefined
        ? "No subscription usage collector is installed for this provider."
        : `No subscription usage collector "${alias}" is installed (from subscriptionProviderAliases).`);
    }
    let token: string | undefined;
    try {
      token = await this.transport.getAccessToken(ctx, provider);
    } catch {
      return unfetched("error", "OAuth credential lookup failed.");
    }
    if (!token) return unfetched("unavailable", "No OAuth credential is available for this provider.");
    // `acceptsToken` may come from a third-party collector: a throw must stay a
    // snapshot, never a rejected `get()` (callers fire-and-forget it).
    let accepted: boolean;
    try {
      accepted = collector.acceptsToken?.(token) !== false;
    } catch {
      return unfetched("error", "Subscription usage collector rejected the credential check.");
    }
    if (!accepted) return unfetched("unavailable", "API-key auth has no subscription usage window.");

    const failure = (message: string, retryAfter?: number): FetchOutcome =>
      ({ snapshot: errorSnapshot(provider, "error", now, message), failed: true, retryAfterMs: retryAfter });
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await this.transport.fetch(collector.url, {
        headers: collector.headers(token),
        signal: controller.signal,
      });
      if (!response.ok) {
        return failure(`Usage request failed (${response.status}).`, retryAfterMs(response.headers.get("retry-after"), this.transport.now()));
      }
      const payload: unknown = await response.json();
      const parsed = collector.parse(payload);
      if (!parsed) return failure("Usage response had an unsupported shape.");
      return {
        snapshot: { provider, status: "available", retrievedAt: now, expiresAt: now + CACHE_TTL_MS, ...parsed },
        failed: false,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return failure(aborted ? timedOut ? "Usage request timed out." : "Usage request was cancelled." : "Usage request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Shared process-local service used by every dispatch route in one Pi session. */
const sharedSubscriptionUsage = new SubscriptionUsageService();

/** The session-wide `SubscriptionUsageService`. */
export function getSubscriptionUsageService(): SubscriptionUsageService {
  return sharedSubscriptionUsage;
}
