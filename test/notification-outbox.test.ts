import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeNotice, NotificationOutbox, type OutboxMessage, type OutboxNotice } from "../src/notification-outbox.js";
import type { NotificationDetails } from "../src/types.js";

function notice(id: string, opts: { consumed?: () => boolean; footer?: string } = {}): OutboxNotice {
  return {
    id,
    consumed: opts.consumed ?? (() => false),
    text: (max) => `<task-notification id=${id} max=${max}/>`,
    details: (max): NotificationDetails => ({
      id,
      description: `agent ${id}`,
      status: "completed",
      toolUses: 1,
      turnCount: 1,
      totalTokens: max,
      durationMs: 1,
      resultPreview: "ok",
    }),
    footer: opts.footer,
  };
}

describe("composeNotice", () => {
  it("returns nothing for an empty queue", () => {
    expect(composeNotice([])).toBeUndefined();
  });

  it("sends a lone notice with the full preview budget and its footer", () => {
    const message = composeNotice([notice("a", { footer: "\nFull transcript available at: /t/a.output" })])!;
    expect(message.content).toBe("<task-notification id=a max=500/>\nFull transcript available at: /t/a.output");
    expect(message.details.others).toBeUndefined();
  });

  it("coalesces several notices into one message with the rest in details.others", () => {
    const message = composeNotice([notice("a"), notice("b"), notice("c")])!;
    expect(message.content).toContain("Background agent group completed: 3 agent(s) finished");
    for (const id of ["a", "b", "c"]) expect(message.content).toContain(`id=${id} max=300`);
    expect(message.details.id).toBe("a");
    expect(message.details.others?.map(o => o.id)).toEqual(["b", "c"]);
  });
});

describe("NotificationOutbox", () => {
  let idle: boolean;
  let delivered: OutboxMessage[];
  let outbox: NotificationOutbox;

  beforeEach(() => {
    vi.useFakeTimers();
    idle = true;
    delivered = [];
    outbox = new NotificationOutbox({ isIdle: () => idle, deliver: (m) => delivered.push(m), holdMs: 200 });
  });
  afterEach(() => {
    outbox.clear();
    vi.useRealTimers();
  });

  it("delivers when the parent is idle, after the coalescing window", () => {
    outbox.enqueue(notice("a"));
    expect(delivered).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(delivered).toHaveLength(1);
    expect(outbox.size).toBe(0);
  });

  it("coalesces notices that finish inside the window into one message", () => {
    outbox.enqueue(notice("a"));
    vi.advanceTimersByTime(100);
    outbox.enqueue(notice("b"));
    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].details.others?.map(o => o.id)).toEqual(["b"]);
  });

  it("holds while the parent is busy and flushes everything, once, on agent_end", () => {
    idle = false;
    outbox.enqueue(notice("a"));
    vi.advanceTimersByTime(200);
    outbox.enqueue(notice("b"));
    vi.advanceTimersByTime(5_000);
    expect(delivered).toHaveLength(0);
    expect(outbox.size).toBe(2);

    outbox.flush(true);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toContain("2 agent(s) finished");
    outbox.flush(true);
    expect(delivered).toHaveLength(1);
  });

  it("drops a notice whose result the parent fetched before delivery", () => {
    idle = false;
    let read = false;
    outbox.enqueue(notice("a", { consumed: () => read }));
    outbox.enqueue(notice("b"));
    read = true;
    outbox.flush(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].details.id).toBe("b");
    expect(delivered[0].details.others).toBeUndefined();
  });

  it("sends nothing at all when every pending notice was read", () => {
    idle = false;
    outbox.enqueue(notice("a", { consumed: () => true }));
    outbox.flush(true);
    expect(delivered).toHaveLength(0);
    expect(outbox.size).toBe(0);
  });

  it("drop() removes a pending notice", () => {
    outbox.enqueue(notice("a"));
    outbox.drop("a");
    vi.advanceTimersByTime(200);
    expect(delivered).toHaveLength(0);
  });

  it("replaces an earlier notice with the same id (a resumed agent finishing again)", () => {
    idle = false;
    outbox.enqueue(notice("a"));
    outbox.enqueue(notice("a"));
    expect(outbox.size).toBe(1);
  });

  it("survives a delivery that throws on a stale session", () => {
    const failing = new NotificationOutbox({ isIdle: () => true, deliver: () => { throw new Error("stale"); } });
    failing.enqueue(notice("a"));
    expect(() => failing.flush(true)).not.toThrow();
    failing.clear();
  });
});
