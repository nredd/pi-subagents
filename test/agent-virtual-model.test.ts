/**
 * agent-virtual-model.test.ts -- a subagent on a virtual (router) model must be
 * labelled with the physical model that answered, not the router's name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { describePhysicalModel, describeVirtualModel, isVirtualModel } from "../src/model-resolver.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { runAgent } from "../src/agent-runner.js";

const ROUTER = { provider: "router", id: "default", name: "Router Default", api: "pi-virtual" };
const SONNET = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "anthropic-messages" };
const USAGE = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0 };

describe("virtual model helpers", () => {
  it("recognises only pi-virtual as virtual", () => {
    expect(isVirtualModel(ROUTER)).toBe(true);
    expect(isVirtualModel(SONNET)).toBe(false);
    expect(isVirtualModel(undefined)).toBe(false);
  });

  it("marks a virtual selection as routing until a response names the physical model", () => {
    expect(describeVirtualModel(ROUTER)).toEqual({ modelName: "router default (routing)", modelId: "router/default" });
  });

  it("describes the physical model of a response, using the registry name when known", () => {
    const registry = { find: (p: string, id: string) => (p === SONNET.provider && id === SONNET.id ? SONNET : undefined) };
    expect(describePhysicalModel({ provider: "anthropic", model: "claude-sonnet-5-5", api: "anthropic-messages" }, registry)).toEqual({
      modelName: "sonnet 5.5",
      modelId: "anthropic/claude-sonnet-5-5",
    });
  });

  it("falls back to the id without a registry, and ignores messages naming no physical model", () => {
    expect(describePhysicalModel({ provider: "openai", model: "gpt-6-sol" })).toEqual({
      modelName: "gpt-6-sol",
      modelId: "openai/gpt-6-sol",
    });
    expect(describePhysicalModel({ provider: "router", model: "default", api: "pi-virtual" })).toBeUndefined();
    expect(describePhysicalModel({})).toBeUndefined();
  });
});

describe("AgentManager -- invocation model on a router selection", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  function spawnWith(session: Record<string, unknown>, then: (opts: any) => void) {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      await Promise.resolve(); // production creates the session asynchronously, after spawn() returns
      opts.onSessionCreated?.(session);
      then(opts);
      return { responseText: "ok", session, aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: "/tmp" } as any, "general-purpose", "p", {
      description: "d",
      isBackground: true,
    });
    return manager.getRecord(id)!;
  }

  it("shows '(routing)' before the first response and the physical model after it", async () => {
    let before: string | undefined;
    let record: ReturnType<AgentManager["getRecord"]>;
    const session = { model: ROUTER, thinkingLevel: "medium", dispose: vi.fn(), modelRegistry: { find: () => SONNET } };
    record = spawnWith(session, (opts) => {
      before = record?.invocation?.modelName;
      opts.onAssistantUsage?.(USAGE, { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5" });
    });
    await record!.promise;
    expect(before).toBe("router default (routing)");
    expect(record!.invocation).toMatchObject({
      modelName: "sonnet 5.5",
      modelId: "anthropic/claude-sonnet-5-5",
      thinking: "medium",
    });
  });

  it("follows a router fallback to the next physical model", async () => {
    const session = { model: ROUTER, thinkingLevel: "high", dispose: vi.fn() };
    const record = spawnWith(session, (opts) => {
      opts.onAssistantUsage?.(USAGE, { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5" });
      opts.onAssistantUsage?.(USAGE, { api: "openai-responses", provider: "openai", model: "gpt-6-sol" });
    });
    await record.promise;
    expect(record.invocation?.modelId).toBe("openai/gpt-6-sol");
  });

  it("leaves a physical selection unchanged by the same response", async () => {
    const session = { model: SONNET, thinkingLevel: "low", dispose: vi.fn() };
    const record = spawnWith(session, () => {});
    await record.promise;
    expect(record.invocation).toMatchObject({ modelName: "sonnet 5.5", modelId: "anthropic/claude-sonnet-5-5" });
  });
});
