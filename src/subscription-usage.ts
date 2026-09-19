import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CACHE_TTL_MS = 5 * 60_000;
const MANUAL_REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type SubscriptionUsageStatus = "available" | "stale" | "unavailable" | "error";
export type SubscriptionProvider = "anthropic" | "openai-codex";

export interface SubscriptionUsageWindow {
  name: string;
  usedPercent: number;
  resetAt?: number;
  scope: "provider" | "model";
  modelIds?: string[];
}

export interface SubscriptionUsageSnapshot {
  provider: string;
  account?: string;
  status: SubscriptionUsageStatus;
  windows: SubscriptionUsageWindow[];
  credits?: { available: boolean; unlimited: boolean; balance?: string };
  retrievedAt: number;
  expiresAt: number;
  message?: string;
}

export interface SubscriptionUsageResult {
  snapshot: SubscriptionUsageSnapshot;
  refreshed: boolean;
}

export interface SubscriptionUsageTransport {
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  getAccessToken(ctx: ExtensionContext, provider: string): Promise<string | undefined>;
}

function errorSnapshot(provider: string, status: "error" | "unavailable", now: number, message: string): SubscriptionUsageSnapshot {
  return {
    provider,
    status,
    windows: [],
    retrievedAt: now,
    expiresAt: now,
    message,
  };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const raw = number(value);
  if (raw === undefined) return undefined;
  return raw < 100_000_000_000 ? raw * 1000 : raw;
}

function percentage(value: unknown): number | undefined {
  const raw = number(value);
  return raw === undefined || raw < 0 || raw > 100 ? undefined : raw;
}

function parseAnthropic(payload: unknown, _now: number): Omit<SubscriptionUsageSnapshot, "provider" | "retrievedAt" | "expiresAt"> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const windows: SubscriptionUsageWindow[] = [];
  for (const [key, scope] of [["five_hour", "provider"], ["seven_day", "provider"], ["seven_day_opus", "model"], ["seven_day_sonnet", "model"]] as const) {
    const raw = root[key];
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const usedPercent = percentage(item.utilization ?? item.used_percentage);
    if (usedPercent === undefined) continue;
    windows.push({
      name: key,
      usedPercent,
      resetAt: timestamp(item.resets_at ?? item.reset_at),
      scope,
      modelIds: scope === "model" ? [key.replace("seven_day_", "claude-")] : undefined,
    });
  }
  if (windows.length === 0) return undefined;
  return { status: "available", windows, credits: undefined, message: undefined };
}

function parseCodex(payload: unknown): Omit<SubscriptionUsageSnapshot, "provider" | "retrievedAt" | "expiresAt"> | undefined {
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
    windows.push({
      name,
      usedPercent,
      resetAt: timestamp(item.reset_at),
      scope: "provider",
    });
  }
  if (windows.length === 0) return undefined;
  const rawCredits = root.credits;
  const credits = rawCredits && typeof rawCredits === "object"
    ? (() => {
        const value = rawCredits as Record<string, unknown>;
        return {
          available: value.has_credits === true,
          unlimited: value.unlimited === true,
          balance: typeof value.balance === "string" ? value.balance : undefined,
        };
      })()
    : undefined;
  return { status: "available", windows, credits, message: undefined };
}

/** Subscription quota state for OAuth-backed consumer plans. OAuth secrets never leave this service. */
export class SubscriptionUsageService {
  private readonly cache = new Map<string, SubscriptionUsageSnapshot>();
  private lastManualRefreshAt = 0;

  constructor(private readonly transport: SubscriptionUsageTransport = {
    fetch,
    now: () => Date.now(),
    getAccessToken: (ctx, provider) => {
      const registry = ctx.modelRegistry as unknown as { getApiKeyForProvider?: (id: string) => Promise<string | undefined> };
      return registry.getApiKeyForProvider?.(provider) ?? Promise.resolve(undefined);
    },
  }) {}

