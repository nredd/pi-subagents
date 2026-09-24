/**
 * quota-waiter.ts — Admission, parking and recovery for dispatches blocked on
 * included subscription quota.
 *
 * `AgentManager` owns records, pools and runs; this module owns everything that
 * decides whether a record may run on quota right now and what happens while it
 * may not: building a spawn's model chain, the "all blocked" error, parked
 * waits (timer, fresh re-read on wake, deadline, cancel, the serializable
 * dispatch a restart restores from), and the confirm-then-rescan step of
 * mid-run recovery.
 *
 * The seam is deliberately narrow. The waiter never touches a pool or starts a
 * run itself — a preflight wait that finds a usable model hands the record back
 * through `QuotaWaiterHost.startParked`, and a mid-run wait resolves the promise
 * the manager is awaiting. Keeping slot accounting on one side of the seam is
 * what stops a woken wait from oversubscribing a full pool.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnArgs, SpawnOptions } from "./agent-manager.js";
import { getAgentConfig } from "./agent-types.js";
import {
  chooseQuotaModel,
  getQuotaExhaustionPolicy,
  getQuotaFallbackModels,
  getQuotaWaitTimeoutMinutes,
  type QuotaModelSelection,
  resolveEffectiveFallbackModels,
} from "./fallback-models.js";
import { describeModel, type ModelRegistry, resolveModel } from "./model-resolver.js";
import { nextQuotaCheckAt } from "./quota-wait.js";
import type { SubscriptionUsageService } from "./subscription-usage.js";
import type {
  AgentQuotaWaitEvent,
  AgentRecord,
  QuotaBlockedModel,
  QuotaWaitDispatch,
  QuotaWaitInfo,
  SubagentType,
} from "./types.js";

/** The slice of `SubscriptionUsageService` quota admission depends on. */
export type QuotaUsage = Pick<SubscriptionUsageService, "get" | "decisionFor">;

/** One model's quota verdict, as `SubscriptionUsageService.decisionFor` returns it. */
export type QuotaDecision = ReturnType<SubscriptionUsageService["decisionFor"]>;

/** A model the chain settled on, with its position in that chain. */
export interface QuotaModelChoice {
  model: Model<any>;
  index: number;
}

type BlockedDecisions = ReadonlyArray<{
  model: Model<any>;
  decision: { window?: string; resetAt?: number };
}>;

/**
 * Node clamps any `setTimeout` delay above 2^31-1 ms (~24.8 days) to 1 ms, so
 * a longer wait would spin. A wake scheduled at this ceiling re-arms without
 * refreshing usage (see `wake`).
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Failure text that suggests a provider quota rather than an ordinary error. */
const QUOTA_FAILURE_PATTERN = /(?:\b429\b|quota|rate[ _-]?limit|too many requests|usage limit|credit balance)/i;

/** Prompt for a run rebound after mid-run exhaustion: the history is preserved, so it must not restart. */
export const QUOTA_CONTINUATION_PROMPT = "Continue from the preserved conversation after the provider quota interruption. Do not restart the original task.";

/** Whether a run's failure text looks like quota exhaustion — the cue to confirm with a fresh read. */
export function isQuotaFailure(failure: string | undefined): failure is string {
  return failure !== undefined && QUOTA_FAILURE_PATTERN.test(failure);
}

/**
 * Re-read usage for every distinct provider in `models`. Never throws: a
 * failed read leaves that provider's cache as it was, and admission then
 * decides from whatever the cache says (advisory decisions fail open).
 */
export async function refreshProviders(
  service: Pick<SubscriptionUsageService, "get">,
  ctx: ExtensionContext,
  models: ReadonlyArray<{ provider: string }>,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const providers = [...new Set(models.map(model => model.provider))];
  await Promise.all(providers.map(async provider => {
    try {
      await service.get(ctx, provider, options);
    } catch { /* keep the cached state; see above */ }
  }));
}

