import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowTask } from "../src/workflow/task.js";
import { WorkflowUsageTracker } from "../src/workflow/usage.js";

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheWrite: 0,
  cacheRead: 0,
  cost,
});

function record(over: Partial<AgentRecord>): AgentRecord {
  return { id: "agent", ...over } as AgentRecord;
}

describe("WorkflowUsageTracker", () => {
  it("updates token and cost totals while a workflow child is still running", () => {
    const tracker = new WorkflowUsageTracker();
    const child = record({ id: "child", workflowId: "wf_live", status: "running" });
    const task = createWorkflowTask({ id: "wf_live", script: "" });

    tracker.record(child, usage(1_000, 200, 0.01), () => undefined);
    expect(tracker.snapshot(task)).toEqual({ tokens: 1_200, cost: 0.01 });

    tracker.record(child, usage(500, 100, 0.005), () => undefined);
    expect(tracker.snapshot(task)).toEqual({ tokens: 1_800, cost: 0.015 });
  });

  it("attributes nested child usage through its workflow-owned ancestor exactly once", () => {
    const tracker = new WorkflowUsageTracker();
    const owner = record({ id: "owner", workflowId: "wf_nested" });
    const nested = record({ id: "nested", parentAgentId: owner.id });
    const records = new Map([[owner.id, owner], [nested.id, nested]]);
    const task = createWorkflowTask({ id: "wf_nested", script: "" });

    tracker.record(nested, usage(700, 50, 0.02), id => records.get(id));

    expect(tracker.snapshot(task)).toEqual({ tokens: 750, cost: 0.02 });
  });

  it("retains larger journal totals for replayed agents without inventing new cost", () => {
    const tracker = new WorkflowUsageTracker();
    const task = createWorkflowTask({ id: "wf_replay", script: "" });
    task.totalTokens = 9_000;

    expect(tracker.snapshot(task)).toEqual({ tokens: 9_000, cost: 0 });
  });
});
