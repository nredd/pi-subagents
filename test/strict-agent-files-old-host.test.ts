/**
 * strict-agent-files-old-host.test.ts — against the REAL installed host SDK,
 * which predates `ExtensionStartupError`: strictAgentFiles must refuse at
 * activation, clearly, before any project file is read, rather than silently
 * degrade to warnings. Non-strict activation stays fully supported.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { hostStartupErrorClass } from "../src/startup-error.js";
import { makePi, startSession } from "./helpers/boot-extension.js";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

describe("strictAgentFiles on a host without ExtensionStartupError", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "strict-old-host-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "broken.md"), "---\nname: broken\ndescription: Use this: that\n---\n\nBroken.\n");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is really an old host: the SDK exports no startup error", () => {
    expect(Reflect.get(hostSdk, "ExtensionStartupError")).toBeUndefined();
    expect(hostStartupErrorClass()).toBeUndefined();
  });

  it("refuses strict activation before reading any project file", () => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ strictAgentFiles: true }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pi } = makePi();
      expect(() => subagentsExtension(pi)).toThrow(/strictAgentFiles requires a pi host that exports ExtensionStartupError/);
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Skipping agent file"));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps non-strict startup working: the bad file warns and is skipped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pi, lifecycle } = makePi();
      expect(() => subagentsExtension(pi)).not.toThrow();
      await expect(startSession(lifecycle, true)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping agent file"));
    } finally {
      warn.mockRestore();
    }
  });
});
