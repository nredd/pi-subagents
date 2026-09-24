/**
 * quota-waiter.test.ts — quota admission, parking and recovery as seen through
 * `AgentManager`, plus the pure helpers `quota-waiter.ts` exports.
 *
 * Runs are mocked (`runAgent`/`resumeAgent`), usage is a small in-memory stub
 * with a real cache/decision split, so admission decides exactly the way the
 * real service would: from whatever the cache holds at the time.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type EventBus, registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { setQuotaExhaustionPolicy, setQuotaFallbackModels, setQuotaWaitTimeoutMinutes } from "../src/fallback-models.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { allModelsBlockedMessage, quotaWaitEventPayload, refreshProviders } from "../src/quota-waiter.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import type { AgentQuotaWaitEvent, AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { createWorktree } from "../src/worktree.js";

const NOW = 1_700_000_000_000;
const RESET_A = NOW + 3_600_000;
const RESET_B = NOW + 7_200_000;

const opus = { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" } as any;
const terra = { provider: "openai-codex", id: "gpt-5.6-terra", name: "GPT-5.6 Terra" } as any;
const models = [opus, terra];
const ctx = {
  cwd: "/tmp",
  model: opus,
  modelRegistry: {
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
    getAll: () => models,
    getAvailable: () => models,
  },
} as any;
const pi = {} as any;

interface Window { window: string; resetAt?: number }

/**
 * Usage stub with the service's cache/decision split: `server` is what a read
 * would return, `cache` is what `decisionFor` sees. A provider absent from the
 * cache decides `block: false` (fails open), like a cold real cache.
 */
function usageStub() {
  const server = new Map<string, Window | null>();
  const cache = new Map<string, Window | null>();
  const get = vi.fn(async (_ctx: unknown, provider: string, _options?: unknown) => {
    // After a tick, like a real read: a caller that does not await sees nothing.
    await Promise.resolve();
    cache.set(provider, server.get(provider) ?? null);
    return { snapshot: {} as any, refreshed: true };
  });
  const decisionFor = vi.fn((model: { provider: string; id: string }) => {
    const exhausted = cache.get(model.provider);
    // Any cached entry counts as fresh, so `warmProviders` skips it.
    const snapshot = cache.has(model.provider) ? { status: "available" } as any : undefined;
    return exhausted
      ? { block: true, message: `${model.provider} exhausted`, window: exhausted.window, resetAt: exhausted.resetAt, snapshot }
      : { block: false, snapshot };
  });
  const exhaust = (provider: string, window: Window, cached = true) => {
    server.set(provider, window);
    if (cached) cache.set(provider, window);
  };
  const recover = (provider: string) => server.set(provider, null);
  return { get, decisionFor, exhaust, recover, cache };
}

const session = (model: any) => ({
  dispose: vi.fn(),
  model,
  sessionManager: { getSessionFile: () => "/sessions/agent.jsonl" },
  setModel: vi.fn(async function (this: any, next: any) { this.model = next; }),
}) as any;

const done = (s = session(opus)) => ({ responseText: "done", session: s, aborted: false, steered: false });