/**
 * Non-fresh `refreshProviders` for just the models whose provider has no fresh
 * cached usage. Returns undefined, synchronously, when there is nothing to
 * read, so a caller can skip the await: an already-warm dispatch then starts
 * in the same tick, and concurrent dispatches keep their call order.
 */
export function warmProviders(
  usage: QuotaUsage,
  ctx: ExtensionContext,
  models: ReadonlyArray<Model<any>>,
  signal?: AbortSignal,
): Promise<void> | undefined {
  const cold = models.filter(model => usage.decisionFor(model).snapshot?.status !== "available");
  return cold.length === 0 ? undefined : refreshProviders(usage, ctx, cold, { signal });
}

/**
 * Whether a dispatch may park instead of failing when its whole chain is
 * blocked. Only under `wait-async`, and never for a top-level caller blocking
 * inline: pi has no tool timeout, so parking it would freeze the main session
 * for up to the wait timeout. Owned children (nested, workflow) may wait even
 * when blocking — their owner is itself a background run.
 */
export function mayWaitForQuota(options: Pick<SpawnOptions, "parentAgentId" | "workflowId" | "blocking">): boolean {
  if (getQuotaExhaustionPolicy() !== "wait-async") return false;
  if (options.parentAgentId !== undefined || options.workflowId !== undefined) return true;
  return options.blocking !== true;
}

/** Blocked decisions in the serializable shape waits persist and report. */
export function describeBlockedModels(blocked: BlockedDecisions): QuotaBlockedModel[] {
  return blocked.map(({ model, decision }) => ({
    modelId: describeModel(model).modelId,
    window: decision.window ?? "included quota",
    resetAt: decision.resetAt,
  }));
}

const formatReset = (resetAt: number | undefined): string =>
  resetAt === undefined ? "an unknown time" : new Date(resetAt).toISOString();

/**
 * The error for a dispatch whose every candidate is blocked. Names each model
 * with the window that blocked it and when that window resets, so the caller
 * can tell a five-hour stall from a weekly one without asking.
 */
export function allModelsBlockedMessage(blocked: BlockedDecisions, earliestResetAt: number | undefined): string {
  const models = describeBlockedModels(blocked)
    .map(item => `${item.modelId} (${item.window}, resets ${formatReset(item.resetAt)})`)
    .join(", ");
  const earliest = earliestResetAt === undefined ? "unknown" : new Date(earliestResetAt).toISOString();
  return `Subscription quota blocked dispatch: all configured models are blocked by exhausted included quota: ${models}; earliest reset is ${earliest}.`;
}

/**
 * How durably a wait is persisted. Owned children live and die with their
 * owner's process, so they are never persisted. A wait that can only resume an
 * existing conversation (`requiresSessionFile`, the mid-run and resume parks)
 * is session-persisted only when there is a session file to reopen.
 */
function quotaWaitPersistence(
  options: Pick<SpawnOptions, "scheduleId" | "parentAgentId" | "workflowId" | "resumeSessionFile">,
  requiresSessionFile: boolean,
): QuotaWaitInfo["persistence"] {
  if (options.scheduleId !== undefined) return "schedule";
  if (options.parentAgentId !== undefined || options.workflowId !== undefined) return "process";
  if (requiresSessionFile && options.resumeSessionFile === undefined) return "process";
  return "session";
}

/** Resolve canonical `provider/id` strings, dropping any the registry no longer knows. */
export function resolveQuotaModelIds(ids: readonly string[], registry: ModelRegistry): Model<any>[] {
  const models: Model<any>[] = [];
  for (const id of ids) {
    const resolved = resolveModel(id, registry);
    if (typeof resolved !== "string") models.push(resolved);
  }
  return models;
}

/** The fields of a spawn that decide its quota chain. */
export type QuotaChainSpec = Pick<SpawnOptions, "model" | "fallbackModels" | "configCwd" | "quotaModelChain">;

