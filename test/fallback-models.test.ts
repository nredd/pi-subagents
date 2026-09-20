import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFallbackModelChain,
  chooseQuotaModel,
  resolveEffectiveFallbackModels,
  resolveFallbackModelSpec,
} from "../src/fallback-models.js";
import type { ModelRegistry } from "../src/model-resolver.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex" },
];

function makeRegistry(models = MODELS): ModelRegistry {
  return {
    find: (provider, modelId) => models.find(m => m.provider === provider && m.id === modelId),
    getAll: () => models,
    getAvailable: () => models,
  };
}

describe("resolveFallbackModelSpec", () => {
  it("returns [] when nothing at all was declared", () => {
    expect(resolveFallbackModelSpec({})).toEqual([]);
  });

  it("falls through to global when frontmatter and call are absent", () => {
    expect(resolveFallbackModelSpec({ global: ["a/x"] })).toEqual(["a/x"]);
  });

  it("call beats global", () => {
    expect(resolveFallbackModelSpec({ call: ["a/call"], global: ["a/global"] })).toEqual(["a/call"]);
  });

  it("frontmatter beats call and global", () => {
    expect(
      resolveFallbackModelSpec({ agentFrontmatter: ["a/fm"], call: ["a/call"], global: ["a/global"] }),
    ).toEqual(["a/fm"]);
  });

  it("an explicit empty frontmatter list disables call and global — no fallthrough", () => {
    expect(resolveFallbackModelSpec({ agentFrontmatter: [], call: ["a/call"], global: ["a/global"] })).toEqual([]);
  });

  it("an explicit empty call list disables global — no fallthrough", () => {
    expect(resolveFallbackModelSpec({ call: [], global: ["a/global"] })).toEqual([]);
  });
});

describe("buildFallbackModelChain", () => {
  const primary = "anthropic/claude-opus-4-6";

  it("always puts the primary first, even with no candidates", () => {
    const { chain, warnings } = buildFallbackModelChain({
      primaryModelId: primary,
      candidates: [],
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
      fromFrontmatter: false,
    });
    expect(chain).toEqual([primary]);
    expect(warnings).toEqual([]);
  });

  it("resolves and appends valid candidates in order", () => {
    const { chain, warnings } = buildFallbackModelChain({
      primaryModelId: primary,
      candidates: ["openai-codex/gpt-5.6-terra", "anthropic/claude-sonnet-4-6"],
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
      fromFrontmatter: false,
    });
    expect(chain).toEqual([primary, "openai-codex/gpt-5.6-terra", "anthropic/claude-sonnet-4-6"]);
    expect(warnings).toEqual([]);
  });

  it("de-duplicates a candidate that resolves to the primary", () => {
    const { chain } = buildFallbackModelChain({
      primaryModelId: primary,
      candidates: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
      fromFrontmatter: false,
    });
    expect(chain).toEqual([primary, "anthropic/claude-sonnet-4-6"]);
  });

  it("de-duplicates two candidates that resolve to the same model (case-insensitive)", () => {
    const { chain } = buildFallbackModelChain({
      primaryModelId: primary,
      candidates: ["anthropic/claude-sonnet-4-6", "Anthropic/Claude-Sonnet-4-6"],
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
      fromFrontmatter: false,
    });
    expect(chain).toEqual([primary, "anthropic/claude-sonnet-4-6"]);
  });

  it("drops an unresolvable candidate with a warning, keeping the rest of the chain", () => {
    const { chain, warnings } = buildFallbackModelChain({
      primaryModelId: primary,
      candidates: ["nonexistent/model-xyz", "anthropic/claude-haiku-4-5"],
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
      fromFrontmatter: false,
    });
    expect(chain).toEqual([primary, "anthropic/claude-haiku-4-5"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nonexistent/model-xyz");
    expect(warnings[0]).toContain("dropped");
  });

  it("never throws and never empties the chain below the primary", () => {
    const { chain } = buildFallbackModelChain({
      primaryModelId: primary,
      candidates: ["", "garbage", "also-garbage"],
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
      fromFrontmatter: false,
    });
    expect(chain).toEqual([primary]);
  });
});

describe("buildFallbackModelChain — scopeModels integration", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-fallback-scope-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fallback-scope-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setScopeModelsEnabled(true);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"] }),
    );
  });

  afterEach(() => {
    setScopeModelsEnabled(false);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("drops a caller-supplied out-of-scope candidate (error verdict)", () => {
    const { chain, warnings } = buildFallbackModelChain({
      primaryModelId: "anthropic/claude-opus-4-6",
      candidates: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
      modelRegistry: makeRegistry(),
      cwd: projectDir,
      fromFrontmatter: false,
    });
    expect(chain).toEqual(["anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"]);
    expect(warnings.some(w => w.includes("claude-sonnet-4-6"))).toBe(true);
  });

  it("keeps a frontmatter-pinned out-of-scope candidate, with a warning", () => {
    const { chain, warnings } = buildFallbackModelChain({
      primaryModelId: "anthropic/claude-opus-4-6",
      candidates: ["anthropic/claude-sonnet-4-6"],
      modelRegistry: makeRegistry(),
      cwd: projectDir,
      fromFrontmatter: true,
    });
    expect(chain).toEqual(["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"]);
    expect(warnings).toHaveLength(1);
  });
});