describe("quota-waiter", () => {
  let manager: AgentManager | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(createWorktree).mockReset();
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    setQuotaExhaustionPolicy(undefined);
    setQuotaWaitTimeoutMinutes(undefined);
    setQuotaFallbackModels(undefined);
    vi.useRealTimers();
  });

  describe("blocked message", () => {
    it("names every blocked model with its window and reset, plus the earliest reset", () => {
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_B });
      usage.exhaust("openai-codex", { window: "weekly", resetAt: RESET_A });
      manager = new AgentManager({ subscriptionUsage: usage });

      expect(() => manager!.spawn(pi, ctx, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        model: opus,
        fallbackModels: ["openai-codex/gpt-5.6-terra"],
      })).toThrow(
        "Subscription quota blocked dispatch: all configured models are blocked by exhausted included quota: "
        + `anthropic/claude-opus-4-6 (five_hour, resets ${new Date(RESET_B).toISOString()}), `
        + `openai-codex/gpt-5.6-terra (weekly, resets ${new Date(RESET_A).toISOString()}); `
        + `earliest reset is ${new Date(RESET_A).toISOString()}.`,
      );
    });

    it("says so when a reset is unknown", () => {
      expect(allModelsBlockedMessage([{ model: opus, decision: {} }], undefined)).toBe(
        "Subscription quota blocked dispatch: all configured models are blocked by exhausted included quota: "
        + "anthropic/claude-opus-4-6 (included quota, resets an unknown time); earliest reset is unknown.",
      );
    });
  });

  describe("warmQuota", () => {
    it("lets a spawn after it block on a provider the cold cache did not know was exhausted", async () => {
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A }, false);
      usage.exhaust("openai-codex", { window: "weekly", resetAt: RESET_B }, false);
      manager = new AgentManager({ subscriptionUsage: usage });
      const options = { description: "d", isBackground: true, model: opus, fallbackModels: ["openai-codex/gpt-5.6-terra"] };

      // Cold: admission fails open.
      expect(usage.decisionFor(opus).block).toBe(false);
      await manager.warmQuota(ctx, "general-purpose", options);

      expect(usage.get).toHaveBeenCalledTimes(2);
      expect(usage.get).toHaveBeenCalledWith(ctx, "anthropic", { signal: undefined });
      expect(usage.get).toHaveBeenCalledWith(ctx, "openai-codex", { signal: undefined });
      expect(() => manager!.spawn(pi, ctx, "general-purpose", "p", { ...options })).toThrow("all configured models are blocked");
      expect(manager.listAgents()).toHaveLength(0);
    });

    it("never throws, for a failing read or an unresolvable restored chain", async () => {
      const usage = usageStub();
      usage.get.mockRejectedValue(new Error("usage endpoint down"));
      manager = new AgentManager({ subscriptionUsage: usage });

      await expect(manager.warmQuota(ctx, "general-purpose", { model: opus })).resolves.toBeUndefined();
      expect(manager.warmQuota(ctx, "general-purpose", { quotaModelChain: ["nope/nothing"] })).toBeUndefined();
    });

    it("refreshProviders reads each distinct provider once and swallows failures", async () => {
      const get = vi.fn(async (_ctx: unknown, provider: string) => {
        if (provider === "openai-codex") throw new Error("down");
        return { snapshot: {} as any, refreshed: true };
      });
      await expect(refreshProviders({ get }, ctx, [opus, opus, terra], { fresh: true })).resolves.toBeUndefined();
      expect(get.mock.calls.map(call => call[1])).toEqual(["anthropic", "openai-codex"]);
      expect(get).toHaveBeenCalledWith(ctx, "anthropic", { fresh: true });
    });
  });

  describe("parked waits", () => {
    it("queues a woken wait for a slot instead of oversubscribing a full pool", async () => {
      setQuotaExhaustionPolicy("wait-async");
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: NOW + 60_000 });
      let finishHolder!: () => void;
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt) => {
        if (prompt === "hold") await new Promise<void>(resolve => { finishHolder = resolve; });
        return done();
      });
      manager = new AgentManager({ maxConcurrent: 1, subscriptionUsage: usage });

      const parkedId = manager.spawn(pi, ctx, "general-purpose", "parked", { description: "parked", isBackground: true, model: opus });
      expect(manager.getRecord(parkedId)?.quotaWait).toBeDefined();
      // Only the terra holder can run; it takes the single slot.
      const holderId = manager.spawn(pi, ctx, "general-purpose", "hold", { description: "hold", isBackground: true, model: terra });
      expect(manager.getRecord(holderId)?.status).toBe("running");

      usage.recover("anthropic");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(manager.getRecord(parkedId)).toMatchObject({ status: "queued", quotaWait: undefined });
      expect(runAgent).toHaveBeenCalledTimes(1);

      finishHolder();
      await manager.getRecord(holderId)?.promise;
      await vi.advanceTimersByTimeAsync(0);
      await manager.getRecord(parkedId)?.promise;
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(manager.getRecord(parkedId)?.status).toBe("completed");
    });

    it("blocks before a worktree is created, whether it fails or parks", async () => {
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });
      manager = new AgentManager({ subscriptionUsage: usage });
      const options = { description: "d", isBackground: true, isolation: "worktree" as const, model: opus };

      expect(() => manager!.spawn(pi, ctx, "general-purpose", "p", { ...options })).toThrow("all configured models are blocked");
      setQuotaExhaustionPolicy("wait-async");
      const id = manager.spawn(pi, ctx, "general-purpose", "p", { ...options });
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getRecord(id)?.status).toBe("queued");
      expect(createWorktree).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("cancelling clears the wake timer and reports `cancelled`", async () => {
      setQuotaExhaustionPolicy("wait-async");
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });
      const onQuotaWait = vi.fn();
      manager = new AgentManager({ subscriptionUsage: usage, onQuotaWait });
      const baseline = vi.getTimerCount();

      const id = manager.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true, model: opus });
      expect(vi.getTimerCount()).toBe(baseline + 1);
      expect(manager.abort(id)).toBe(true);

      expect(vi.getTimerCount()).toBe(baseline);
      expect(onQuotaWait).toHaveBeenLastCalledWith(expect.objectContaining({ id }), expect.objectContaining({ transition: "cancelled" }));
      await vi.advanceTimersByTimeAsync(2 * 3_600_000);
      expect(usage.get).not.toHaveBeenCalled();
    });

    it("defaults the wait deadline to 7 days", () => {
      setQuotaExhaustionPolicy("wait-async");
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "weekly" });
      manager = new AgentManager({ subscriptionUsage: usage });

      const id = manager.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true, model: opus });
      const wait = manager.getRecord(id)!.quotaWait!;
      expect(wait.deadlineAt - wait.parkedAt).toBe(10_080 * 60_000);
    });

    it("restoring the same persisted wait twice keeps one record", () => {
      setQuotaExhaustionPolicy("wait-async");
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });
      const events: AgentQuotaWaitEvent[] = [];
      manager = new AgentManager({ subscriptionUsage: usage, onQuotaWait: (_r, e) => events.push(e) });
      const dispatch = {
        version: 1 as const,
        id: "restored-1",
        type: "general-purpose",
        prompt: "p",
        modelChain: ["anthropic/claude-opus-4-6"],
        wait: {
          phase: "preflight" as const,
          parkedAt: NOW,
          deadlineAt: NOW + 86_400_000,
          nextCheckAt: RESET_A,
          unknownPollAttempt: 0,
          blocked: [{ modelId: "anthropic/claude-opus-4-6", window: "five_hour", resetAt: RESET_A }],
          persistence: "session" as const,
        },
        options: { description: "d", isBackground: true },
      };

      expect(manager.restoreQuotaWait(pi, ctx, dispatch)).toBe("restored-1");
      expect(manager.restoreQuotaWait(pi, ctx, dispatch)).toBe("restored-1");
      expect(manager.listAgents()).toHaveLength(1);
      expect(events.filter(e => e.transition === "parked")).toHaveLength(1);
    });
  });

  describe("subagents:waiting payload", () => {
    const expectPayload = (record: AgentRecord, event: AgentQuotaWaitEvent, transition: string) => {
      expect(quotaWaitEventPayload(record, event)).toEqual({
        id: record.id,
        type: "general-purpose",
        description: "d",
        transition,
        phase: event.wait.phase,
        nextCheckAt: expect.any(Number),
        deadlineAt: expect.any(Number),
        blocked: [expect.objectContaining({ modelId: "anthropic/claude-opus-4-6", window: "five_hour" })],
        persistence: "session",
      });
    };

    it("carries the wait for parked, updated and released", async () => {
      setQuotaExhaustionPolicy("wait-async");
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour" });
      vi.mocked(runAgent).mockResolvedValue(done());
      const seen: Array<[AgentRecord, AgentQuotaWaitEvent]> = [];
      manager = new AgentManager({ subscriptionUsage: usage, onQuotaWait: (r, e) => seen.push([r, e]) });

      const id = manager.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true, model: opus });
      await vi.advanceTimersByTimeAsync(60_000);
      usage.recover("anthropic");
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await manager.getRecord(id)?.promise;

      expect(seen.map(([, e]) => e.transition)).toEqual(["parked", "updated", "released"]);
      for (const [record, event] of seen) expectPayload(record, event, event.transition);
      expect(manager.getRecord(id)?.status).toBe("completed");
    });

    it("carries the wait for cancelled and timed-out", async () => {
      setQuotaExhaustionPolicy("wait-async");
      setQuotaWaitTimeoutMinutes(1);
      const usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour" });
      const seen: Array<[AgentRecord, AgentQuotaWaitEvent]> = [];
      manager = new AgentManager({ subscriptionUsage: usage, onQuotaWait: (r, e) => seen.push([r, e]) });

      const cancelled = manager.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true, model: opus });
      manager.abort(cancelled);
      const timedOut = manager.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true, model: opus });
      await vi.advanceTimersByTimeAsync(60_000);

      const terminal = seen.filter(([, e]) => e.transition !== "parked");
      expect(terminal.map(([r, e]) => [r.id, e.transition])).toEqual([[cancelled, "cancelled"], [timedOut, "timed-out"]]);
      for (const [record, event] of terminal) expectPayload(record, event, event.transition);
    });
  });

  describe("resume", () => {
    /** Spawn with a two-model chain while nothing is blocked, and settle it. */
    async function settledAgent(usage: ReturnType<typeof usageStub>, onQuotaWait?: (r: AgentRecord, e: AgentQuotaWaitEvent) => void) {
      const s = session(opus);
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated?.(s);
        return done(s);
      });
      vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" });
      manager = new AgentManager({ subscriptionUsage: usage, onQuotaWait });
      const id = manager.spawn(pi, ctx, "general-purpose", "first", {
        description: "d",
        isBackground: true,
        model: opus,
        fallbackModels: ["openai-codex/gpt-5.6-terra"],
      });
      await manager.getRecord(id)?.promise;
      return { id, s };
    }

    it("moves to an available fallback from the record's chain instead of failing", async () => {
      const usage = usageStub();
      const { id, s } = await settledAgent(usage);
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });

      const record = await manager!.resume(id, "more");

      expect(s.setModel).toHaveBeenCalledWith(terra);
      expect(resumeAgent).toHaveBeenCalledWith(s, "more", expect.anything());
      expect(record).toMatchObject({ status: "completed", result: "continued", quotaModelIndex: 1 });
      expect(record?.invocation?.modelId).toBe("openai-codex/gpt-5.6-terra");
    });

    it("parks a background resume on the whole chain and continues on whichever frees first", async () => {
      setQuotaExhaustionPolicy("wait-async");
      const usage = usageStub();
      const onQuotaWait = vi.fn();
      const { id, s } = await settledAgent(usage, onQuotaWait);
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_B });
      usage.exhaust("openai-codex", { window: "five_hour", resetAt: RESET_A });

      const resumed = await manager!.resume(id, "more", undefined, { isBackground: true });
      expect(resumed).toMatchObject({ status: "queued", quotaWait: { phase: "preflight" } });
      expect(onQuotaWait.mock.calls[0][1].dispatch.modelChain).toEqual([
        "anthropic/claude-opus-4-6",
        "openai-codex/gpt-5.6-terra",
      ]);

      usage.recover("openai-codex");
      await vi.advanceTimersByTimeAsync(RESET_A - NOW);
      await manager!.getRecord(id)?.promise;
      await manager!.getRecord(id)?.promise;

      expect(s.setModel).toHaveBeenCalledWith(terra);
      expect(manager!.getRecord(id)).toMatchObject({ status: "completed", result: "continued" });
    });

    it("throws the named-model message when it may not wait", async () => {
      const usage = usageStub();
      const { id } = await settledAgent(usage);
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });
      usage.exhaust("openai-codex", { window: "weekly", resetAt: RESET_B });

      await expect(manager!.resume(id, "more")).rejects.toThrow(
        `anthropic/claude-opus-4-6 (five_hour, resets ${new Date(RESET_A).toISOString()})`,
      );
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(manager!.getRecord(id)?.status).toBe("completed");
    });
  });

  describe("mid-run recovery turn budget", () => {
    it("carries the turns spent before a quota rebind into the continuation", async () => {
      const usage = usageStub();
      const first = session(opus);
      vi.mocked(runAgent)
        .mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
          options.onSessionCreated?.(first);
          for (let turn = 1; turn <= 3; turn++) options.onTurnEnd?.(turn);
          usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });
          return { ...done(first), failure: "429 rate limit exceeded" };
        })
        .mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
          options.onTurnEnd?.((options.priorTurns ?? 0) + 1);
          return done(session(terra));
        });
      const onTurnEnd = vi.fn();
      manager = new AgentManager({ subscriptionUsage: usage });

      const id = manager.spawn(pi, ctx, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        model: opus,
        fallbackModels: ["openai-codex/gpt-5.6-terra"],
        maxTurns: 5,
        onTurnEnd,
      });
      await manager.getRecord(id)?.promise;

      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(vi.mocked(runAgent).mock.calls[0][3].priorTurns).toBeUndefined();
      expect(vi.mocked(runAgent).mock.calls[1][3]).toMatchObject({ model: terra, priorTurns: 3, maxTurns: 5 });
      expect(onTurnEnd.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4]);
    });
  });
  /**
   * `spawn` admits from cached usage and fails open on a cold cache, so every
   * route has to warm first. Each case starts cold with the parent's provider
   * exhausted server-side: without the warm the child would start.
   */
  describe("admission on every dispatch route", () => {
    const BLOCKED = "all configured models are blocked";
    let usage: ReturnType<typeof usageStub>;

    beforeEach(() => {
      usage = usageStub();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A }, false);
      manager = new AgentManager({ subscriptionUsage: usage });
    });

    it("spawnAndWait (Agent tool foreground, workflow, nested foreground)", async () => {
      await expect(manager!.spawnAndWait(pi, ctx, "general-purpose", "p", { description: "d" })).rejects.toThrow(BLOCKED);

      expect(usage.get).toHaveBeenCalledWith(ctx, "anthropic", { signal: undefined });
      expect(manager!.listAgents()).toHaveLength(0);
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("workflow host agent()", async () => {
      const host = createWorkflowHost({ pi, ctx, manager: manager! });

      const result = await host.spawnAgent({ agentId: "wf-0", index: 0, prompt: "p", label: "l", agentType: "general-purpose" });

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(BLOCKED) });
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("resume warms the whole original chain and falls back along it", async () => {
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const s = session(opus);
        options.onSessionCreated?.(s);
        return done(s);
      });
      vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
      usage.recover("anthropic");
      const id = manager!.spawn(pi, ctx, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        model: opus,
        fallbackModels: ["openai-codex/gpt-5.6-terra"],
      });
      await manager!.getRecord(id)?.promise;
      // Exhausted while idle; the cache still says otherwise.
      usage.cache.clear();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A }, false);

      const record = await manager!.resume(id, "more");

      expect(usage.get).toHaveBeenCalledWith(ctx, "anthropic", { signal: undefined });
      expect(usage.get).toHaveBeenCalledWith(ctx, "openai-codex", { signal: undefined });
      expect(record?.session?.setModel).toHaveBeenCalledWith(terra);
      expect(record).toMatchObject({ status: "completed", result: "resumed", quotaModelIndex: 1 });
    });

    it("resume refuses, untouched, when its whole chain is exhausted", async () => {
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const s = session(opus);
        options.onSessionCreated?.(s);
        return done(s);
      });
      usage.recover("anthropic");
      const id = manager!.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true, model: opus });
      await manager!.getRecord(id)?.promise;
      usage.cache.clear();
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A }, false);

      await expect(manager!.resume(id, "more")).rejects.toThrow(BLOCKED);
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(manager!.getRecord(id)?.status).toBe("completed");
    });

    it("cross-extension RPC spawn", async () => {
      const listeners = new Map<string, (data: unknown) => void>();
      const events: EventBus = {
        on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
        emit: (event, data) => listeners.get(event)?.(data),
      };
      const reply = vi.fn();
      const live = manager!;
      registerRpcHandlers({
        events,
        pi,
        getCtx: () => ctx,
        manager: {
          spawn: (p, c, type, prompt, options) => live.spawn(p as any, c as any, type, prompt, options),
          warmQuota: (c, type, options) => live.warmQuota(c as any, type, options) ?? Promise.resolve(),
          awaitStartup: id => live.awaitStartup(id),
          abort: id => live.abort(id),
          getRecord: id => live.getRecord(id),
          consumeResult: () => false,
        },
      });
      events.on("subagents:rpc:spawn:reply:r1", reply);

      events.emit("subagents:rpc:spawn", { requestId: "r1", type: "general-purpose", prompt: "p", options: { description: "d" } });
      await vi.waitFor(() => expect(reply).toHaveBeenCalled());

      expect(reply).toHaveBeenCalledWith({ success: false, error: expect.stringContaining(BLOCKED) });
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("nested background Agent", async () => {
      const configCwd = mkdtempSync(join(tmpdir(), "quota-nested-"));
      try {
        const [agent] = createNestedSubagentTools({
          manager: manager!,
          pi,
          parentAgentId: "parent",
          depth: 1,
          maxSubagentDepth: 2,
          allowedSubagents: "all",
          configCwd,
        });

        const result = await agent.execute(
          "call-1",
          { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: true },
          undefined,
          undefined,
          ctx,
        );

        expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(BLOCKED) }] });
        expect(runAgent).not.toHaveBeenCalled();
      } finally {
        rmSync(configCwd, { recursive: true, force: true });
      }
    });

    it("scheduled job fire", async () => {
      const dir = mkdtempSync(join(tmpdir(), "quota-schedule-"));
      const scheduler = new SubagentScheduler();
      try {
        const store = new ScheduleStore(join(dir, "s.json"));
        const emit = vi.fn();
        scheduler.start({ events: { emit } } as any, ctx, manager!, store);
        const job = scheduler.addJob({
          name: "j", description: "d", schedule: "+1s", subagent_type: "general-purpose", prompt: "p",
        });

        await vi.advanceTimersByTimeAsync(2_000);

        expect(usage.get).toHaveBeenCalledWith(ctx, "anthropic", { signal: undefined });
        expect(store.get(job.id)?.lastStatus).toBe("error");
        expect(emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
          type: "error", error: expect.stringContaining(BLOCKED),
        }));
        expect(runAgent).not.toHaveBeenCalled();
      } finally {
        scheduler.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks instead, before a record starts, under wait-async", async () => {
      setQuotaExhaustionPolicy("wait-async");

      const id = await (async () => {
        await manager!.warmQuota(ctx, "general-purpose", {});
        return manager!.spawn(pi, ctx, "general-purpose", "p", { description: "d", isBackground: true });
      })();

      expect(manager!.getRecord(id)).toMatchObject({ status: "queued", quotaWait: { phase: "preflight" } });
      expect(runAgent).not.toHaveBeenCalled();
    });

    it("skips the read, and stays synchronous, when the chain is already cached", () => {
      usage.exhaust("anthropic", { window: "five_hour", resetAt: RESET_A });

      expect(manager!.warmQuota(ctx, "general-purpose", {})).toBeUndefined();
      expect(usage.get).not.toHaveBeenCalled();
    });
  });
});
