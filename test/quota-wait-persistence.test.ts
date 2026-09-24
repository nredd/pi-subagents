import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { setQuotaExhaustionPolicy } from "../src/fallback-models.js";
import { restoredQuotaWaitDispatches } from "../src/index.js";
import type { AgentQuotaWaitEvent, QuotaWaitDispatch } from "../src/types.js";

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

describe("mid-run quota-wait persistence", () => {
  const opus = { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" } as any;
  const ctx = {
    cwd: "/tmp",
    modelRegistry: {
      find: (provider: string, id: string) => provider === opus.provider && id === opus.id ? opus : undefined,
      getAll: () => [opus],
      getAvailable: () => [opus],
    },
  } as any;
  const session = () => ({ dispose: vi.fn(), model: opus, sessionManager: { getSessionFile: () => "/sessions/child.jsonl" } }) as any;
  let managers: AgentManager[] = [];

  afterEach(async () => {
    for (const manager of managers) await manager.dispose();
    managers = [];
    setQuotaExhaustionPolicy(undefined);
    vi.mocked(runAgent).mockReset();
  });

  it("carries the turns already spent, so a wait restored after a restart keeps the original budget", async () => {
    setQuotaExhaustionPolicy("wait-async");
    let exhausted = false;
    const quota = {
      get: vi.fn(async () => undefined),
      decisionFor: vi.fn(() => exhausted
        ? { block: true, window: "five_hour", resetAt: Date.now() + 3_600_000, snapshot: { status: "available" } }
        : { block: false, snapshot: { status: "available" } }),
    };
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      const s = session();
      options.onSessionCreated?.(s);
      for (let turn = 1; turn <= 3; turn++) options.onTurnEnd?.(turn);
      exhausted = true;
      return { responseText: "partial", session: s, aborted: false, steered: false, failure: "429 rate limit exceeded" };
    });
    const entries: unknown[] = [];
    const first = new AgentManager({
      subscriptionUsage: quota as any,
      onQuotaWait: (_record, event: AgentQuotaWaitEvent) => {
        if (event.transition === "parked") {
          // Through JSON, as the session file stores it.
          entries.push(JSON.parse(JSON.stringify({
            type: "custom",
            customType: "subagents:quota-wait",
            data: { version: 1, id: event.dispatch.id, status: "active", dispatch: event.dispatch },
          })));
        }
      },
    });
    managers.push(first);
    const id = first.spawn({} as any, ctx, "general-purpose", "original", {
      description: "budget",
      isBackground: true,
      model: opus,
      maxTurns: 5,
    });
    await vi.waitFor(() => expect(first.getRecord(id)?.quotaWait?.phase).toBe("mid-run"));

    const [dispatch] = restoredQuotaWaitDispatches(entries);
    expect(dispatch.options).toMatchObject({ priorTurns: 3, maxTurns: 5, resumeSessionFile: "/sessions/child.jsonl" });

    // "Restart": a new manager restores the wait, and the window has reset.
    exhausted = false;
    vi.mocked(runAgent).mockImplementationOnce(async () =>
      ({ responseText: "done", session: session(), aborted: false, steered: false }));
    const second = new AgentManager({ subscriptionUsage: quota as any });
    managers.push(second);
    second.restoreQuotaWait({} as any, ctx, { ...dispatch, wait: { ...dispatch.wait, nextCheckAt: Date.now() } });
    await vi.waitFor(() => expect(second.getRecord(id)?.status).toBe("completed"));

    expect(vi.mocked(runAgent).mock.calls[1][3]).toMatchObject({ priorTurns: 3, maxTurns: 5 });
  });

  it("rejects a persisted turn count that is not a non-negative integer", () => {
    const manager = new AgentManager();
    managers.push(manager);
    const bad = { ...dispatch("x"), options: { description: "x", priorTurns: -1 } };

    expect(() => manager.restoreQuotaWait({} as any, ctx, bad)).toThrow("invalid turn count");
  });
});