describe("chooseQuotaModel", () => {
  const chain = [
    { provider: "anthropic", id: "claude-opus-4-6" },
    { provider: "openai-codex", id: "gpt-5.6-terra" },
  ];

  it("uses the first candidate not blocked by fresh included quota", () => {
    const result = chooseQuotaModel(chain, model => model.provider === "anthropic"
      ? { block: true, resetAt: 2_000 }
      : { block: false });

    expect(result.selected).toBe(chain[1]);
    expect(result.blocked).toHaveLength(1);
  });

  it("fails open on an advisory candidate", () => {
    const result = chooseQuotaModel(chain, () => ({ block: false }));

    expect(result.selected).toBe(chain[0]);
    expect(result.blocked).toEqual([]);
  });

  it("reports the earliest known reset when every candidate is blocked", () => {
    const result = chooseQuotaModel(chain, model => ({
      block: true,
      resetAt: model.provider === "anthropic" ? 5_000 : 3_000,
    }));

    expect(result.selected).toBeUndefined();
    expect(result.earliestResetAt).toBe(3_000);
    expect(result.blocked).toHaveLength(2);
  });

  it("leaves the reset unknown when no blocked decision has one", () => {
    const result = chooseQuotaModel(chain, () => ({ block: true }));

    expect(result.selected).toBeUndefined();
    expect(result.earliestResetAt).toBeUndefined();
  });
});

describe("resolveEffectiveFallbackModels", () => {
  it("returns empty when there is no primary model to anchor a chain to", () => {
    expect(
      resolveEffectiveFallbackModels({
        primaryModel: undefined,
        sources: { global: ["anthropic/claude-sonnet-4-6"] },
        modelRegistry: makeRegistry(),
        cwd: "/tmp",
      }),
    ).toEqual({ fallbackModels: [], warnings: [] });
  });

  it("returns empty when no source declared any candidates", () => {
    expect(
      resolveEffectiveFallbackModels({
        primaryModel: { provider: "anthropic", id: "claude-opus-4-6" },
        sources: {},
        modelRegistry: makeRegistry(),
        cwd: "/tmp",
      }),
    ).toEqual({ fallbackModels: [], warnings: [] });
  });

  it("resolves the precedence-selected source into the fallback tail (primary excluded)", () => {
    const result = resolveEffectiveFallbackModels({
      primaryModel: { provider: "anthropic", id: "claude-opus-4-6" },
      sources: { call: ["openai-codex/gpt-5.6-terra"], global: ["anthropic/claude-haiku-4-5"] },
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
    });
    expect(result).toEqual({ fallbackModels: ["openai-codex/gpt-5.6-terra"], warnings: [] });
  });

  it("an explicit-empty frontmatter chain yields no fallback at all", () => {
    const result = resolveEffectiveFallbackModels({
      primaryModel: { provider: "anthropic", id: "claude-opus-4-6" },
      sources: { agentFrontmatter: [], call: ["openai-codex/gpt-5.6-terra"] },
      modelRegistry: makeRegistry(),
      cwd: "/tmp",
    });
    expect(result).toEqual({ fallbackModels: [], warnings: [] });
  });
});
