/**
 * strict-agent-files-wiring.test.ts — proves `strictAgentFiles` gates the real
 * extension startup, and that it is a STARTUP decision only.
 *
 * Project agent files load at `session_start`, once pi's canonical trust answer
 * exists, so strict failures surface there, as the host's `ExtensionStartupError`
 * (which fails the bind before any provider request). A later reload of the same
 * broken file must not throw: agents reload once per `Agent` call, and a strict
 * reload would kill the session on an unrelated spawn long after the bad edit.
 *
 * MOCK SCOPE: the installed host SDK (1.1.0) has no `ExtensionStartupError`, so
 * this file models a NEW host by adding a stand-in class to the SDK module. The
 * old-host refusal is covered, against the real SDK, by
 * strict-agent-files-old-host.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, makePi, startSession } from "./helpers/boot-extension.js";

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  class ExtensionStartupError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = "ExtensionStartupError";
    }
  }
  return { ...(await importOriginal<object>()), ExtensionStartupError };
});

const BROKEN = "---\nname: broken\ndescription: Use this: that\n---\n\nBroken.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeSettings(settings: Record<string, unknown>): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subagents.json"), JSON.stringify(settings));
}

function writeBrokenAgent(): string {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "broken.md");
  writeFileSync(path, BROKEN);
  return path;
}

describe("strictAgentFiles gates session startup", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "strict-agent-files-"));
    process.chdir(cwd);
    // A developer's real ~/.pi/subagents.json would otherwise set this very
    // setting under the tests, and their global agents would pollute the roster.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("activates, then fails session_start naming the file with the host's startup error", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    const { pi, lifecycle } = makePi();

    expect(() => subagentsExtension(pi)).not.toThrow();
    const failure = await startSession(lifecycle, true).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ExtensionStartupError");
    expect((failure as Error).message).toContain(path);
    expect(((failure as Error).cause as Error).message).toContain(path);
  });

  it("stays latched until a bind succeeds, so a retried bind is strict again", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await expect(startSession(lifecycle, true)).rejects.toThrow(path);
    await expect(startSession(lifecycle, true)).rejects.toThrow(path);
    writeFileSync(path, "---\ndescription: Fixed\n---\n\nFixed.\n");
    await expect(startSession(lifecycle, true)).resolves.toBeUndefined();
  });

  it("never reads a malformed project file of an untrusted project", async () => {
    writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await expect(startSession(lifecycle, false)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Skipping agent file"));
  });

  it("skips the file and starts when disabled (the default)", async () => {
    writeBrokenAgent();
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await expect(startSession(lifecycle, true)).resolves.toBeUndefined();
    expect(String(warn.mock.calls.find(c => String(c[0]).includes("Skipping agent file"))?.[0])).toContain("Skipping agent file");
  });

  it("is a startup decision: a later reload of the same file does not throw", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });

    // Start clean, so the session exists — then break the file underneath it.
    writeFileSync(path, "---\ndescription: Fixed\n---\n\nFixed.\n");
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await startSession(lifecycle, true);
    writeFileSync(path, BROKEN);

    const agentTool = tools.get("Agent");
    expect(agentTool).toBeDefined();

    // The Agent tool reloads the registry per call. That reload must be
    // non-strict: it returns a normal "unknown type" result, not a YAML throw.
    const result = await agentTool.execute("call-1", { subagent_type: "nope", prompt: "x" }, undefined, vi.fn(), ctx({ cwd }));
    expect(JSON.stringify(result)).not.toContain("Nested mappings");
    // And so is a later session_start (new / resume / reload-in-place).
    await expect(startSession(lifecycle, true)).resolves.toBeUndefined();
  });
});
