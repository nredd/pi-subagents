/**
 * subagents-nested-print-mode-e2e.test.ts — remaining real-session coverage for
 * opt-in nested delegation after #164 landed.
 *
 * `test/nested-delegation-e2e.test.ts` already pins the happy path (tool
 * admission + two-hop foreground return + background poll/transcript). This
 * file covers the production-boundary cases that suite still leaves open:
 * default-off injection, depth-cap tool stripping, background parent holds
 * while a child nests, and cross-parent ownership denial against the published
 * root manager lifecycle.
 *
 * Extracted from codesoda/pi-subagents#2 (test-only follow-up to #164) and
 * reconciled with the merged #164 frontmatter contract (`allowed_subagents`
 * opt-in; no nested tools injected at the depth cap).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import {
  agentCall,
  type FauxResponder,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const NESTED_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

function userPrompt(ctx: Context): string {
  for (const message of ctx.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find(
        (block: { type?: string; text?: string }) => block.type === "text",
      ) as { text?: string } | undefined;
      if (text?.text) return text.text;
    }
  }
  return "";
}

function tools(ctx: Context): string[] {
  return (ctx.tools ?? []).map((tool) => tool.name);
}

function toolResults(ctx: Context, name: string): string[] {
  return ctx.messages.flatMap((message) => {
    if (
      message.role !== "toolResult" ||
      (message as { toolName?: string }).toolName !== name
    ) {
      return [];
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return [
      content
        .map((block: { type?: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : "",
        )
        .join(""),
    ];
  });
}

function nestedToolsIn(toolNames: string[] | undefined): string[] {
  return (toolNames ?? []).filter((name) => NESTED_TOOLS.includes(name));
}

function lastToolResult(ctx: Context, name: string): string {
  const results = toolResults(ctx, name);
  return results[results.length - 1] ?? "";
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ToolCall {
  return { type: "toolCall", id, name, arguments: args } as ToolCall;
}

function writeAgents(cwd: string, agents: Record<string, string>): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, frontmatter] of Object.entries(agents)) {
    writeFileSync(
      join(dir, `${name}.md`),
      `---\ndescription: ${name}\n${frontmatter}---\n${name} agent\n`,
    );
  }
}

async function runWithAgents(
  agents: Record<string, string>,
  respond: FauxResponder,
  options: { prompt: string; maxModelCalls?: number; hold?: boolean } = {
    prompt: "root",
  },
): Promise<{ run: PrintModeRun; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-nested-e2e-"));
  writeAgents(cwd, agents);
  const run = await runPrintMode({
    ...options,
    cwd,
    respond,
    // Pinned faux: every case here scripts exact tool calls, so the pre-publish
    // smoke's global `PI_E2E_LIVE=1` must not swap a real model in.
    live: false,
    beforeRun: () => registerAgents(loadCustomAgents(cwd)),
  });
  return { run, cwd };
}

describe("PR #164 nested agents through the real print-mode boundary", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("does not inject nested orchestration tools into a custom agent by default", async () => {
    const observed = new Map<string, string[]>();
    ({ run, cwd } = await runWithAgents(
      { plain: "" },
      (ctx) => {
        const route = userPrompt(ctx);
        if (route === "plain-child") {
          observed.set(route, tools(ctx));
          return "PLAIN_CHILD_RESULT";
        }
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "plain",
            description: "plain child",
            prompt: "plain-child",
            run_in_background: false,
          });
        }
        return lastToolResult(ctx, "Agent");
      },
      { prompt: "root-default" },
    ));

    expect(run.responseText).toContain("PLAIN_CHILD_RESULT");
    expect(observed.get("plain-child")).toBeDefined();
    expect(nestedToolsIn(observed.get("plain-child"))).toEqual([]);
  });

  it("strips nested tools at the depth cap instead of injecting always-failing ones", async () => {
    // Default maxSubagentDepth is 2: main(0) → level_one(1) → level_two(2).
    // #164 injects nested tools only while depth < max, so the agent at the cap
    // never sees Agent/get/steer even when it opts in via allowed_subagents.
    const observed = new Map<string, string[]>();
    ({ run, cwd } = await runWithAgents(
      {
        level_one: "allowed_subagents: level_two\n",
        level_two: "allowed_subagents: level_three\n",
        level_three: "",
      },
      (ctx) => {
        const route = userPrompt(ctx);
        observed.set(route, tools(ctx));
        if (route === "level_three-child") return "UNEXPECTED_LEVEL_THREE";
        if (route === "level_two-child") {
          const nested = nestedToolsIn(tools(ctx));
          // Cap agents must complete directly — they have no nested tools.
          return `AT_CAP tools=${nested.length === 0 ? "none" : nested.join(",")}`;
        }
        if (route === "level_one-child") {
          if (toolResults(ctx, "Agent").length === 0) {
            return agentCall({
              subagent_type: "level_two",
              description: "allowed level",
              prompt: "level_two-child",
              run_in_background: false,
            });
          }
          return lastToolResult(ctx, "Agent");
        }
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "level_one",
            description: "recursive chain",
            prompt: "level_one-child",
            run_in_background: false,
          });
        }
        return lastToolResult(ctx, "Agent");
      },
      { prompt: "root-depth", maxModelCalls: 24 },
    ));

    expect(run.responseText).toContain("AT_CAP tools=none");
    expect(observed.get("level_one-child")).toEqual(
      expect.arrayContaining(NESTED_TOOLS),
    );
    expect(nestedToolsIn(observed.get("level_two-child"))).toEqual([]);
    expect(observed.has("level_three-child")).toBe(false);
  });

  it("holds a background child while it performs real nested delegation", async () => {
    const calls = new Map<string, number>();
    ({ run, cwd } = await runWithAgents(
      {
        background_delegator: "allowed_subagents: background_grandchild\n",
        background_grandchild: "",
      },
      async (ctx) => {
        const route = userPrompt(ctx);
        calls.set(route, (calls.get(route) ?? 0) + 1);
        if (route === "background-grandchild-child") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return "BACKGROUND_NESTED_RESULT";
        }
        if (route === "background-delegator-child") {
          if (toolResults(ctx, "Agent").length === 0) {
            return agentCall({
              subagent_type: "background_grandchild",
              description: "nested foreground work",
              prompt: "background-grandchild-child",
              run_in_background: false,
            });
          }
          return lastToolResult(ctx, "Agent");
        }
        const agents = toolResults(ctx, "Agent");
        if (agents.length === 0) {
          return agentCall({
            subagent_type: "background_delegator",
            description: "background nested work",
            prompt: "background-delegator-child",
            run_in_background: true,
          });
        }
        if (toolResults(ctx, "get_subagent_result").length === 0) {
          const id = agents[0].match(/Agent ID: ([^\s]+)/)?.[1];
          if (!id) throw new Error(`No background agent ID in: ${agents[0]}`);
          return toolCall(
            "get_subagent_result",
            { agent_id: id, wait: true },
            "get-background-result",
          );
        }
        return lastToolResult(ctx, "get_subagent_result");
      },
      { prompt: "root-background", maxModelCalls: 24 },
    ));

    expect(run.responseText).toContain("BACKGROUND_NESTED_RESULT");
    expect(calls.get("background-delegator-child")).toBe(2);
    expect(calls.get("background-grandchild-child")).toBe(1);
    expect(
      run.parentSession.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) =>
              block.type === "toolCall" && block.name === "get_subagent_result",
          ),
      ),
    ).toBe(true);
  });

  it("refuses a nested background launch with an explanation the model can act on", async () => {
    let refusal = "";
    ({ run, cwd } = await runWithAgents(
      { delegator: "allowed_subagents: all\n", leaf: "" },
      async (ctx) => {
        const route = userPrompt(ctx);
        if (route === "leaf-child") return "LEAF_SHOULD_NOT_RUN";
        if (route === "delegator-child") {
          const agents = toolResults(ctx, "Agent");
          if (agents.length === 0) {
            return agentCall({
              subagent_type: "leaf",
              description: "nested background work",
              prompt: "leaf-child",
              run_in_background: true,
            });
          }
          refusal = agents[0];
          return "DELEGATOR_DONE";
        }
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "delegator",
            description: "delegate",
            prompt: "delegator-child",
            run_in_background: false,
          });
        }
        return lastToolResult(ctx, "Agent");
      },
      { prompt: "root-nested-background", maxModelCalls: 16 },
    ));

    expect(refusal).toContain("Background agents are not available inside a subagent");
    expect(run.responseText).toContain("DELEGATOR_DONE");
  });
});