/** A spawn's ordered candidate models, primary first. */
export interface QuotaModelChain {
  models: Model<any>[];
  /** Resolved fallback ids, when any source declared a chain — recorded on the invocation. */
  fallbackModels?: string[];
  /** Non-fatal notes about dropped or out-of-scope fallback candidates. */
  warnings: string[];
}

/**
 * Build the chain a spawn is admitted against: the effective primary (explicit,
 * else the agent's configured model, else the parent's), then every resolved
 * fallback. A restored wait uses its captured chain verbatim instead, so a
 * config edit between park and restore cannot change what it waits on.
 *
 * Pure apart from reading config; throws only for a restored chain that no
 * longer resolves to anything.
 */
export function buildQuotaModelChain(ctx: ExtensionContext, type: SubagentType, spec: QuotaChainSpec): QuotaModelChain {
  if (spec.quotaModelChain !== undefined) {
    if (!ctx.modelRegistry) throw new Error("Cannot restore quota wait without a model registry.");
    const models = resolveQuotaModelIds(spec.quotaModelChain, ctx.modelRegistry);
    if (models.length === 0) throw new Error("Persisted quota wait has no currently available model.");
    return { models, warnings: [] };
  }

  const agentConfig = getAgentConfig(type);
  const resolvedConfigured = agentConfig?.model ? resolveModel(agentConfig.model, ctx.modelRegistry) : undefined;
  const primary = spec.model
    ?? (typeof resolvedConfigured === "string" ? undefined : resolvedConfigured)
    ?? ctx.model;
  if (!primary) return { models: [], warnings: [] };

  const globalFallbackModels = getQuotaFallbackModels();
  const declared = agentConfig?.fallbackModels !== undefined
    || spec.fallbackModels !== undefined
    || globalFallbackModels !== undefined;
  if (!declared || !ctx.modelRegistry) return { models: [primary], warnings: [] };

  const resolved = resolveEffectiveFallbackModels({
    primaryModel: primary,
    sources: {
      agentFrontmatter: agentConfig?.fallbackModels,
      call: spec.fallbackModels,
      global: globalFallbackModels,
    },
    modelRegistry: ctx.modelRegistry,
    cwd: spec.configCwd ?? ctx.cwd,
  });
  return {
    models: [primary, ...resolveQuotaModelIds(resolved.fallbackModels, ctx.modelRegistry)],
    fallbackModels: resolved.fallbackModels,
    warnings: resolved.warnings,
  };
}

/** The `subagents:waiting` event payload for one wait transition. */
export function quotaWaitEventPayload(record: Pick<AgentRecord, "id" | "type" | "description">, event: AgentQuotaWaitEvent) {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    transition: event.transition,
    phase: event.wait.phase,
    nextCheckAt: event.wait.nextCheckAt,
    deadlineAt: event.wait.deadlineAt,
    blocked: event.wait.blocked,
    persistence: event.wait.persistence,
  };
}

/** Outcome of confirming a quota-looking mid-run failure. */
export type MidRunQuotaOutcome =
  /** The fresh read failed or did not confirm exhaustion: surface the failure as-is. */
  | { kind: "unconfirmed" }
  /** Exhaustion confirmed and a chain model is usable now. */
  | { kind: "available"; choice: QuotaModelChoice }
  /** Exhaustion confirmed and every chain model is blocked. */
  | { kind: "blocked"; selection: QuotaModelSelection<Model<any>, QuotaDecision> };

/** What `QuotaWaiter` needs from the manager that owns the records it parks. */
export interface QuotaWaiterHost {
  getRecord(id: string): AgentRecord | undefined;
  /**
   * Wire the caller's abort to a record about to be parked. False when the
   * signal is already aborted, in which case the host has stopped the record
   * and it must not be parked.
   */
  armQueuedAbort(id: string, signal: AbortSignal | undefined): boolean;
  /**
   * A preflight wait found a usable model (already on `args.options.model`).
   * Start the record, or queue it for a pool slot, and call `release` once its
   * startup settles.
   */
  startParked(record: AgentRecord, args: SpawnArgs, release: () => void): void;
  /** A preflight wait timed out; the record is terminal. */
  completed(record: AgentRecord): void;
  /** Every wait transition, for persistence and UI. Must not throw into the waiter. */
  onTransition?(record: AgentRecord, event: AgentQuotaWaitEvent): void;
}