  async get(ctx: ExtensionContext, provider: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<SubscriptionUsageResult> {
    const now = this.transport.now();
    const cached = this.cache.get(provider);
    const isManualRefresh = options.force === true;
    if (!isManualRefresh && cached && cached.expiresAt > now) return { snapshot: cached, refreshed: false };
    if (isManualRefresh && now - this.lastManualRefreshAt < MANUAL_REFRESH_INTERVAL_MS) {
      return { snapshot: this.withStale(cached, provider, now, "Manual refresh is limited to once per minute."), refreshed: false };
    }
    if (isManualRefresh) this.lastManualRefreshAt = now;

    const snapshot = await this.fetchSnapshot(ctx, provider, now, options.signal);
    if (snapshot.status === "available") this.cache.set(provider, snapshot);
    if (snapshot.status === "error" && cached) return { snapshot: this.withStale(cached, provider, now, snapshot.message), refreshed: false };
    return { snapshot, refreshed: snapshot.status === "available" };
  }

  peek(provider: string): SubscriptionUsageSnapshot | undefined {
    const cached = this.cache.get(provider);
    if (!cached) return undefined;
    return cached.expiresAt > this.transport.now() ? cached : this.withStale(cached, provider, this.transport.now(), "Cached usage data is stale.");
  }

  decisionFor(model: Pick<Model<any>, "provider" | "id">): { block: boolean; message?: string; snapshot?: SubscriptionUsageSnapshot } {
    const snapshot = this.peek(model.provider);
    if (!snapshot || snapshot.status !== "available") return { block: false, snapshot };
    const exhausted = snapshot.windows.find(window => window.usedPercent >= 100 && (
      window.scope === "provider" || window.modelIds?.some(id => model.id.startsWith(id))
    ));
    if (!exhausted) return { block: false, snapshot };
    const reset = exhausted.resetAt ? new Date(exhausted.resetAt).toISOString() : "an unknown reset time";
    return {
      block: true,
      snapshot,
      message: `Subscription quota blocked ${model.provider}/${model.id}: ${exhausted.name} is exhausted and resets ${reset}. Paid credits are not treated as subscription capacity.`,
    };
  }

  format(snapshot: SubscriptionUsageSnapshot | undefined): string {
    if (!snapshot) return "usage unavailable (not checked)";
    if (snapshot.status !== "available") return `usage ${snapshot.status}: ${snapshot.message ?? "not available"}`;
    return snapshot.windows.map(window => {
      const reset = window.resetAt ? `, resets ${new Date(window.resetAt).toLocaleTimeString()}` : "";
      return `${window.name} ${Math.round(window.usedPercent)}% used${reset}`;
    }).join("; ");
  }

  private withStale(cached: SubscriptionUsageSnapshot | undefined, provider: string, now: number, message: string | undefined): SubscriptionUsageSnapshot {
    if (!cached) return errorSnapshot(provider, "error", now, message ?? "No cached usage data.");
    return { ...cached, status: "stale", expiresAt: now, message };
  }

  private async fetchSnapshot(ctx: ExtensionContext, provider: string, now: number, signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> {
    if (provider !== "anthropic" && provider !== "openai-codex") {
      return errorSnapshot(provider, "unavailable", now, "No subscription usage collector is installed for this provider.");
    }
    const token = await this.transport.getAccessToken(ctx, provider);
    if (!token) return errorSnapshot(provider, "unavailable", now, "No OAuth credential is available for this provider.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.transport.fetch(
        provider === "anthropic" ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage",
        {
          headers: provider === "anthropic"
            ? { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1" }
            : { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );
      if (!response.ok) return errorSnapshot(provider, "error", now, `Usage request failed (${response.status}).`);
      const payload: unknown = await response.json();
      const parsed = provider === "anthropic" ? parseAnthropic(payload, now) : parseCodex(payload);
      if (!parsed) return errorSnapshot(provider, "error", now, "Usage response had an unsupported shape.");
      return { provider, retrievedAt: now, expiresAt: now + CACHE_TTL_MS, ...parsed };
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError" ? "Usage request timed out." : "Usage request failed.";
      return errorSnapshot(provider, "error", now, message);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

/** Shared process-local service used by every dispatch route in one Pi session. */
const sharedSubscriptionUsage = new SubscriptionUsageService();

export function getSubscriptionUsageService(): SubscriptionUsageService {
  return sharedSubscriptionUsage;
}
