/** Public scheduler/outbox clock seams, independent of Vitest's global fake timers. */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { realClock } from "../src/clock.js";
import { CompletionOutbox } from "../src/completion-outbox.js";
import { ADMIT_CHANNEL, type AdmissionEvents } from "../src/quota-admission.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { FakeClock } from "./helpers/fake-clock.js";

const cleanup: (() => void)[] = [];
afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

function schedulerFixture(events: AdmissionEvents = { emit: vi.fn(), on: () => () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), "subagents-clock-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = new FakeClock();
  const scheduler = new SubagentScheduler({ clock });
  cleanup.push(() => scheduler.stop());
  const spawn = vi.fn(() => "child");
  const manager = {
    spawn,
    awaitStartup: async () => {},
    getRecord: () => ({ status: "completed", promise: Promise.resolve("done") }),
  } as unknown as AgentManager;
  const store = new ScheduleStore(join(dir, "schedules.json"));
  scheduler.start({ events } as unknown as ExtensionAPI, { model: { provider: "faux", id: "model" } } as ExtensionContext, manager, store);
  return { scheduler, clock, spawn, store };
}

const input = { name: "clock-job", description: "clock job", subagent_type: "general-purpose", prompt: "run" };

it("preserves native timer references and clears the original handles", () => {
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const interval = vi.spyOn(globalThis, "setInterval");
  const clearOnce = vi.spyOn(globalThis, "clearTimeout");
  const clearRepeat = vi.spyOn(globalThis, "clearInterval");
  const once = realClock.setTimeout(() => {}, 3_600_000);
  const repeat = realClock.setInterval(() => {}, 3_600_000);
  cleanup.push(() => { once.cancel(); repeat.cancel(); });
  const nativeOnce = timeout.mock.results[0].value;
  const nativeRepeat = interval.mock.results[0].value;
  expect(nativeOnce.hasRef()).toBe(true);
  expect(nativeRepeat.hasRef()).toBe(true);
  nativeOnce.unref();
  nativeRepeat.unref();
  expect(nativeOnce.hasRef()).toBe(false);
  expect(nativeRepeat.hasRef()).toBe(false);
  once.cancel();
  repeat.cancel();
  expect(clearOnce).toHaveBeenCalledWith(nativeOnce);
  expect(clearRepeat).toHaveBeenCalledWith(nativeRepeat);
});

it("releases the idle outbox hold only after 200 fake milliseconds", () => {
  const clock = new FakeClock();
  const send = vi.fn();
  const outbox = new CompletionOutbox(send, () => false, clock);
  cleanup.push(() => outbox.dispose());
  outbox.add({ ids: ["child"], build: () => ({
    content: "child done",
    details: { id: "child", description: "child", status: "completed", toolUses: 0, turnCount: 1, totalTokens: 0, durationMs: 0, resultPreview: "done" },
  }) });
  clock.advance(199);
  expect(send).not.toHaveBeenCalled();
  clock.advance(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].content).toBe("child done");
  expect(clock.pending).toBe(0);
  outbox.add({ ids: ["other"], build: () => { throw new Error("disposed items must not build"); } });
  outbox.dispose();
  expect(clock.pending).toBe(0);
  clock.advance(200);
  expect(send).toHaveBeenCalledTimes(1);
});

describe("injected scheduler clock", () => {
  it("accepts fake-future ISO times and rejects fake-past times", () => {
    const { scheduler, clock, spawn } = schedulerFixture();
    expect(() => scheduler.addJob({ ...input, schedule: "2019-12-31T23:59:59.000Z" })).toThrow(/in the past/);
    scheduler.addJob({ ...input, schedule: "2020-01-01T00:00:01.000Z" });
    clock.advance(999);
    expect(spawn).not.toHaveBeenCalled();
    clock.advance(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("fires intervals repeatedly and cancels them on removal or stop", () => {
    const schedule = "1s";
    const { scheduler, clock, spawn } = schedulerFixture();
    const job = scheduler.addJob({ ...input, schedule });
    expect(scheduler.getNextRun(job.id)).toBe("2020-01-01T00:00:01.000Z");
    clock.advance(999);
    expect(spawn).not.toHaveBeenCalled();
    clock.advance(2_001);
    expect(spawn).toHaveBeenCalledTimes(3);
    scheduler.removeJob(job.id);
    expect(clock.pending).toBe(0);
    clock.advance(1_000);
    expect(spawn).toHaveBeenCalledTimes(3);
    scheduler.addJob({ ...input, schedule });
    scheduler.stop();
    expect(clock.pending).toBe(0);
    clock.advance(1_000);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("re-parks a refused quota job and re-admits it using the same fake time", async () => {
    const emitter = new EventEmitter();
    const events: AdmissionEvents = {
      emit: (channel, data) => { emitter.emit(channel, data); },
      on: (channel, handler) => {
        emitter.on(channel, handler);
        return () => { emitter.off(channel, handler); };
      },
    };
    const { scheduler, clock, spawn, store } = schedulerFixture(events);
    let blocked = true;
    emitter.on(ADMIT_CHANNEL, ({ requestId }: { requestId: string }) => {
      events.emit(`${ADMIT_CHANNEL}:reply:${requestId}`, {
        success: true, data: { ok: !blocked, resetAt: Date.parse("2020-01-01T00:00:05.000Z") },
      });
    });
    const job = scheduler.addJob({ ...input, schedule: "+1s", quotaParked: true });
    clock.advance(1_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawn).not.toHaveBeenCalled();
    expect(store.get(job.id)?.enabled).toBe(true);
    expect(store.get(job.id)?.schedule).toBe("2020-01-01T00:01:05.000Z");
    blocked = false;
    clock.advance(63_999);
    expect(spawn).not.toHaveBeenCalled();
    clock.advance(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(store.get(job.id)?.lastStatus).toBe("success");
    expect(store.get(job.id)?.lastRun).toBe("2020-01-01T00:01:05.000Z");
  });

  it("cancels an injected one-shot when disabled", () => {
    const { scheduler, clock, spawn } = schedulerFixture();
    const job = scheduler.addJob({ ...input, schedule: "+1s" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(clock.pending).toBe(0);
    clock.advance(2_000);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fires a relative one-shot only at its fake deadline, once", async () => {
    const { scheduler, clock, spawn, store } = schedulerFixture();
    const job = scheduler.addJob({ ...input, schedule: "+1s" });
    expect(job.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(job.schedule).toBe("2020-01-01T00:00:01.000Z");
    clock.advance(999);
    expect(spawn).not.toHaveBeenCalled();
    clock.advance(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(store.get(job.id)?.enabled).toBe(false);
    // Flush the scheduler's promise finalizer without advancing wall time.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.get(job.id)?.lastRun).toBe("2020-01-01T00:00:01.000Z");
    expect(store.get(job.id)?.lastStatus).toBe("success");
    clock.advance(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