interface WaitBase {
  args: SpawnArgs;
  models: Model<any>[];
  timer?: ReturnType<typeof setTimeout>;
}

/** A dispatch that never started: waking it starts the record. */
interface PreflightWait extends WaitBase {
  kind: "preflight";
  release: () => void;
}

/** A run (or resume) someone is awaiting: waking it resolves their promise. */
interface ContinuationWait extends WaitBase {
  kind: "continuation";
  resolve: (choice: QuotaModelChoice | undefined) => void;
}

type Wait = PreflightWait | ContinuationWait;

/** Parked quota waits, keyed by record id. See the module header for the seam. */
export class QuotaWaiter {
  /** Waits own no pool slot and are not pool-queue entries. */
  private waits = new Map<string, Wait>();

  constructor(
    private readonly usage: QuotaUsage,
    private readonly host: QuotaWaiterHost,
  ) {}

  /** First unblocked model in `models`, from cached decisions. */
  select(models: readonly Model<any>[]): QuotaModelSelection<Model<any>, QuotaDecision> {
    return chooseQuotaModel(models, candidate => this.usage.decisionFor(candidate));
  }

  /** Ids of every parked wait. */
  ids(): string[] {
    return [...this.waits.keys()];
  }

  /**
   * Park a dispatch that never started because its whole chain is blocked. The
   * record is "queued" with a `startGate` that opens once it starts, times out
   * or is cancelled. A restored dispatch keeps its original park time,
   * deadline and poll backoff.
   */
  parkPreflight(record: AgentRecord, args: SpawnArgs, models: Model<any>[], blocked: BlockedDecisions): void {
    const now = Date.now();
    const restored = args.options.quotaWaitRestore;
    const parkedAt = restored?.parkedAt ?? now;
    const deadlineAt = restored?.deadlineAt ?? parkedAt + getQuotaWaitTimeoutMinutes() * 60_000;
    const unknownPollAttempt = restored?.unknownPollAttempt ?? 0;
    const blockedModels = describeBlockedModels(blocked);

    record.status = "queued";
    let release!: () => void;
    record.startGate = new Promise<void>(resolve => { release = resolve; });
    if (!this.host.armQueuedAbort(record.id, args.options.signal)) {
      record.startGate = undefined;
      release();
      return;
    }
    record.quotaWait = {
      phase: restored?.phase ?? "preflight",
      parkedAt,
      deadlineAt,
      nextCheckAt: nextQuotaCheckAt({ now, deadline: deadlineAt, unknownPollAttempt, blocked: blockedModels }),
      unknownPollAttempt,
      blocked: blockedModels,
      persistence: quotaWaitPersistence(args.options, false),
    };
    const wait: PreflightWait = { kind: "preflight", args, models, release };
    this.waits.set(record.id, wait);
    this.emit(record, wait, "parked", record.quotaWait);
    if (now >= deadlineAt) {
      this.timeOut(record.id, record, wait);
      return;
    }
    this.schedule(record.id, wait);
  }

  /**
   * Park a run that must continue an existing conversation — confirmed mid-run
   * exhaustion, or a resume whose session model is blocked. Resolves with the
   * model to continue on, or undefined on timeout or cancel. The caller owns
   * slot release and reacquisition around the await.
   */
  parkContinuation(
    record: AgentRecord,
    args: SpawnArgs,
    models: Model<any>[],
    blocked: BlockedDecisions,
    phase: QuotaWaitInfo["phase"],
  ): Promise<QuotaModelChoice | undefined> {
    const parkedAt = Date.now();
    const deadlineAt = parkedAt + getQuotaWaitTimeoutMinutes() * 60_000;
    const blockedModels = describeBlockedModels(blocked);
    record.status = "queued";
    record.quotaWait = {
      phase,
      parkedAt,
      deadlineAt,
      nextCheckAt: nextQuotaCheckAt({ now: parkedAt, deadline: deadlineAt, unknownPollAttempt: 0, blocked: blockedModels }),
      unknownPollAttempt: 0,
      blocked: blockedModels,
      persistence: quotaWaitPersistence(args.options, true),
    };
    const quotaWait = record.quotaWait;
    return new Promise(resolve => {
      const wait: ContinuationWait = { kind: "continuation", args, models, resolve };
      this.waits.set(record.id, wait);
      this.emit(record, wait, "parked", quotaWait);
      this.schedule(record.id, wait);
    });
  }

