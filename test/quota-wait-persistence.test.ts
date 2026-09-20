import { describe, expect, it } from "vitest";
import { restoredQuotaWaitDispatches } from "../src/index.js";
import type { QuotaWaitDispatch } from "../src/types.js";

function dispatch(id: string, nextCheckAt = 200): QuotaWaitDispatch {
  return {
    version: 1,
    id,
    type: "general-purpose",
    prompt: `prompt ${id}`,
    modelChain: ["anthropic/claude-opus-4-6"],
    wait: {
      phase: "preflight",
      parkedAt: 100,
      deadlineAt: 1_000,
      nextCheckAt,
      unknownPollAttempt: 0,
      blocked: [{ modelId: "anthropic/claude-opus-4-6", window: "five_hour" }],
      persistence: "session",
    },
    options: { description: `wait ${id}`, isBackground: true },
  };
}

function entry(data: unknown) {
  return { type: "custom", customType: "subagents:quota-wait", data };
}

describe("standalone quota-wait persistence", () => {
  it("restores only the latest still-active dispatch per id", () => {
    const first = dispatch("a", 200);
    const updated = dispatch("a", 300);
    const other = dispatch("b", 400);

    expect(restoredQuotaWaitDispatches([
      entry({ version: 1, id: "a", status: "active", dispatch: first }),
      entry({ version: 1, id: "a", status: "active", dispatch: updated }),
      entry({ version: 1, id: "b", status: "active", dispatch: other }),
      entry({ version: 1, id: "a", status: "released" }),
    ])).toEqual([other]);
  });

  it("ignores malformed, unrelated, and terminal-only entries", () => {
    expect(restoredQuotaWaitDispatches([
      undefined,
      { type: "message" },
      entry({ version: 2, id: "a", status: "active", dispatch: dispatch("a") }),
      entry({ version: 1, id: "a", status: "active" }),
      entry({ version: 1, id: "a", status: "cancelled" }),
    ])).toEqual([]);
  });
});
