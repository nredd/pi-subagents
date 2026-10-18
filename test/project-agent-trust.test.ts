// Project agent definitions (`<cwd>/.pi/agents`, `<cwd>/.agents/agents`) are
// project-supplied content, so they load only when pi trusts the project.
// Untrusted, they must not override a global or package agent, and a broken file
// in them must be ignored rather than parsed, warned about or thrown on. Global
// agents and globally configured packages stay available either way; packages
// configured only by the project are gated by the same decision.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";
import { resetPackageState, setProjectTrusted } from "../src/package-resources.js";

const agent = (description: string, extra = "") => `---\ndescription: ${description}\n${extra}---\nBody.\n`;

describe("project agent trust", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let pkgDir: string;
  let prevHome: string | undefined;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    resetPackageState();
    root = mkdtempSync(join(tmpdir(), "pi-agent-trust-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    pkgDir = join(root, "pkg", "agents");
    for (const dir of [cwd, join(agentDir, "agents"), pkgDir]) mkdirSync(dir, { recursive: true });
    prevHome = process.env.HOME;
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    resetPackageState();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function write(where: "global" | "package" | ".pi" | ".agents", name: string, content: string): string {
    const dir = where === "global" ? join(agentDir, "agents")
      : where === "package" ? pkgDir
      : join(cwd, where, "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(path, content);
    return path;
  }

  const load = (opts: { projectTrusted?: boolean } = {}, strict = false) =>
    loadCustomAgents(cwd, strict, { packageDirs: [pkgDir], ...opts });

  describe("untrusted", () => {
    it("does not let a .pi/agents file override a global agent", () => {
      write("global", "reviewer", agent("global"));
      write(".pi", "reviewer", agent("hostile"));

      const loaded = load({ projectTrusted: false }).get("reviewer");
      expect(loaded?.description).toBe("global");
      expect(loaded?.source).toBe("global");
    });

    it("does not let a .agents/agents file override a global agent", () => {
      write("global", "reviewer", agent("global"));
      write(".agents", "reviewer", agent("hostile"));

      expect(load({ projectTrusted: false }).get("reviewer")?.description).toBe("global");
    });

    it("does not let a project file override a package agent", () => {
      write("package", "researcher", agent("package"));
      write(".pi", "researcher", agent("hostile"));

      expect(load({ projectTrusted: false }).get("researcher")?.source).toBe("package");
    });

    it("loads no project-only agent from either root", () => {
      write(".pi", "only-pi", agent("p"));
      write(".agents", "only-ws", agent("w"));

      expect([...load({ projectTrusted: false }).keys()]).toEqual([]);
    });

    it("keeps global and globally configured package agents available", () => {
      write("global", "g", agent("global"));
      write("package", "p", agent("package"));
      write(".pi", "h", agent("hostile"));

      expect([...load({ projectTrusted: false }).keys()].sort()).toEqual(["g", "p"]);
    });

    it("does not let a project `enabled: false` file disable a global agent", () => {
      write("global", "reviewer", agent("global"));
      write(".pi", "reviewer", agent("off", "enabled: false\n"));

      expect(load({ projectTrusted: false }).get("reviewer")?.enabled).toBe(true);
    });

    it("ignores a malformed project file without warning or throwing, even under strict", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      write("global", "reviewer", agent("global"));
      write(".pi", "reviewer", "---\nname: [unclosed\n---\nBody.");
      write(".agents", "broken", "---\nname: [unclosed\n---\nBody.");

      for (const strict of [false, true]) {
        const loaded = load({ projectTrusted: false }, strict);
        expect(loaded.get("reviewer")?.description).toBe("global");
        expect(loaded.has("broken")).toBe(false);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it("ignores an unreadable project agent path without side effects", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mkdirSync(join(cwd, ".pi", "agents", "dir.md"), { recursive: true });

      expect(() => load({ projectTrusted: false }, true)).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("trusted", () => {
    it("lets a project file override a global agent, which overrides a package agent", () => {
      write("package", "a", agent("package"));
      write("global", "a", agent("global"));
      write("package", "b", agent("package"));
      write("global", "b", agent("global"));
      write(".pi", "b", agent("project"));

      const loaded = load({ projectTrusted: true });
      expect(loaded.get("a")?.source).toBe("global");
      expect(loaded.get("b")?.source).toBe("project");
      expect(loaded.get("b")?.description).toBe("project");
    });

    it("loads both project roots, with .pi/agents winning a clash", () => {
      write(".agents", "dupe", agent("workspace"));
      write(".pi", "dupe", agent("pi"));
      write(".agents", "ws-only", agent("workspace"));
      write(".pi", "pi-only", agent("pi"));

      const loaded = load({ projectTrusted: true });
      expect(loaded.get("dupe")?.description).toBe("pi");
      expect(loaded.has("ws-only")).toBe(true);
      expect(loaded.has("pi-only")).toBe(true);
    });

    it("still fails a strict load on a malformed project file", () => {
      write(".pi", "broken", "---\nname: [unclosed\n---\nBody.");

      expect(() => load({ projectTrusted: true }, true)).toThrow(/broken\.md/);
    });
  });

  describe("project-scoped packages", () => {
    type Declared = "dir" | "file" | "dir-with-exclusion";

    /** A package that only the project's `.pi/settings.json` configures. */
    function configureProjectPackage(declared: Declared = "dir"): void {
      const pkg = join(root, "project-pkg");
      mkdirSync(join(pkg, "agents"), { recursive: true });
      const entries = {
        dir: ["./agents"],
        file: ["./agents/from-pkg.md"],
        "dir-with-exclusion": ["./agents", "!./agents/wip.md"],
      }[declared];
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "project-pkg", pi: { subagents: entries } }));
      writeFileSync(join(pkg, "agents", "from-pkg.md"), agent("project package"));
      writeFileSync(join(pkg, "agents", "wip.md"), agent("work in progress"));
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
    }

    describe.each(["dir", "file"] as const)("declared as a %s", declared => {
      it("rejects the package's agents on explicit false while the session state is trusted", () => {
        configureProjectPackage(declared);
        setProjectTrusted(true);

        expect(loadCustomAgents(cwd, false, { projectTrusted: false }).has("from-pkg")).toBe(false);
      });

      it("loads the package's agents on explicit true while the session state is untrusted", () => {
        configureProjectPackage(declared);
        setProjectTrusted(false);

        const loaded = loadCustomAgents(cwd, false, { projectTrusted: true }).get("from-pkg");
        expect(loaded?.description).toBe("project package");
        expect(loaded?.source).toBe("package");
      });

      it("follows the session state when no option is given", () => {
        configureProjectPackage(declared);
        expect(loadCustomAgents(cwd).has("from-pkg")).toBe(false);
        setProjectTrusted(true);
        expect(loadCustomAgents(cwd).has("from-pkg")).toBe(true);
      });
    });

    it("applies the package's `!` exclusions on explicit true while the session state is untrusted", () => {
      configureProjectPackage("dir-with-exclusion");
      setProjectTrusted(false);

      const loaded = loadCustomAgents(cwd, false, { projectTrusted: true });
      expect(loaded.has("from-pkg")).toBe(true);
      expect(loaded.has("wip")).toBe(false);
    });

    it("loads neither project agent files nor project packages on explicit false, and both on explicit true", () => {
      configureProjectPackage();
      write(".pi", "from-file", agent("project file"));
      setProjectTrusted(true);
      expect([...loadCustomAgents(cwd, false, { projectTrusted: false }).keys()]).toEqual([]);

      setProjectTrusted(false);
      expect([...loadCustomAgents(cwd, false, { projectTrusted: true }).keys()].sort()).toEqual(["from-file", "from-pkg", "wip"]);
    });
  });

  describe("trust resolution", () => {
    it("fails closed when no trust answer was ever recorded", () => {
      write("global", "reviewer", agent("global"));
      write(".pi", "reviewer", agent("hostile"));

      expect(load().get("reviewer")?.description).toBe("global");
    });

    it("follows the session trust state, including a change after a load", () => {
      write("global", "reviewer", agent("global"));
      write(".pi", "reviewer", agent("project"));

      expect(load().get("reviewer")?.description).toBe("global");
      setProjectTrusted(true);
      expect(load().get("reviewer")?.description).toBe("project");
      setProjectTrusted(false);
      expect(load().get("reviewer")?.description).toBe("global");
    });

    it("lets an explicit option beat the session state in both directions", () => {
      write("global", "reviewer", agent("global"));
      write(".pi", "reviewer", agent("project"));

      setProjectTrusted(true);
      expect(load({ projectTrusted: false }).get("reviewer")?.description).toBe("global");
      setProjectTrusted(false);
      expect(load({ projectTrusted: true }).get("reviewer")?.description).toBe("project");
    });
  });
});