  /**
   * Confirm a quota-looking mid-run failure with a fresh read of the model that
   * failed, then fresh-read the whole chain and pick again.
   *
   * The rescan starts from index 0, not after the failed model, on purpose: a
   * primary whose window has reset since dispatch should win again. The model
   * that just failed cannot be re-picked, because the confirming read left it
   * blocked in the cache.
   */
  async confirmMidRunExhaustion(
    ctx: ExtensionContext,
    failedModel: Model<any>,
    chain: Model<any>[],
    signal: AbortSignal | undefined,
  ): Promise<MidRunQuotaOutcome> {
    try {
      await this.usage.get(ctx, failedModel.provider, { fresh: true, signal });
    } catch {
      return { kind: "unconfirmed" };
    }
    if (!this.usage.decisionFor(failedModel).block) return { kind: "unconfirmed" };

    await refreshProviders(this.usage, ctx, chain, { fresh: true, signal });
    const selection = this.select(chain);
    return selection.selected
      ? { kind: "available", choice: { model: selection.selected, index: selection.selectedIndex ?? 0 } }
      : { kind: "blocked", selection };
  }

  /**
   * Cancel a parked wait: clear its timer, release its gate or resolve its
   * awaiter with undefined. `notify` false skips the `cancelled` transition —
   * for dispose, where the session is going away and must not persist a
   * cancellation of a wait the next session should restore.
   */
  cancel(id: string, notify = true): boolean {
    const wait = this.waits.get(id);
    if (!wait) return false;
    if (wait.timer) clearTimeout(wait.timer);
    this.waits.delete(id);
    const record = this.host.getRecord(id);
    if (record?.quotaWait) {
      if (notify) this.emit(record, wait, "cancelled", record.quotaWait);
      record.quotaWait = undefined;
    }
    if (wait.kind === "preflight") wait.release();
    else wait.resolve(undefined);
    return true;
  }

  private schedule(id: string, wait: Wait): void {
    const record = this.host.getRecord(id);
    if (!record?.quotaWait || this.waits.get(id) !== wait) return;
    const delay = Math.min(Math.max(0, record.quotaWait.nextCheckAt - Date.now()), MAX_TIMER_DELAY_MS);
    wait.timer = setTimeout(() => {
      wait.timer = undefined;
      void this.wake(id, wait);
    }, delay);
    wait.timer.unref();
  }

  /** Whether `wait` is still the live wait for a still-parked record. */
  private isLive(id: string, wait: Wait, record: AgentRecord | undefined): record is AgentRecord & { quotaWait: QuotaWaitInfo } {
    return !!record?.quotaWait && record.status === "queued" && this.waits.get(id) === wait;
  }

