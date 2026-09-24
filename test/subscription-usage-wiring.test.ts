/**
 * subscription-usage-wiring.test.ts — the subscription-usage surfaces the real
 * extension wires up: the per-turn system-prompt summary and quota admission
 * on the Agent tool and `@handle` mention routes.
 *
 * The process-wide usage service is swapped for one on a scripted transport,
 * so each test starts from a cold cache and controls exactly what (and when) a
 * usage read returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionUsageService, SubscriptionUsageTransport } from "../src/subscription-usage.js";

const usage = vi.hoisted(() => ({ service: undefined as unknown as SubscriptionUsageService }));

vi.mock("../src/subscription-usage.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/subscription-usage.js")>();
  return { ...actual, getSubscriptionUsageService: () => usage.service };
});
vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { SubscriptionUsageService as Service } from "../src/subscription-usage.js";
import { ctx as baseCtx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const NOW = 1_700_000_000_000;
const RESET = new Date(NOW + 3_600_000).toISOString();
const BLOCKED = "all configured models are blocked";
const sonnet = { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" };

let now = NOW;
let fetchImpl: SubscriptionUsageTransport["fetch"];
let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;

/** A `/api/oauth/usage` response with the five-hour window at `utilization`%. */
const anthropicUsage = (utilization: number) =>
  new Response(JSON.stringify({ five_hour: { utilization, resets_at: RESET } }), { status: 200 });

function ctx() {
  return baseCtx({
    model: sonnet,
    scopedModels: [],
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => provider === sonnet.provider && id === sonnet.id ? sonnet : undefined),
      getAll: vi.fn(() => [sonnet]),
      getAvailable: vi.fn(() => [sonnet]),
    },
  });
}

function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false, agentMentions: "direct" } });
  const booted = makePi();
  subagentsExtension(booted.pi);
  lifecycle = booted.lifecycle;
  return booted;
}

const systemPrompt = async (c = ctx()): Promise<string> =>
  (await lifecycle!.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, c)).systemPrompt;

beforeEach(() => {
  now = NOW;
  fetchImpl = vi.fn(async () => anthropicUsage(100));
  usage.service = new Service({
    fetch: (input, init) => fetchImpl(input, init),
    now: () => now,
    getAccessToken: async () => "oauth-token",
  });
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  lifecycle = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

describe("system-prompt usage summary", () => {
  it("renders from the cache without awaiting a read, and warms it for the next turn", async () => {
    boot();
    let resolveRead!: (response: Response) => void;
    fetchImpl = vi.fn(() => new Promise<Response>(resolve => { resolveRead = resolve; }));
    const c = ctx();

    // The read never settles until released below; the hook must not wait on it.
    expect(await systemPrompt(c)).toContain("- anthropic: usage unavailable\n");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveRead(anthropicUsage(31));
    await vi.waitFor(() => expect(usage.service.peek("anthropic")?.status).toBe("available"));
    expect(await systemPrompt(c)).toContain("- anthropic: five_hour 25-50%\n");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is byte-identical for usage within one bucket, so the prompt cache survives", async () => {
    boot();
    const c = ctx();
    fetchImpl = vi.fn(async () => anthropicUsage(31));
    await usage.service.get(c, "anthropic");
    const at31 = await systemPrompt(c);

    now += 6 * 60_000;
    fetchImpl = vi.fn(async () => anthropicUsage(44));
    await usage.service.get(c, "anthropic");
    const at44 = await systemPrompt(c);

    now += 6 * 60_000;
    fetchImpl = vi.fn(async () => anthropicUsage(60));
    await usage.service.get(c, "anthropic");

    expect(at44).toBe(at31);
    expect(await systemPrompt(c)).not.toBe(at31);
  });
});

describe("quota admission through the real extension (cold cache, exhausted provider)", () => {
  for (const background of [false, true]) {
    it(`blocks the Agent tool before anything starts (run_in_background: ${background})`, async () => {
      const { tools } = boot();

      await expect(tools.get("Agent").execute(
        "tc-1",
        { prompt: "do it", description: "quota", subagent_type: "general-purpose", run_in_background: background },
        undefined, undefined, ctx(),
      )).rejects.toThrow(BLOCKED);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(runAgent).not.toHaveBeenCalled();
    });
  }

  it("blocks an @handle mention before anything starts", async () => {
    boot();
    const c = ctx();

    await lifecycle!.get("input")({ type: "input", text: "@general-purpose do it", source: "interactive" }, c);

    expect(c.ui.notify).toHaveBeenCalledWith(expect.stringContaining(BLOCKED), "error");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
