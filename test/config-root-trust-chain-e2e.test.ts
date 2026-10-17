/**
 * config-root-trust-chain-e2e.test.ts — a custom-cwd spawn keeps the PARENT's
 * config root (`configCwd`) and that root's trust decision, across every later
 * nested spawn, without trusting the custom execution cwd. Real pi loader, real
 * extension, real runAgent/AgentManager/nested tools, faux model.
 *
 * The child session of a custom-cwd spawn deliberately reports its own cwd as
 * untrusted, so a grandchild that re-derived trust from that session would hide
 * the trusted config root's agents from its nested registry.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const LEAF_MARKER = "LEAF-REACHED-THE-TOP";
const HOSTILE = "HOSTILE-EXECUTION-CWD";
/** relay-1 -> relay-2 -> relay-3 -> leaf: four generations below the host session. */
const CHAIN = ["relay-1", "relay-2", "relay-3", "leaf"];

function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function agentResult(context: Context): string | undefined {
  const result = [...context.messages]
    .reverse()
    .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");
  if (!result) return undefined;
  return ((result.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function writeAgent(root: string, name: string, extra: string, body: string): void {
  const dir = join(root, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\nextensions: false\n${extra}---\n${body}\n`);
}

describe("config-root trust survives nested spawns after a custom-cwd spawn (faux model)", () => {
  let run: PrintModeRun | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function chain(projectTrusted: boolean): Promise<{ text: string; hostileSeen: boolean; reached: string[] }> {
    const config = mkdtempSync(join(tmpdir(), "config-root-"));
    const work = mkdtempSync(join(tmpdir(), "exec-cwd-"));
    dirs.push(config, work);
    CHAIN.slice(0, -1).forEach((name, i) => {
      writeAgent(config, name, `allowed_subagents: ${CHAIN[i + 1]}\n`, `You are ${name}.`);
    });
    writeAgent(config, "leaf", "", "You are leaf.");
    // Raise the nesting cap past the chain length. Read at extension load, which
    // happens before the runner's `beforeRun`, so it has to be on disk already.
    writeFileSync(join(config, ".pi", "subagents.json"), JSON.stringify({ maxSubagentDepth: 5 }));
    // The execution cwd is never trusted: nothing in it may load.
    writeAgent(work, "leaf", "", HOSTILE);

    let hostileSeen = false;
    const reached: string[] = [];
    const respond = (context: Context): FauxReply => {
      if (JSON.stringify(context.messages).includes(HOSTILE)) hostileSeen = true;
      const text = firstUserText(context);
      const index = CHAIN.findIndex((name) => text === `Task for ${name}.`);
      if (index === CHAIN.length - 1) {
        reached.push("leaf");
        return LEAF_MARKER;
      }
      if (index >= 0) {
        const inner = agentResult(context);
        if (inner !== undefined) return inner;
        reached.push(CHAIN[index]);
        return agentCall({
          subagent_type: CHAIN[index + 1],
          description: "relay",
          prompt: `Task for ${CHAIN[index + 1]}.`,
        });
      }
      const inner = agentResult(context);
      if (inner !== undefined) return `host saw: ${inner}`;
      return agentCall({
        subagent_type: CHAIN[0],
        description: "start",
        prompt: `Task for ${CHAIN[0]}.`,
        cwd: work,
        run_in_background: false,
      });
    };

    run = await runPrintMode({
      prompt: "Go.",
      cwd: config,
      respond,
      live: false,
      projectTrusted,
    });
    return { text: run.responseText, hostileSeen, reached };
  }

  it("reaches a leaf four generations down with a trusted config root and an untrusted custom cwd", async () => {
    const { text, hostileSeen, reached } = await chain(true);
    expect(reached).toEqual(CHAIN);
    expect(text).toContain(LEAF_MARKER);
    expect(hostileSeen).toBe(false);
  });

  it("fails closed when the config root is not trusted: no project agent is reachable", async () => {
    const { text, reached } = await chain(false);
    // Untrusted: the project's `relay-1` is unknown, so nothing below it can run.
    expect(reached).not.toContain("relay-2");
    expect(text).not.toContain(LEAF_MARKER);
  });
});
