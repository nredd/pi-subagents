/** Real git worktrees and real child tools, hosted by core's exported in-process session harness. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";
import { answer, calls, outcomes, ScenarioSession, spawn, text } from "./helpers/scenario-session.js";

const MARKER_FILE = "agent-work.txt";
const CHILD_MARKER = "CHILD-EDITED-ITS-TREE";
let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  setWorktreeIsolationEnabled(true);
});

/** Fixture identity and signing never read the developer's git configuration. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** A committed pkg subtree, so isolation has a HEAD and subdirectory scoping to preserve. */
function repo(): string {
  const path = join(fixture.root, "code", "target");
  mkdirSync(join(path, "pkg"), { recursive: true });
  git(path, "init", "-q");
  git(path, "config", "user.name", "h");
  git(path, "config", "user.email", "h@h");
  git(path, "config", "commit.gpgsign", "false");
  writeFileSync(join(path, "pkg", "index.ts"), "export {};\n");
  git(path, "add", "pkg/index.ts");
  git(path, "commit", "-qm", "initial");
  return path;
}

/** The only writer is the child's real built-in write tool. */
async function run(extra: Record<string, unknown> = {}, cwd = fixture.cwd) {
  fixture.physical("kid", "child", [calls({ name: "write", args: { path: MARKER_FILE, content: "isolated\n" } }), answer(CHILD_MARKER)]);
  const h = await fixture.start({ harness: { cwd } });
  h.setResponses([calls(spawn("worktree work", { prompt: "Create the marker file.", run_in_background: false, isolation: "worktree", ...extra })), context => answer(`parent saw: ${context.messages.filter(m => m.role === "toolResult").map(text).join("\n")}`)]);
  await h.session.prompt("Delegate the work.");
  expect(outcomes(h, "Agent")).toHaveLength(1);
  const result = outcomes(h, "Agent")[0];
  if (!result) throw new Error("No Agent outcome");
  return { h, result };
}

/** The branch is the surviving artifact, never the removed copy. */
function branchOf(result: string): string {
  const branch = result.match(/Changes saved to branch `(pi-agent-[^`]+)`/)?.[1];
  expect(branch).toBeTruthy();
  if (!branch) throw new Error(result);
  expect(result).toContain(`git merge ${branch}`);
  return branch;
}

describe("worktree isolation e2e (real git, real pi-mono, faux model)", () => {
  it("runs the child in the copy and lands its changes on a branch, not the main checkout", async () => {
    fixture = new ScenarioSession();
    const target = repo();
    process.chdir(target);
    const { result } = await run({}, target);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(CHILD_MARKER);
    expect(existsSync(join(target, MARKER_FILE))).toBe(false);
    const branch = branchOf(result.text);
    expect(git(target, "branch", "--list", branch)).toContain(branch);
    expect(git(target, "ls-tree", "--name-only", branch)).toContain(MARKER_FILE);
    expect(git(target, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it.each(["absolute", "home"])("isolates a repo other than the session cwd when the caller names it as `cwd` (%s)", async kind => {
    fixture = new ScenarioSession();
    const target = repo();
    expect(() => git(fixture.cwd, "rev-parse", "--is-inside-work-tree")).toThrow();
    const { h, result } = await run({ cwd: kind === "home" ? "~/code/target/pkg" : join(target, "pkg") });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(CHILD_MARKER);
    expect(result.text).toContain(`in \`${realpathSync(target)}\``);
    const branch = branchOf(result.text);
    expect(h.session.messages.filter(m => m.role === "assistant").map(text).some(t => t.includes(CHILD_MARKER))).toBe(true);
    expect(git(target, "ls-tree", "-r", "--name-only", branch).split("\n")).toContain(`pkg/${MARKER_FILE}`);
    expect(existsSync(join(fixture.cwd, MARKER_FILE))).toBe(false);
    expect(existsSync(join(target, "pkg", MARKER_FILE))).toBe(false);
    expect(git(target, "status", "--porcelain")).toBe("");
    expect(git(target, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("names the directory and cause when the session cwd is not a repo", async () => {
    fixture = new ScenarioSession();
    const { result } = await run();
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(CHILD_MARKER);
    expect(result.text).toContain(`${fixture.cwd} is not inside a git repository`);
    expect(result.text).toContain("pass its path as the `Agent` tool's `cwd`");
    expect(existsSync(join(fixture.cwd, MARKER_FILE))).toBe(false);
  });

  it("downgrades to the main checkout when the project set worktreeIsolation: false", async () => {
    fixture = new ScenarioSession({ worktreeIsolation: false });
    const target = repo();
    const { result } = await run({ cwd: target });
    expect(result.text).toContain(CHILD_MARKER);
    expect(existsSync(join(target, MARKER_FILE))).toBe(true);
    expect(git(target, "branch", "--list", "pi-agent-*")).toBe("");
    expect(git(target, "worktree", "list").split("\n")).toHaveLength(1);
    expect(result.text).not.toContain("Changes saved to branch");
  });
});
