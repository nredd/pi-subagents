/**
 * quota-admission.test.ts — router admission on the Agent tool and on
 * quota-parked scheduled jobs.
 *
 * The router is faked on a real EventEmitter with the reply envelope
 * pi-subscription-router uses, so the channel names and reply shape are pinned
 * here and not only in the router's repo.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(() => new Promise(() => {})) };
});

import subagentsExtension from "../src/index.js";
import { ADMIT_CHANNEL, checkAdmission, PARKED_RESUME_DELAY_MS, QUOTA_RESTART_GRACE_MS } from "../src/quota-admission.js";
import { SubagentScheduler } from "../src/schedule.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

type Verdict = { ok: boolean; resetAt?: number; wait?: boolean } | "error" | "silent" | "garbage";

/** `pi.events` backed by an EventEmitter, with a fake router answering admission. */
function routerBus(verdict: (model: string) => Verdict) {
  const emitter = new EventEmitter();
  const asked: string[] = [];
  const events = {
    emit: (channel: string, data: unknown) => emitter.emit(channel, data),
    on: (channel: string, handler: (data: unknown) => void) => {
      emitter.on(channel, handler);
      return () => emitter.off(channel, handler);
    },
  };
  emitter.on(ADMIT_CHANNEL, async (raw: { requestId: string; model: string }) => {
    asked.push(raw.model);
    const answer = verdict(raw.model);
    if (answer === "silent") return;
    await Promise.resolve();
    const reply = answer === "error"
      ? { success: false, error: "boom" }
      : answer === "garbage" ? "nonsense" : { success: true, data: answer };
    emitter.emit(`${ADMIT_CHANNEL}:reply:${raw.requestId}`, reply);
  });
  return { events, asked };
}

const MODEL = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet" };

describe("checkAdmission", () => {
  it("returns the block and its reset when the router refuses", async () => {
    const { events, asked } = routerBus(() => ({ ok: false, resetAt: 1234 }));
    expect(await checkAdmission(events, "anthropic/x")).toEqual({ model: "anthropic/x", resetAt: 1234 });
    expect(asked).toEqual(["anthropic/x"]);
  });

  it("carries the router's wait verdict and ignores a non-boolean one", async () => {
    const { events } = routerBus(() => ({ ok: false, resetAt: 1, wait: false }));
    expect(await checkAdmission(events, "anthropic/x")).toEqual({ model: "anthropic/x", resetAt: 1, wait: false });
    const bad = routerBus(() => ({ ok: false, resetAt: 1, wait: "yes" as never }));
    expect(await checkAdmission(bad.events, "anthropic/x")).toEqual({ model: "anthropic/x", resetAt: 1 });
  });

  it("admits on ok, router errors, malformed replies, and silence", async () => {
    for (const answer of [{ ok: true }, "error", "garbage", "silent"] as const) {
      const { events } = routerBus(() => answer);
      expect(await checkAdmission(events, "anthropic/x", 20), String(answer)).toBeUndefined();
    }
  });

  it("drops a non-numeric reset rather than trusting it", async () => {
    const { events } = routerBus(() => ({ ok: false, resetAt: "soon" as never }));
    expect(await checkAdmission(events, "anthropic/x")).toEqual({ model: "anthropic/x", resetAt: undefined });
  });
});

