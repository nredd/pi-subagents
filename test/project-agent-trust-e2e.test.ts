/**
 * project-agent-trust-e2e.test.ts — a project `.pi/agents` file that redefines a
 * built-in type must not reach a child session when pi does not trust the
 * project, and must when it does. Real pi loader, real extension, real runAgent,
 * faux model; the trust answer comes from the host session through
 * `ctx.isProjectTrusted()`, the same path a real `--no-approve` run takes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const HOSTILE = "HOSTILE-PROJECT-OVERRIDE";
const CHILD_TASK = "Do the scouting task.";

describe("project agent trust, real session (faux model)", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  /** Run a parent that spawns `Explore` and return the child's serialized transcript. */
  async function childTranscript(projectTrusted: boolean): Promise<string | undefined> {
    cwd = mkdtempSync(join(tmpdir(), "project-agent-trust-e2e-"));
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Explore.md"), `---\ndescription: hostile\ntools: read\nextensions: false\n---\n${HOSTILE}\n`);

    let childPrompt: string | undefined;
    const respond = (context: Context): FauxReply => {
      // The child's system prompt rides in a `system` message, not `context.systemPrompt`.
      const transcript = JSON.stringify(context.messages);
      if (transcript.includes('active_agent name=\\"Explore\\"')) {
        childPrompt = transcript;
        return "child done";
      }
      const spawned = context.messages.some((m) => m.role === "toolResult");
      if (spawned) return "parent done";
      return agentCall({
        subagent_type: "Explore",
        description: "scout",
        prompt: CHILD_TASK,
        run_in_background: false,
      });
    };

    run = await runPrintMode({ prompt: "Scout it.", cwd, respond, live: false, projectTrusted });
    return childPrompt;
  }

  /** The `Agent` tool as the provider saw it on the FIRST turn, project-only agent included or not. */
  async function firstTurnAgentTool(projectTrusted: boolean): Promise<string> {
    cwd = mkdtempSync(join(tmpdir(), "project-agent-trust-e2e-"));
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rogue-only.md"), "---\ndescription: ROGUE-ADVERTISED\ntools: read\n---\nBody.\n");
    let seen: string | undefined;
    const respond = (context: Context): FauxReply => {
      seen ??= JSON.stringify(getCurrentTools(context.messages).find((t) => t.name === "Agent"));
      return "done";
    };
    run = await runPrintMode({ prompt: "Hi.", cwd, respond, live: false, projectTrusted });
    return seen ?? "";
  }

  it("advertises a project-only agent on the first provider turn when trusted", async () => {
    const tool = await firstTurnAgentTool(true);
    expect(tool).toContain("ROGUE-ADVERTISED");
    expect(tool).toContain("rogue-only");
  });

  it("advertises nothing from an untrusted project on the first provider turn", async () => {
    const tool = await firstTurnAgentTool(false);
    expect(tool).not.toContain("ROGUE-ADVERTISED");
    expect(tool).not.toContain("rogue-only");
  });

  it("runs the built-in Explore when the project is untrusted", async () => {
    const transcript = await childTranscript(false);
    expect(transcript).toBeDefined();
    expect(transcript).not.toContain(HOSTILE);
  });

  it("runs the project's Explore override when the project is trusted", async () => {
    const transcript = await childTranscript(true);
    expect(transcript).toContain(HOSTILE);
  });
});
