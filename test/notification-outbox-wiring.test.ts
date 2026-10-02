/**
 * notification-outbox-wiring.test.ts -- completion notices go out as ONE
 * message, when the parent is idle or on `agent_end`, and never for a result the
 * parent already fetched. Driven through the real extension, Agent tool and
 * get_subagent_result; only the runner is mocked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_before_switch, session_shutdown
  const events = new Map<string, any>(); // pi.events.on(...) — subagents:rpc:*, etc.
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        events.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, events };
}

let parentIdle = true;

function ctx() {
  return {
    hasUI: false,
    isIdle: () => parentIdle,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("notification outbox wiring", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-outbox-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-outbox-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
    parentIdle = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "THE-RESULT-PAYLOAD",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function boot() {
    const made = makePi();
    subagentsExtension(made.pi);
    await made.lifecycle.get("session_start")?.({}, ctx());
    return made;
  }

  async function spawn(tools: Map<string, any>, description: string): Promise<string> {
    const res = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    return textOf(res).match(/Agent ID: (\S+)/)![1];
  }

  const notices = (pi: any) =>
    pi.sendMessage.mock.calls.filter((c: any[]) => c[0].customType === "subagent-notification");

  it("sends nothing while the parent is busy, then one coalesced message on agent_end", async () => {
    const { pi, tools, lifecycle } = await boot();
    parentIdle = false;
    await spawn(tools, "first job");
    await spawn(tools, "second job");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices(pi)).toHaveLength(0);

    await lifecycle.get("agent_end")?.({ type: "agent_end" }, ctx());

    const sent = notices(pi);
    expect(sent).toHaveLength(1);
    expect(sent[0][0].content).toContain("2 agent(s) finished");
    expect(sent[0][0].details.others).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });

    await lifecycle.get("agent_end")?.({ type: "agent_end" }, ctx());
    expect(notices(pi)).toHaveLength(1);
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("delivers promptly when the parent is idle", async () => {
    const { pi, tools, lifecycle } = await boot();
    await spawn(tools, "lone job");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices(pi)).toHaveLength(1);
    expect(notices(pi)[0][0].content).toContain("THE-RESULT-PAYLOAD");
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("suppresses the notice for a result the parent fetched while busy", async () => {
    const { pi, tools, lifecycle } = await boot();
    parentIdle = false;
    const fetched = await spawn(tools, "fetched early");
    await spawn(tools, "left alone");
    await vi.advanceTimersByTimeAsync(1_000);

    const out = textOf(await tools.get("get_subagent_result").execute("tc", { agent_id: fetched }, undefined, undefined, ctx()));
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("agent_end")?.({ type: "agent_end" }, ctx());

    const sent = notices(pi);
    expect(sent).toHaveLength(1);
    expect(sent[0][0].details.description).toBe("left alone");
    expect(sent[0][0].details.others).toBeUndefined();
    expect(sent[0][0].content).not.toContain("fetched early");
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("sends nothing when the only pending result was fetched", async () => {
    const { pi, tools, lifecycle } = await boot();
    parentIdle = false;
    const id = await spawn(tools, "fetched early");
    await vi.advanceTimersByTimeAsync(1_000);
    await tools.get("get_subagent_result").execute("tc", { agent_id: id }, undefined, undefined, ctx());
    await lifecycle.get("agent_end")?.({ type: "agent_end" }, ctx());
    expect(notices(pi)).toHaveLength(0);
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