  private async wake(id: string, wait: Wait): Promise<void> {
    const record = this.host.getRecord(id);
    if (!this.isLive(id, wait, record)) return;
    const now = Date.now();
    if (now >= record.quotaWait.deadlineAt) {
      this.timeOut(id, record, wait);
      return;
    }
    // Woken early by the MAX_TIMER_DELAY_MS clamp: re-arm without a read.
    if (now < record.quotaWait.nextCheckAt) {
      this.schedule(id, wait);
      return;
    }

    await refreshProviders(this.usage, wait.args.ctx, wait.models, {
      fresh: true,
      signal: record.abortController?.signal,
    });
    // The read is async: a cancel or timeout may have landed meanwhile.
    if (!this.isLive(id, wait, record)) return;

    const selection = this.select(wait.models);
    if (selection.selected) {
      record.quotaModelIndex = selection.selectedIndex;
      wait.args.options.model = selection.selected;
      this.finish(id, record, wait, "released");
      if (wait.kind === "preflight") this.host.startParked(record, wait.args, wait.release);
      else wait.resolve({ model: selection.selected, index: selection.selectedIndex ?? 0 });
      return;
    }

    const checkedAt = Date.now();
    if (checkedAt >= record.quotaWait.deadlineAt) {
      this.timeOut(id, record, wait);
      return;
    }
    const blocked = describeBlockedModels(selection.blocked);
    const unknownPollAttempt = record.quotaWait.unknownPollAttempt + 1;
    record.quotaWait = {
      ...record.quotaWait,
      blocked,
      unknownPollAttempt,
      nextCheckAt: nextQuotaCheckAt({ now: checkedAt, deadline: record.quotaWait.deadlineAt, unknownPollAttempt, blocked }),
    };
    this.emit(record, wait, "updated", record.quotaWait);
    this.schedule(id, wait);
  }

  /** Drop a wait and report its terminal transition. Leaves `record.status` to the caller. */
  private finish(id: string, record: AgentRecord, wait: Wait, transition: "released" | "timed-out"): void {
    if (wait.timer) clearTimeout(wait.timer);
    this.waits.delete(id);
    if (record.quotaWait) this.emit(record, wait, transition, record.quotaWait);
    record.quotaWait = undefined;
  }

  private timeOut(id: string, record: AgentRecord, wait: Wait): void {
    if (wait.timer) clearTimeout(wait.timer);
    if (this.waits.get(id) !== wait) return;
    this.finish(id, record, wait, "timed-out");
    record.status = "error";
    record.error = `Subscription quota wait timed out after ${getQuotaWaitTimeoutMinutes()} minute(s).`;
    record.completedAt = Date.now();
    if (wait.kind === "continuation") {
      wait.resolve(undefined);
      return;
    }
    // Mirrors settleRun: an inline caller learns of the timeout from its own
    // result, so an unconsumed record would report it twice.
    if (!record.isBackground) record.resultConsumed = true;
    wait.release();
    this.host.completed(record);
  }

  private emit(record: AgentRecord, wait: Wait, transition: AgentQuotaWaitEvent["transition"], info: QuotaWaitInfo): void {
    try {
      this.host.onTransition?.(record, {
        transition,
        wait: { ...info, blocked: info.blocked.map(item => ({ ...item })) },
        dispatch: this.dispatchFor(record, wait, info),
      });
    } catch { /* ignore wait-observer errors */ }
  }

  /** The serializable form a session or scheduler restore rebuilds this wait from. */
  private dispatchFor(record: AgentRecord, wait: Wait, info: QuotaWaitInfo): QuotaWaitDispatch {
    const options = wait.args.options;
    return {
      version: 1,
      id: record.id,
      type: wait.args.type,
      prompt: wait.args.prompt,
      modelChain: wait.models.map(model => describeModel(model).modelId),
      wait: { ...info, blocked: info.blocked.map(item => ({ ...item })) },
      options: {
        description: options.description,
        name: options.name,
        resumeSessionFile: options.resumeSessionFile,
        reclaim: record.handle
          ? { handle: record.handle, alias: record.alias }
          : options.reclaim ? { ...options.reclaim } : undefined,
        maxTurns: options.maxTurns,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        isBackground: options.isBackground,
        isolation: options.isolation,
        invocation: options.invocation ? { ...options.invocation } : undefined,
        depth: options.depth,
        maxSubagentDepth: options.maxSubagentDepth,
        configCwd: options.configCwd,
        cwd: options.cwd ?? undefined,
        rootSessionId: options.rootSessionId,
        scheduleId: options.scheduleId,
        priorTurns: options.priorTurns,
      },
    };
  }
}
