/** workflow/usage.ts — Live usage aggregation for workflow-owned agent trees. */

import type { AgentRecord } from "../types.js";
import { addUsage, getLifetimeCost, getLifetimeTotal, type LifetimeUsage } from "../usage.js";
import type { WorkflowTask } from "./task.js";

const emptyUsage = (): LifetimeUsage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });

type WorkflowOwnerRecord = Pick<AgentRecord, "id" | "parentAgentId" | "workflowId">;
type RecordLookup = (id: string) => WorkflowOwnerRecord | undefined;

export interface WorkflowUsageSnapshot {
  tokens: number;
  cost: number;
}

/**
 * Accumulate each assistant message exactly once under the workflow that owns
 * its agent tree. Nested children carry only `parentAgentId`, so ownership is
 * resolved by walking ancestors instead of relying on the immediate record.
 */
export class WorkflowUsageTracker {
  private readonly totals = new Map<string, LifetimeUsage>();

  record(record: WorkflowOwnerRecord, usage: LifetimeUsage, getRecord: RecordLookup): void {
    const visited = new Set<string>();
    let current: WorkflowOwnerRecord | undefined = record;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.workflowId) {
        const total = this.totals.get(current.workflowId) ?? emptyUsage();
        addUsage(total, usage);
        this.totals.set(current.workflowId, total);
        return;
      }
      current = current.parentAgentId ? getRecord(current.parentAgentId) : undefined;
    }
  }

  /** Live spend, with journal-replayed token totals retained when they are larger. */
  snapshot(task: Pick<WorkflowTask, "id" | "totalTokens">): WorkflowUsageSnapshot {
    const usage = this.totals.get(task.id);
    return {
      tokens: Math.max(task.totalTokens, getLifetimeTotal(usage)),
      cost: getLifetimeCost(usage),
    };
  }
}
