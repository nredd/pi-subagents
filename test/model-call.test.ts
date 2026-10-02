import { describe, expect, it } from "vitest";
import { forwardModelCall } from "../src/agent-runner.js";
import {
  applyModelCallEvent,
  describeModelCall,
  formatClock,
  type ModelCallEvent,
  type ModelCallState,
  STALL_MS,
} from "../src/model-call.js";

const T0 = 1_000_000;

function run(events: [ModelCallEvent, number][]): ModelCallState | undefined {
  let state: ModelCallState | undefined;
  for (const [event, at] of events) state = applyModelCallEvent(state, event, at);
  return state;
}

describe("formatClock", () => {
  it.each([
    [0, "0s"],
    [41_900, "41s"],
    [161_000, "2m41s"],
    [3_900_000, "1h05m"],
    [-5, "0s"],
  ])("%d ms -> %s", (ms, expected) => {
    expect(formatClock(ms)).toBe(expected);
  });
});

describe("describeModelCall", () => {
  it("is empty with no call in flight", () => {
    expect(describeModelCall(undefined, T0)).toBeUndefined();
    expect(describeModelCall(run([[{ type: "start" }, T0], [{ type: "end" }, T0 + 5]]), T0 + 10)).toBeUndefined();
  });

  it("counts time spent thinking since the call started", () => {
    const state = run([[{ type: "start" }, T0], [{ type: "delta", kind: "thinking", chars: 40 }, T0 + 160_000]]);
    expect(describeModelCall(state, T0 + 161_000)).toBe("thinking · 2m41s");
  });

  it("reports tokens once it is writing, estimated from characters", () => {
    const state = run([
      [{ type: "start" }, T0],
      [{ type: "delta", kind: "thinking", chars: 100 }, T0 + 1_000],
      [{ type: "delta", kind: "writing", chars: 6_400 }, T0 + 2_000],
      [{ type: "delta", kind: "writing", chars: 6_400 }, T0 + 3_000],
    ]);
    expect(describeModelCall(state, T0 + 3_500)).toBe("writing · 3.2k tok");
  });

  it("does not flip back to thinking when a late thinking block arrives", () => {
    const state = run([
      [{ type: "start" }, T0],
      [{ type: "delta", kind: "writing", chars: 40 }, T0 + 1],
      [{ type: "delta", kind: "thinking", chars: 40 }, T0 + 2],
    ]);
    expect(describeModelCall(state, T0 + 3)).toMatch(/^writing/);
  });

  it("says stalled? after two minutes without any stream event, however it started", () => {
    const thinking = run([[{ type: "start" }, T0]]);
    expect(describeModelCall(thinking, T0 + STALL_MS - 1)).toMatch(/^thinking/);
    expect(describeModelCall(thinking, T0 + STALL_MS + 41_000)).toBe("stalled? · 2m41s");

    const writing = run([[{ type: "start" }, T0], [{ type: "delta", kind: "writing", chars: 10 }, T0 + 1_000]]);
    expect(describeModelCall(writing, T0 + 1_000 + STALL_MS)).toBe("stalled? · 2m00s");
  });

  it("a beat (a block boundary) is proof of life", () => {
    const state = run([[{ type: "start" }, T0], [{ type: "beat" }, T0 + 100_000]]);
    expect(describeModelCall(state, T0 + 100_000 + STALL_MS - 1)).toMatch(/^thinking/);
  });

  it("ignores a beat or end with nothing in flight", () => {
    expect(applyModelCallEvent(undefined, { type: "beat" }, T0)).toBeUndefined();
    expect(applyModelCallEvent(undefined, { type: "end" }, T0)).toBeUndefined();
  });
});

describe("forwardModelCall", () => {
  function collect(events: any[]): ModelCallEvent[] {
    const out: ModelCallEvent[] = [];
    for (const e of events) forwardModelCall(e, (m) => out.push(m));
    return out;
  }

  it("maps assistant stream events and ignores other roles", () => {
    const out = collect([
      { type: "message_start", message: { role: "user" } },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "abc" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } },
      { type: "message_update", assistantMessageEvent: { type: "text_end" } },
      { type: "message_end", message: { role: "toolResult" } },
      { type: "message_end", message: { role: "assistant" } },
      { type: "tool_execution_start", toolName: "read" },
      { type: "turn_end" },
    ]);
    expect(out).toEqual([
      { type: "start" },
      { type: "delta", kind: "thinking", chars: 3 },
      { type: "delta", kind: "writing", chars: 5 },
      { type: "delta", kind: "writing", chars: 2 },
      { type: "beat" },
      { type: "end" },
      { type: "end" },
    ]);
  });
});
