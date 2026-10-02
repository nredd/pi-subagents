import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCallState } from "../src/model-call.js";
import type { AgentRecord } from "../src/types.js";
import {
  AgentCallView,
  AgentResultView,
  type AgentRowLive,
  agentRowSummary,
  isRowLive,
  keepRowTicking,
} from "../src/ui/agent-row.js";
import type { AgentActivity, AgentDetails } from "../src/ui/agent-widget.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const NOW = 10_000_000;

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "Plan",
    description: "plan the thing",
    status: "running",
    toolUses: 0,
    startedAt: NOW - 12_000,
    lifetimeUsage: { input: 3_200, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function makeDetails(over: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "Plan",
    description: "plan the thing",
    subagentType: "Plan",
    toolUses: 0,
    tokens: "",
    durationMs: 0,
    status: "background",
    agentId: "a1",
    modelName: "opus 4.6",
    tags: ["thinking: high"],
    ...over,
  };
}

function live(record: AgentRecord | undefined, activity?: AgentActivity, showCost = false): AgentRowLive {
  return { getRecord: () => record, getActivity: () => activity, showCost: () => showCost };
}

function activityWith(modelCall?: ModelCallState): AgentActivity {
  return { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1, modelCall };
}

describe("agentRowSummary", () => {
  it("reads the live status, elapsed and tokens from the record, not the launch details", () => {
    const record = makeRecord();
    const call: ModelCallState = { startedAt: NOW - 161_000, lastEventAt: NOW - 1_000, kind: "thinking", writtenChars: 0 };
    const line = agentRowSummary(makeDetails(), live(record, activityWith(call)), theme, NOW);
    expect(line).toMatch(/thinking · 2m41s · 12s · 3\.2k token$/);
  });

  it("changes as the record changes, with no new result", () => {
    const record = makeRecord();
    const view = live(record, activityWith());
    expect(agentRowSummary(makeDetails(), view, theme, NOW)).toContain("thinking…");
    record.status = "completed";
    record.completedAt = NOW - 2_000;
    expect(agentRowSummary(makeDetails(), view, theme, NOW)).toBe("✓ done · 10s · 3.2k token");
  });

  it("falls back to the details when the record has been evicted", () => {
    const line = agentRowSummary(makeDetails({ status: "background", durationMs: 4_000 }), live(undefined), theme, NOW);
    expect(line).toContain("running in background");
    expect(line).toContain("4s");
  });

  it("trusts a terminal result over a stale record", () => {
    const record = makeRecord({ status: "running" });
    const details = makeDetails({ status: "steered", durationMs: 9_000, tokens: "5.0k token" });
    expect(agentRowSummary(details, live(record), theme, NOW)).toMatch(/^✓ wrapped up \(turn limit\)/);
  });

  it.each([
    ["stopped", "■ stopped"],
    ["aborted", "✗ aborted (max turns exceeded)"],
    ["error", "✗ error: boom"],
  ] as const)("renders %s", (status, expected) => {
    const line = agentRowSummary(makeDetails({ status, error: "boom", durationMs: 1_000 }), live(undefined), theme, NOW);
    expect(line.startsWith(expected)).toBe(true);
  });

  it("appends cost only when asked", () => {
    const record = makeRecord({ lifetimeUsage: { input: 3_200, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0.0123 } as any });
    expect(agentRowSummary(makeDetails(), live(record, undefined, true), theme, NOW)).toContain("~$0.0123");
    expect(agentRowSummary(makeDetails(), live(record, undefined, false), theme, NOW)).not.toContain("$");
  });
});

describe("AgentCallView", () => {
  it("is one line collapsed, with no disclosure marker of its own", () => {
    const lines = new AgentCallView("Plan  plan the thing", undefined, theme).render(80);
    expect(lines).toEqual(["Plan  plan the thing"]);
    expect(lines.join("")).not.toMatch(/[▸▾]/);
  });

  it("adds the prompt when expanded", () => {
    const lines = new AgentCallView("Plan  plan the thing", "line one\nline two", theme).render(80);
    expect(lines).toEqual(["Plan  plan the thing", "  line one", "  line two"]);
  });
});

describe("AgentResultView", () => {
  const record = makeRecord({ status: "completed", completedAt: NOW - 1, outputFile: "/tmp/t/a1.output" });
  const details = makeDetails({ status: "completed", durationMs: 12_000, tokens: "3.2k token" });

  it("collapses to the summary alone", () => {
    const lines = new AgentResultView(details, "the full report", false, live(record), theme).render(120);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^✓ done · /);
  });

  it("expands to tags, an OSC 8 transcript link, then the result", () => {
    const lines = new AgentResultView(details, "the full report\nsecond line", true, live(record), theme).render(120);
    expect(lines[1]).toBe("↳ opus 4.6 · thinking: high");
    expect(lines[2]).toContain("\x1b]8;;file:///tmp/t/a1.output");
    expect(lines[2]).toContain("transcript ↗");
    expect(lines.slice(3)).toEqual(["  the full report", "  second line"]);
  });

  it("omits the link when no transcript was written", () => {
    const lines = new AgentResultView(details, "r", true, live(makeRecord({ status: "completed", completedAt: NOW })), theme).render(120);
    expect(lines.join("\n")).not.toContain("transcript");
  });

  it("never exceeds the width", () => {
    const lines = new AgentResultView(details, "x".repeat(500), false, live(record), theme).render(40);
    expect(lines.every(l => l.length <= 60)).toBe(true);
  });
});

describe("keepRowTicking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("repaints while the run is live, then stops by itself after one last repaint", () => {
    const record = makeRecord();
    const invalidate = vi.fn();
    const context = { state: {} as object, invalidate };
    const view = live(record);
    const running = makeDetails({ status: "running" });

    keepRowTicking(context, running, view);
    vi.advanceTimersByTime(3_000);
    expect(invalidate).toHaveBeenCalledTimes(3);

    record.status = "completed";
    vi.advanceTimersByTime(1_000);
    expect(invalidate).toHaveBeenCalledTimes(4); // the final repaint
    vi.advanceTimersByTime(5_000);
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("starts at most one ticker per row, and none for a finished run", () => {
    const invalidate = vi.fn();
    const context = { state: {} as object, invalidate };
    const view = live(makeRecord());
    keepRowTicking(context, makeDetails({ status: "running" }), view);
    keepRowTicking(context, makeDetails({ status: "running" }), view);
    vi.advanceTimersByTime(1_000);
    expect(invalidate).toHaveBeenCalledTimes(1);

    const idle = { state: {} as object, invalidate: vi.fn() };
    keepRowTicking(idle, makeDetails({ status: "completed" }), live(undefined));
    vi.advanceTimersByTime(5_000);
    expect(idle.invalidate).not.toHaveBeenCalled();
  });

  it("does nothing without a shared state or invalidate", () => {
    expect(() => keepRowTicking({}, makeDetails(), live(makeRecord()))).not.toThrow();
  });

  it("isRowLive prefers the record over the details", () => {
    expect(isRowLive(makeDetails({ status: "background" }), live(makeRecord()))).toBe(true);
    expect(isRowLive(makeDetails({ status: "running" }), live(makeRecord({ status: "completed" })))).toBe(false);
    expect(isRowLive(makeDetails({ status: "running" }), live(undefined))).toBe(true);
    expect(isRowLive(makeDetails({ status: "background" }), live(undefined))).toBe(false);
  });
});
