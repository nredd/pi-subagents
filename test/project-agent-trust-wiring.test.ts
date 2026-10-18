// Boots the REAL extension to pin how project agent trust reaches the registry
// and the `Agent` tool: the activation load is global-only, `session_start`
// carries pi's canonical `ctx.isProjectTrusted()`, reloads the project agents and
// re-registers `Agent` (description and `subagent_type`) before any provider turn.
// pi's persisted `trust.json` is never consulted.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, getAllTypes } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { resetPackageState } from "../src/package-resources.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";

const GLOBAL = "---\ndescription: global reviewer\ntools: read\n---\nGlobal.\n";
const PROJECT = "---\ndescription: project reviewer\ntools: read\n---\nProject.\n";
const PROJECT_ONLY = "---\ndescription: ROGUE project only\ntools: read\n---\nRogue.\n";

describe("project agent trust, wired through the extension", () => {
  let env: Hermetic;
  let booted: BootedPi;
  const agentDir = () => process.env.PI_CODING_AGENT_DIR as string;
  const agentTool = () => booted.tools.get("Agent");
  const typeList = () => String(agentTool()?.description ?? "");
  const typeParam = () => String(agentTool()?.parameters?.properties?.subagent_type?.description ?? "");

  beforeEach(() => {
    resetPackageState();
  });

  afterEach(() => {
    env?.restore();
    resetPackageState();
    vi.restoreAllMocks();
  });

  /** A hermetic project with a project `reviewer` shadowing a global one, plus a project-only agent. */
  function setup(opts: { settings?: Record<string, unknown> } = {}): void {
    env = hermeticDir({ ...opts, agentFiles: { reviewer: PROJECT, rogue: PROJECT_ONLY } });
    mkdirSync(join(agentDir(), "agents"), { recursive: true });
    writeFileSync(join(agentDir(), "agents", "reviewer.md"), GLOBAL);
  }

  function activate(): void {
    booted = makePi();
    subagentsExtension(booted.pi);
  }

  const saveTrust = (trusted: boolean) =>
    writeFileSync(join(agentDir(), "trust.json"), JSON.stringify({ [process.cwd()]: trusted, [env.dir]: trusted }));

  it("loads global agents only at activation, whatever pi persisted", () => {
    setup();
    saveTrust(true);
    writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    activate();

    expect(getAgentConfig("reviewer")?.source).toBe("global");
    expect(getAllTypes()).not.toContain("rogue");
    expect(typeList()).not.toContain("ROGUE");
    expect(typeParam()).not.toContain("rogue");
  });

  it("advertises project agents in description and subagent_type once session_start reports trust", async () => {
    setup();
    activate();
    await startSession(booted.lifecycle, true);

    expect(getAgentConfig("reviewer")?.source).toBe("project");
    expect(typeList()).toContain("project reviewer");
    expect(typeList()).toContain("- rogue: ROGUE project only");
    expect(typeParam()).toContain("rogue");
  });

  it("trusts the canonical answer over a saved distrust (--approve)", async () => {
    setup();
    saveTrust(false);
    activate();
    await startSession(booted.lifecycle, true);

    expect(getAgentConfig("reviewer")?.source).toBe("project");
    expect(typeList()).toContain("ROGUE project only");
  });

  it("trusts the canonical answer over a saved trust (--noapprove): no stale project metadata", async () => {
    setup();
    saveTrust(true);
    activate();
    await startSession(booted.lifecycle, false);

    expect(getAgentConfig("reviewer")?.source).toBe("global");
    expect(getAllTypes()).not.toContain("rogue");
    expect(typeList()).not.toContain("ROGUE");
    expect(typeList()).not.toContain("project reviewer");
    expect(typeParam()).not.toContain("rogue");
  });

  it("treats a session that does not answer as untrusted", async () => {
    setup();
    activate();
    await booted.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx());

    expect(getAgentConfig("reviewer")?.source).toBe("global");
    expect(typeList()).not.toContain("ROGUE");
  });

  it("follows a trust change on a later session_start, in both directions", async () => {
    setup();
    activate();
    await startSession(booted.lifecycle, true);
    expect(typeList()).toContain("ROGUE project only");

    await startSession(booted.lifecycle, false);
    expect(getAllTypes()).not.toContain("rogue");
    expect(typeList()).not.toContain("ROGUE");
    expect(typeParam()).not.toContain("rogue");

    await startSession(booted.lifecycle, true);
    expect(typeList()).toContain("ROGUE project only");
    expect(typeParam()).toContain("rogue");
  });

  it("re-registers Agent only when the model-visible text changed", async () => {
    setup();
    activate();
    const registered = () => booted.pi.registerTool.mock.calls.filter((c) => c[0].name === "Agent").length;
    expect(registered()).toBe(1);

    await startSession(booted.lifecycle, false);
    expect(registered()).toBe(1);
    await startSession(booted.lifecycle, true);
    expect(registered()).toBe(2);
    await startSession(booted.lifecycle, true);
    expect(registered()).toBe(2);
  });

  it("keeps non-type parameters intact across a re-registration", async () => {
    setup();
    activate();
    const before = Object.keys(agentTool().parameters.properties).sort();
    await startSession(booted.lifecycle, true);

    expect(Object.keys(agentTool().parameters.properties).sort()).toEqual(before);
    expect(agentTool().parameters.required).toEqual(["prompt", "description", "subagent_type"]);
    expect(typeof agentTool().execute).toBe("function");
  });

  describe("agent-tool-description.md", () => {
    const TEMPLATE = (word: string) => `${word}\n{{typeList}}`;

    function setupCustom(): void {
      setup({ settings: { toolDescriptionMode: "custom" } });
      writeFileSync(join(env.dir, ".pi", "agent-tool-description.md"), TEMPLATE("PROJECT TEMPLATE"));
    }

    it("is not read from an untrusted project, so it cannot leak project agents", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupCustom();
      activate();
      await startSession(booted.lifecycle, false);

      expect(typeList()).not.toContain("PROJECT TEMPLATE");
      expect(typeList()).not.toContain("ROGUE");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no agent-tool-description.md found"));
    });

    it("is used for a trusted project, with the canonical type list", async () => {
      setupCustom();
      activate();
      expect(typeList()).not.toContain("PROJECT TEMPLATE");
      await startSession(booted.lifecycle, true);

      expect(typeList()).toContain("PROJECT TEMPLATE");
      expect(typeList()).toContain("- rogue: ROGUE project only");
    });

    it("still honours a globally configured template while untrusted", async () => {
      setupCustom();
      writeFileSync(join(agentDir(), "agent-tool-description.md"), TEMPLATE("GLOBAL TEMPLATE"));
      activate();
      await startSession(booted.lifecycle, false);

      expect(typeList()).toContain("GLOBAL TEMPLATE");
      expect(typeList()).not.toContain("PROJECT TEMPLATE");
      expect(typeList()).not.toContain("ROGUE");
    });
  });
});