describe("Agent tool admission", () => {
  const SESSION_ID = "quota-admission-session";

  async function boot(verdict: (model: string) => Verdict) {
    const hermetic = hermeticDir();
    const { pi, tools, lifecycle } = makePi();
    const bus = routerBus(verdict);
    pi.events = bus.events;
    subagentsExtension(pi);
    const c = ctx({
      model: MODEL,
      sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
    });
    await lifecycle.get("session_start")?.({}, c);
    const run = (params: Record<string, unknown>) =>
      tools.get("Agent").execute("tc", { prompt: "go", description: "sweep", ...params }, undefined, undefined, c);
    const jobs = () => new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID)).list();
    const done = async () => {
      await lifecycle.get("session_shutdown")?.();
      hermetic.restore();
    };
    return { run, jobs, done, asked: bus.asked };
  }

  it("parks a blocked background dispatch as a quota one-shot at the reset", async () => {
    const resetAt = Date.now() + 3_600_000;
    const { run, jobs, done, asked } = await boot(() => ({ ok: false, resetAt }));
    try {
      const reply = textOf(await run({ subagent_type: "general-purpose", run_in_background: true }));
      expect(asked).toEqual(["anthropic/claude-sonnet-5-5"]);
      expect(reply).toContain("is exhausted");
      expect(reply).toContain("Queued");
      const [job] = jobs();
      expect(job).toMatchObject({
        scheduleType: "once",
        schedule: new Date(resetAt + QUOTA_RESTART_GRACE_MS).toISOString(),
        model: "anthropic/claude-sonnet-5-5",
        prompt: "go",
        quotaParked: true,
        enabled: true,
      });
    } finally {
      await done();
    }
  });

  it("fails a blocked foreground dispatch with the reset instead of parking", async () => {
    const resetAt = Date.now() + 3_600_000;
    const { run, jobs, done } = await boot(() => ({ ok: false, resetAt }));
    try {
      await expect(run({ subagent_type: "general-purpose", run_in_background: false })).rejects.toThrow(
        new Date(resetAt).toISOString(),
      );
      expect(jobs()).toEqual([]);
    } finally {
      await done();
    }
  });

  it("fails a blocked background dispatch when the router's policy says not to wait", async () => {
    const resetAt = Date.now() + 3_600_000;
    const { run, jobs, done } = await boot(() => ({ ok: false, resetAt, wait: false }));
    try {
      await expect(run({ subagent_type: "general-purpose", run_in_background: true })).rejects.toThrow(
        new Date(resetAt).toISOString(),
      );
      expect(jobs()).toEqual([]);
    } finally {
      await done();
    }
  });

  it("fails a blocked background dispatch whose reset is unknown", async () => {
    const { run, jobs, done } = await boot(() => ({ ok: false }));
    try {
      await expect(run({ subagent_type: "general-purpose", run_in_background: true })).rejects.toThrow(/unknown time/);
      expect(jobs()).toEqual([]);
    } finally {
      await done();
    }
  });

  it("starts an admitted dispatch normally", async () => {
    const { run, jobs, done } = await boot(() => ({ ok: true }));
    try {
      const reply = textOf(await run({ subagent_type: "general-purpose", run_in_background: true }));
      expect(reply).toContain("Agent ID:");
      expect(jobs()).toEqual([]);
    } finally {
      await done();
    }
  });
});

describe("SubagentScheduler — quota-parked jobs", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;

  function start(verdict: (model: string) => Verdict) {
    const bus = routerBus(verdict);
    const pi = { events: bus.events } as any;
    const c = {
      cwd: "/tmp",
      model: MODEL,
      modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
      sessionManager: { getSessionId: () => "sess-1" },
    } as any;
    scheduler.start(pi, c, manager, store);
    return bus;
  }

  function park(offsetMs = 1_000) {
    return scheduler.addJob({
      name: "parked", description: "parked", schedule: new Date(Date.now() + offsetMs).toISOString(),
      subagent_type: "general-purpose", prompt: "go", quotaParked: true,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-quota-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = {
      spawn: vi.fn(() => "agent-1"),
      awaitStartup: vi.fn(async () => {}),
      getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
    };
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts once the router admits it", async () => {
    const bus = start(() => ({ ok: true }));
    const job = park();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bus.asked).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  it("re-parks at the new reset while the model is still blocked, then starts", async () => {
    let resetAt: number | undefined = Date.now() + 10 * 60_000;
    start(() => (resetAt === undefined ? { ok: true } : { ok: false, resetAt }));
    const job = park();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      enabled: true,
      schedule: new Date(resetAt + QUOTA_RESTART_GRACE_MS).toISOString(),
    });

    resetAt = undefined;
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("starts instead of re-parking when the router's policy now says fail", async () => {
    start(() => ({ ok: false, resetAt: Date.now() + 10 * 60_000, wait: false }));
    const job = park();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  it("starts anyway when the router is gone, since admission fails open", async () => {
    start(() => "silent");
    park();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("re-admits a parked job whose reset passed while pi was closed", async () => {
    // Persisted by a previous process whose timer never fired.
    store.add({
      id: "parked-while-closed", name: "parked", description: "parked", scheduleType: "once",
      schedule: new Date(Date.now() - 60_000).toISOString(), subagent_type: "general-purpose",
      prompt: "go", enabled: true, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      runCount: 0, quotaParked: true,
    } as any);
    const bus = start(() => ({ ok: true }));
    expect(store.get("parked-while-closed")?.lastStatus).not.toBe("error");
    // Not at once: the router warms its usage cache on session_start first.
    await vi.advanceTimersByTimeAsync(PARKED_RESUME_DELAY_MS - 1);
    expect(manager.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bus.asked).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("still errors an ordinary past one-shot on start", () => {
    store.add({
      id: "past", name: "past", description: "past", scheduleType: "once",
      schedule: new Date(Date.now() - 60_000).toISOString(), subagent_type: "general-purpose",
      prompt: "go", enabled: true, createdAt: new Date().toISOString(), runCount: 0,
    } as any);
    start(() => ({ ok: true }));
    expect(store.get("past")).toMatchObject({ enabled: false, lastStatus: "error" });
  });

  it("leaves ordinary jobs on the synchronous upstream path", () => {
    const bus = start(() => ({ ok: false, resetAt: Date.now() + 60_000 }));
    scheduler.addJob({
      name: "plain", description: "plain", schedule: "+1s", subagent_type: "general-purpose", prompt: "go",
    });
    vi.advanceTimersByTime(2_000);
    expect(bus.asked).toEqual([]);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });
});
