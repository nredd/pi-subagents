/**
 * detached-results.test.ts -- background agents survive a session switch.
 *
 * `session_shutdown` fires for /new, /resume, /fork and /reload with the process
 * alive. Aborting there threw away every running background agent's findings.
 * Now only `quit` aborts; otherwise survivors finish in the orphaned manager and
 * their results are spooled for the session they belong to.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import {
  drainDetached,
  listRunningDetached,
  registerRunningDetached,
  spoolDetached,
  unregisterRunningDetached,
  watchDetached,
} from "../src/detached-results.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx(sessionFile: string | undefined) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => "s1"),
      getBranch: vi.fn(() => []),
      getSessionFile: vi.fn(() => sessionFile),
    },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("detached result spool", () => {
  const file = `/sessions/spool-${process.pid}-${Date.now()}.jsonl`;

  it("round-trips in order, deletes what it drains, and isolates sessions", () => {
    const mk = (id: string) => ({ id, content: `c-${id}`, details: { id }, record: { id } });
    spoolDetached(file, mk("a"));
    spoolDetached(file, mk("b"));
    spoolDetached(`${file}.other`, mk("z"));
    expect(drainDetached(file).map((r) => r.id)).toEqual(["a", "b"]);
    expect(drainDetached(file)).toEqual([]);
    expect(drainDetached(`${file}.other`).map((r) => r.id)).toEqual(["z"]);
  });

  it("wakes the watcher for its own session only, until unsubscribed", () => {
    const wake = vi.fn();
    const stop = watchDetached(file, wake);
    spoolDetached(`${file}.elsewhere`, { id: "x", content: "", details: {}, record: {} });
    expect(wake).not.toHaveBeenCalled();
    spoolDetached(file, { id: "y", content: "", details: {}, record: {} });
    expect(wake).toHaveBeenCalledTimes(1);
    stop();
    spoolDetached(file, { id: "w", content: "", details: {}, record: {} });
    expect(wake).toHaveBeenCalledTimes(1);
    drainDetached(file);
    drainDetached(`${file}.elsewhere`);
  });

  it("drops a corrupt entry instead of failing the drain", async () => {
    const { detachedDir } = await import("../src/detached-results.js");
    writeFileSync(join(detachedDir(file), "0-bad.json"), "{nope");
    spoolDetached(file, { id: "ok", content: "", details: {}, record: {} });
    expect(drainDetached(file).map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("running detached registry", () => {
  const file = `/sessions/running-${process.pid}-${Date.now()}.jsonl`;
  const mk = (id: string) => ({ record: { id } as any, abort: () => true, steer: () => true });

  it("lists per session in registration order and forgets settled agents", () => {
    registerRunningDetached(file, mk("a"));
    registerRunningDetached(file, mk("b"));
    registerRunningDetached(`${file}.other`, mk("z"));
    expect(listRunningDetached(file).map((d) => d.record.id)).toEqual(["a", "b"]);
    unregisterRunningDetached(file, "a");
    expect(listRunningDetached(file).map((d) => d.record.id)).toEqual(["b"]);
    unregisterRunningDetached(file, "b");
    expect(listRunningDetached(file)).toEqual([]);
    unregisterRunningDetached(`${file}.other`, "z");
  });

  it("returns nothing for an unknown or missing session", () => {
    expect(listRunningDetached(undefined)).toEqual([]);
    expect(listRunningDetached("/sessions/none.jsonl")).toEqual([]);
  });
});

describe("AgentManager.detach", () => {
  it("keeps running background agents and aborts foreground, queued and workflow ones", () => {
    const manager = new AgentManager(() => {});
    const mk = (id: string, status: string, extra: object) => {
      const abortController = { abort: vi.fn() };
      (manager as any).agents.set(id, { id, status, abortController, ...extra });
      return abortController;
    };
    const bg = mk("bg", "running", { isBackground: true });
    const nested = mk("nested", "running", { isBackground: false, parentAgentId: "bg" });
    const fg = mk("fg", "running", { isBackground: false });
    const wf = mk("wf", "running", { isBackground: true, workflowId: "w1" });

    expect(manager.detach()).toBe(2);
    expect(bg.abort).not.toHaveBeenCalled();
    expect(nested.abort).not.toHaveBeenCalled();
    expect(fg.abort).toHaveBeenCalled();
    expect(wf.abort).toHaveBeenCalled();
    expect((manager as any).agents.get("fg").status).toBe("stopped");
    expect((manager as any).agents.get("bg").status).toBe("running");
  });
});

describe("session switch with a running background agent", () => {
  let tmpDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let agentDir: string;
  const sessionFile = `/sessions/switch-${process.pid}-${Date.now()}.jsonl`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-detach-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-detach-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    drainDetached(sessionFile);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function spawnRunning(tools: Map<string, any>) {
    let finish!: (v: any) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(((_c: any, _t: any, _p: any, opts: any) => {
      signal = opts?.signal;
      return new Promise((res) => {
        finish = res;
      });
    }) as any);
    const r = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "long reviewer", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(sessionFile),
    );
    const id = /Agent ID: (\S+)/.exec(r.content[0].text)![1];
    return { id, finish: () => finish({ responseText: "FINDINGS", session: { dispose: vi.fn() }, aborted: false, steered: false }), signal: () => signal };
  }

  it("does not abort on /new, and a later return to the session receives the result", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);

    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx(sessionFile));
    expect(agent.signal()?.aborted ?? false).toBe(false);

    agent.finish();
    await flush();
    // The orphaned instance must not talk to pi: its handle is stale.
    expect(first.pi.sendMessage).not.toHaveBeenCalled();

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = back.pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-notification");
    expect(msg.content).toContain("FINDINGS");
    expect(msg.content).toContain(agent.id);
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(back.pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id: agent.id, status: "completed" }));
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("publishes the running agent for the next instance until it settles", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    expect(listRunningDetached(sessionFile)).toEqual([]);

    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx(sessionFile));
    expect(listRunningDetached(sessionFile).map((d) => d.record.id)).toEqual([agent.id]);

    agent.finish();
    await flush();
    expect(listRunningDetached(sessionFile)).toEqual([]);
  });

  it("delivers immediately when the agent finishes while its session is open again", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "resume" }, ctx(sessionFile));

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    expect(back.pi.sendMessage).not.toHaveBeenCalled();

    agent.finish();
    await flush();
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("still aborts on quit", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(tools);
    await lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
    expect(agent.signal()?.aborted).toBe(true);
  });

  it("still aborts when the session has no file to hand results back to", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ type: "session_start" }, ctx(undefined));
    const agent = await spawnRunning(tools);
    await lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx(undefined));
    expect(agent.signal()?.aborted).toBe(true);
  });
});
