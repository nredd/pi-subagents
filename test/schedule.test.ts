/**
 * schedule.test.ts — SubagentScheduler engine.
 *
 * Tests:
 *   - Static format parsers (cron / relative / interval / detection)
 *   - Job lifecycle (add / update / remove / cleanup)
 *   - Fire path (interval, one-shot) with mocked AgentManager + fake timers
 *   - Past-timestamp rejection
 *   - One-shot auto-disable
 *   - Concurrency-bypass option flows through to manager.spawn
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

function makeMockManager() {
  const spawnFn = vi.fn(() => "agent-" + Math.random().toString(36).slice(2, 10));
  const manager: any = {
    spawn: spawnFn,
    warmQuota: vi.fn(async () => {}),
    waitForCompletion: vi.fn(async (id: string) => {
      await manager.awaitStartup(id);
      const record = manager.getRecord(id);
      if (record?.promise) await record.promise;
      return record;
    }),
    restoreQuotaWait: vi.fn((_pi, _ctx, dispatch) => dispatch.id),
    awaitStartup: vi.fn(async () => {}),
    getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
  };
  return manager;
}

function makeMockPi() {
  return {
    events: { emit: vi.fn() },
  } as any;
}

function makeMockCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-1" },
  } as any;
}

describe("SubagentScheduler — static format parsers", () => {
  it("parseRelativeTime accepts +Ns/Nm/Nh/Nd and rejects bare numbers", () => {
    const before = Date.now();
    const iso = SubagentScheduler.parseRelativeTime("+10s");
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(9_000);
    expect(t - before).toBeLessThanOrEqual(11_000);

    expect(SubagentScheduler.parseRelativeTime("+5m")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+1h")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+2d")).not.toBeNull();

    // Bare digits / wrong unit / no plus → null
    expect(SubagentScheduler.parseRelativeTime("10s")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+5x")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("hello")).toBeNull();
  });

  it("parseInterval converts unit-suffixed strings to milliseconds", () => {
    expect(SubagentScheduler.parseInterval("10s")).toBe(10_000);
    expect(SubagentScheduler.parseInterval("5m")).toBe(300_000);
    expect(SubagentScheduler.parseInterval("1h")).toBe(3_600_000);
    expect(SubagentScheduler.parseInterval("2d")).toBe(172_800_000);

    expect(SubagentScheduler.parseInterval("+5m")).toBeNull();   // relative isn't an interval
    expect(SubagentScheduler.parseInterval("5x")).toBeNull();
    expect(SubagentScheduler.parseInterval("five-minutes")).toBeNull();
  });

  it("validateCronExpression rejects non-6-field expressions", () => {
    expect(SubagentScheduler.validateCronExpression("* * * * *").valid).toBe(false);  // 5 fields
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * *").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("not-a-cron").valid).toBe(false);
  });

  it("detectSchedule tags type and normalizes input", () => {
    expect(SubagentScheduler.detectSchedule("+10m").type).toBe("once");
    expect(SubagentScheduler.detectSchedule("5m").type).toBe("interval");
    expect(SubagentScheduler.detectSchedule("5m").intervalMs).toBe(300_000);
    expect(SubagentScheduler.detectSchedule("0 0 9 * * 1").type).toBe("cron");

    const iso = "2099-01-01T00:00:00.000Z";
    const r = SubagentScheduler.detectSchedule(iso);
    expect(r.type).toBe("once");
    expect(r.normalized).toBe(iso);

    expect(() => SubagentScheduler.detectSchedule("garbage")).toThrow(/Invalid schedule/);
  });
});

describe("SubagentScheduler — lifecycle", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isActive() reports start/stop state", () => {
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it("addJob persists, arms, and emits added event", () => {
    const job = scheduler.addJob({
      name: "j1",
      description: "test",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "hi",
    });
    expect(job.scheduleType).toBe("interval");
    expect(scheduler.list()).toHaveLength(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "added" }));
  });

  it("addJob rejects duplicate names", () => {
    scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(() => scheduler.addJob({
      name: "j1", description: "y", schedule: "2h", subagent_type: "general-purpose", prompt: "p2",
    })).toThrow(/already exists/);
  });

  it("removeJob clears the job and emits removed", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "removed", jobId: job.id }));
  });

  it("updateJob({enabled: false}) unschedules but keeps the record", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(scheduler.list()[0].enabled).toBe(false);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  // Regression: getNextRun on a freshly-created interval used to return undefined
  // (the lastRun-based branch needs lastRun, which is undefined before first fire),
  // surfacing as "Next run: (unknown)" in the agent's create-response.
  it("getNextRun returns an approximate future time for a fresh interval (no lastRun yet)", () => {
    const before = Date.now();
    const job = scheduler.addJob({
      name: "fresh-interval", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    const t = new Date(next!).getTime();
    // Should be ~now + 1h, with a small tolerance for the time spent in the call
    expect(t - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(t - before).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  // Once a fire happens and `lastRun` is set, getNextRun should pivot to it.
  it("getNextRun uses lastRun when present for interval jobs", () => {
    const job = scheduler.addJob({
      name: "ran-once", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
    scheduler.updateJob(job.id, { lastRun });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBe(new Date(new Date(lastRun).getTime() + 3_600_000).toISOString());
  });

  it("rejects past one-shot timestamps upfront — no record created", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => scheduler.addJob({
      name: "past", description: "x", schedule: past, subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/in the past/);
    // No dead-on-arrival record left behind
    expect(scheduler.list()).toEqual([]);
  });

  // The safety net in scheduleJob's past-branch only fires on store reload —
  // a once-job persisted with a future ISO whose time has now passed (process
  // restart after the trigger window). detectSchedule rejects past timestamps
  // at create time, so this is the only remaining production path.
  it("disables a previously-enabled one-shot reloaded from disk past its time", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Direct store insert bypasses addJob's upfront validation, mimicking a
    // record that was valid when written but is now stale on reload.
    store.add({
      id: "reload-test",
      name: "reload",
      description: "reload",
      schedule: past,
      scheduleType: "once",
      subagent_type: "general-purpose",
      prompt: "x",
      enabled: true,
      createdAt: past,
      runCount: 0,
    });
    // Re-arm: stop drops timers, start re-reads store.list() and calls scheduleJob
    // for every enabled job → the past-branch fires for our seeded record.
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    const reloaded = scheduler.list().find(j => j.id === "reload-test");
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "reload-test", error: expect.stringMatching(/in the past/),
    }));
  });
});

describe("SubagentScheduler — fire path", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-fire-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    // Module-global: restore here, not at the end of a test body, so a failing
    // assertion can't leak strict dispatch into every test that follows.
    setFallbackSubagent(undefined);
    registerAgents(new Map());
    rmSync(tmp, { recursive: true, force: true });
  });

  it("interval jobs fire repeatedly via setInterval", async () => {
    scheduler.addJob({
      name: "every-10s", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });

    expect(manager.spawn).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("refuses at fire time when the job's agent type no longer resolves", async () => {
    // The registry is what production populates at activation; a job outliving
    // its agent must not silently run something else (#183).
    registerAgents(new Map());
    setFallbackSubagent(NO_FALLBACK);
    const job = scheduler.addJob({
      name: "gone", description: "vanished agent", schedule: "+1s",
      subagent_type: "deleted-since", prompt: "run",
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(manager.spawn).not.toHaveBeenCalled();
    const stored = store.get(job.id);
    expect(stored?.lastStatus).toBe("error");
    // Pin WHY it failed — "didn't spawn" alone would be satisfied by any
    // unrelated pre-spawn throw.
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:scheduled",
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("Unknown or disabled agent type"),
      }),
    );
  });

  it("one-shot fires once and auto-disables", async () => {
    const job = scheduler.addJob({
      name: "soon", description: "once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // The auto-disable update happens synchronously inside the timer callback
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);

    // Subsequent ticks shouldn't fire again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("suppresses interval refires while a quota wait is persisted and restores it", async () => {
    manager.waitForCompletion = vi.fn(() => new Promise(() => {}));
    const job = scheduler.addJob({
      name: "quota", description: "quota", schedule: "1s",
      subagent_type: "general-purpose", prompt: "wait",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const agentId = manager.spawn.mock.results[0].value;
    const wait = {
      phase: "preflight" as const,
      parkedAt: Date.now(),
      deadlineAt: Date.now() + 600_000,
      nextCheckAt: Date.now() + 60_000,
      unknownPollAttempt: 0,
      blocked: [{ modelId: "anthropic/claude-opus-4-6", window: "five_hour" }],
      persistence: "schedule" as const,
    };
    scheduler.handleQuotaWait(
      { id: agentId, scheduleId: job.id } as any,
      {
        transition: "parked",
        wait,
        dispatch: {
          version: 1,
          id: agentId,
          type: "general-purpose",
          prompt: "wait",
          modelChain: ["anthropic/claude-opus-4-6"],
          wait,
          options: { description: "quota", isBackground: true, scheduleId: job.id },
        },
      },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(store.get(job.id)).toMatchObject({
      lastStatus: "running",
      pendingAgentId: agentId,
      quotaModelChain: ["anthropic/claude-opus-4-6"],
      quotaWait: wait,
    });

    scheduler.stop();
    const restoredManager = makeMockManager();
    restoredManager.spawn.mockReturnValue(agentId);
    restoredManager.waitForCompletion = vi.fn(() => new Promise(() => {}));
    scheduler = new SubagentScheduler();
    scheduler.start(pi, ctx, restoredManager, store);
    await vi.advanceTimersByTimeAsync(0);

    expect(restoredManager.warmQuota).toHaveBeenCalledWith(ctx, "general-purpose", {
      quotaModelChain: ["anthropic/claude-opus-4-6"],
    });
    expect(restoredManager.spawn).not.toHaveBeenCalled();
    expect(restoredManager.restoreQuotaWait).toHaveBeenCalledWith(
      pi,
      ctx,
      expect.objectContaining({
        id: agentId,
        modelChain: ["anthropic/claude-opus-4-6"],
        wait,
        options: expect.objectContaining({ scheduleId: job.id }),
      }),
    );
  });

  for (const transition of ["released", "cancelled", "timed-out"] as const) {
    it(`clears the persisted wait on a ${transition} transition, keeping the run's id`, async () => {
      manager.waitForCompletion = vi.fn(() => new Promise(() => {}));
      const job = scheduler.addJob({
        name: "quota", description: "quota", schedule: "1h",
        subagent_type: "general-purpose", prompt: "wait",
      });
      const wait = {
        phase: "preflight" as const,
        parkedAt: Date.now(),
        deadlineAt: Date.now() + 600_000,
        nextCheckAt: Date.now() + 60_000,
        unknownPollAttempt: 0,
        blocked: [{ modelId: "anthropic/claude-opus-4-6", window: "five_hour" }],
        persistence: "schedule" as const,
      };
      const record = { id: "agent-q", scheduleId: job.id } as any;
      const dispatch = {
        version: 1 as const,
        id: "agent-q",
        type: "general-purpose",
        prompt: "wait",
        modelChain: ["anthropic/claude-opus-4-6"],
        wait,
        options: { description: "quota", isBackground: true, scheduleId: job.id },
      };
      scheduler.handleQuotaWait(record, { transition: "parked", wait, dispatch });
      expect(store.get(job.id)).toMatchObject({ quotaWait: wait, quotaDispatch: dispatch });

      scheduler.handleQuotaWait(record, { transition, wait, dispatch });

      const stored = store.get(job.id);
      expect(stored?.quotaWait).toBeUndefined();
      expect(stored?.quotaDispatch).toBeUndefined();
      expect(stored?.pendingAgentId).toBe("agent-q");
    });
  }

  it("keeps a one-shot enabled while its dispatch waits for quota", async () => {
    const wait = {
      phase: "preflight" as const,
      parkedAt: Date.now(),
      deadlineAt: Date.now() + 600_000,
      nextCheckAt: Date.now() + 60_000,
      unknownPollAttempt: 0,
      blocked: [{ modelId: "anthropic/claude-opus-4-6", window: "five_hour" }],
      persistence: "schedule" as const,
    };
    manager.getRecord.mockReturnValue({ quotaWait: wait, promise: new Promise(() => {}) });
    const job = scheduler.addJob({
      name: "quota-once", description: "quota once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "wait",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.get(job.id)?.enabled).toBe(true);
  });

  it("fire passes bypassQueue: true to manager.spawn", async () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.bypassQueue).toBe(true);
    expect(optsArg.isBackground).toBe(true);
  });

  it("fire passes the persisted fallback chain to the manager", async () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
      fallbackModels: ["openai-codex/gpt-5.6-terra"],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.spawn.mock.calls[0][4].fallbackModels).toEqual(["openai-codex/gpt-5.6-terra"]);
  });

  it("fire passes the job's configuration as the invocation snapshot", async () => {
    // A scheduled run has no tool call to build one, so without this the
    // conversation viewer can say nothing about how the job was configured.
    // The model is left out on purpose: agent-manager fills in the effective one
    // once the session reports it.
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
      thinking: "high", max_turns: 12, isolated: true,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.invocation).toEqual({
      thinking: "high",
      maxTurns: 12,
      isolated: true,
      runInBackground: true,
      isolation: undefined,
    });
  });

  it("fire normalizes an unlimited turn budget out of the snapshot", async () => {
    // 0 means unlimited; "max turns: 0" would read as a limit of none.
    scheduler.addJob({
      name: "unlimited", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x", max_turns: 0,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.spawn.mock.calls[0][4].invocation.maxTurns).toBeUndefined();
  });

  it("disabled jobs do not fire", async () => {
    const job = scheduler.addJob({
      name: "off", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    scheduler.updateJob(job.id, { enabled: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(0);
  });

  it("emits fired event with agentId on successful spawn", async () => {
    scheduler.addJob({
      name: "fire-once", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "fired", name: "fire-once", agentId: expect.stringMatching(/^agent-/),
    }));
  });

  it("records lastStatus error and emits when manager.spawn throws", async () => {
    manager.spawn.mockImplementationOnce(() => { throw new Error("no slots"); });
    const job = scheduler.addJob({
      name: "boom", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    await vi.advanceTimersByTimeAsync(2_000);

    // Update is synchronous in the spawn-throw path
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: "no slots",
    }));
  });

  it("records lastStatus error when the agent fails to start after spawn returns", async () => {
    // Under isolation: "worktree" the agent is not running when spawn() returns
    // — the repo copy is awaited. A failure there must be recorded as a failed
    // run, not as the success the missing run promise would otherwise imply.
    manager.awaitStartup.mockRejectedValueOnce(new Error('Cannot run with isolation: "worktree"'));
    const job = scheduler.addJob({
      name: "no-worktree", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x", isolation: "worktree",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
  });

  // ── Status reflection from record.status (regression for bug #1) ────
  // The real AgentManager's promise *always* resolves (its .catch returns ""),
  // so the schedule's success/error must be inferred from `record.status`,
  // not from promise resolution. These two tests model that contract.
  describe("infers success vs error from record.status, not promise resolution", () => {
    type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

    function installFaithfulMock(): Map<string, FakeRecord> {
      const records = new Map<string, FakeRecord>();
      manager.spawn.mockImplementation(() => {
        const id = "agent-" + Math.random().toString(36).slice(2, 10);
        let resolve!: () => void;
        const promise = new Promise<string>(r => { resolve = () => r(""); });
        records.set(id, { status: "running", promise, resolve });
        return id;
      });
      manager.getRecord.mockImplementation((id: string) => records.get(id));
      return records;
    }

    it("records lastStatus 'error' when the agent terminates with status='error'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "fail-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(manager.spawn).toHaveBeenCalledTimes(1);

      // The agent ran and ended in error — same shape the real AgentManager produces.
      const r = [...records.values()][0];
      r.status = "error";
      r.resolve();

      // Flush microtasks so .then(finalize) runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    });

    it("records lastStatus 'success' when the agent terminates with status='completed'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "ok-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      await vi.advanceTimersByTimeAsync(2_000);
      const r = [...records.values()][0];
      r.status = "completed";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("treats aborted and stopped as errors (terminal failure states)", async () => {
      const records = installFaithfulMock();
      const a = scheduler.addJob({
        name: "abort-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });
      const b = scheduler.addJob({
        name: "stop-job", description: "x", schedule: "+2s",
        subagent_type: "general-purpose", prompt: "x",
      });

      await vi.advanceTimersByTimeAsync(3_000);
      const recs = [...records.values()];
      recs[0].status = "aborted";
      recs[0].resolve();
      recs[1].status = "stopped";
      recs[1].resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === a.id)?.lastStatus).toBe("error");
      expect(scheduler.list().find(j => j.id === b.id)?.lastStatus).toBe("error");
    });
  });
});

describe("SubagentScheduler — stopped state", () => {
  it("throws on mutation when not started", async () => {
    const scheduler = new SubagentScheduler();
    expect(() => scheduler.addJob({
      name: "x", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/not started/);
  });

  it("list() returns empty array when not started", async () => {
    const scheduler = new SubagentScheduler();
    expect(scheduler.list()).toEqual([]);
  });
});
