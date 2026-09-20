/**
 * fallback-models.ts — ordered fallback model chains for quota-aware dispatch.
 *
 * A chain has up to three declared sources, highest precedence first:
 *   1. Agent frontmatter (`fallback_models:`) — author-pinned, like `model:`.
 *   2. The caller's tool/RPC/workflow parameter.
 *   3. The global `quotaFallbackModels` setting.
 *
 * Precedence is "first DEFINED source wins", not a merge — the same rule
 * `fallbackSubagent` and `model:` already use elsewhere in this codebase. A
 * source counts as defined the moment it is present, even as an empty list:
 * an agent file that writes `fallback_models: []` (or `none`) is declaring "no
 * fallback for this agent", and that must not fall through to the caller's or
 * the project's default the way an *absent* field would. `resolveFallbackModelSpec`
 * is the one place that distinction is made; every caller downstream sees only
 * the resolved list.
 *
 * `buildFallbackModelChain` turns that raw spec into the chain a spawn actually
 * uses: the already-resolved primary model first, then each candidate run
 * through the same resolution (`resolveModel`) and scope validation
 * (`checkModelScope`) the primary itself was subject to, de-duplicated against
 * everything already in the chain. A candidate that fails either check is
 * dropped with a warning rather than failing the spawn — a fallback is an
 * option, not a requirement, so one bad entry should not block dispatch on the
 * model that already resolved.
 */

import type { ModelRegistryRef } from "./enabled-models.js";
import { describeModel, type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope, type ModelScopeVerdict } from "./model-scope.js";
import type { QuotaExhaustionPolicy } from "./settings.js";

const DEFAULT_QUOTA_WAIT_TIMEOUT_MINUTES = 7 * 24 * 60;

let quotaFallbackModels: string[] | undefined;
let quotaExhaustionPolicy: QuotaExhaustionPolicy = "fail";
let quotaWaitTimeoutMinutes = DEFAULT_QUOTA_WAIT_TIMEOUT_MINUTES;

/** Read the configured machine/project fallback chain without exposing mutable state. */
export function getQuotaFallbackModels(): string[] | undefined {
  return quotaFallbackModels === undefined ? undefined : [...quotaFallbackModels];
}

/** Replace the configured fallback chain; explicit empty remains distinct from unset. */
export function setQuotaFallbackModels(models: string[] | undefined): void {
  quotaFallbackModels = models === undefined ? undefined : [...models];
}

export function getQuotaExhaustionPolicy(): QuotaExhaustionPolicy {
  return quotaExhaustionPolicy;
}

export function setQuotaExhaustionPolicy(policy: QuotaExhaustionPolicy | undefined): void {
  quotaExhaustionPolicy = policy ?? "fail";
}

export function getQuotaWaitTimeoutMinutes(): number {
  return quotaWaitTimeoutMinutes;
}

export function setQuotaWaitTimeoutMinutes(minutes: number | undefined): void {
  quotaWaitTimeoutMinutes = Number.isInteger(minutes) && (minutes ?? 0) >= 1
    ? (minutes as number)
    : DEFAULT_QUOTA_WAIT_TIMEOUT_MINUTES;
}

/** The three possible sources of a fallback chain, in precedence order. */
export interface FallbackModelSources {
  /** Agent frontmatter's `fallback_models:`. `undefined` = not declared. */
  agentFrontmatter?: string[];
  /** The caller's `fallback_models` parameter. `undefined` = not supplied. */
  call?: string[];
  /** The global `quotaFallbackModels` setting. `undefined` = not configured. */
  global?: string[];
}

/**
 * Resolve which source's list is in effect. The first source that is
 * `!== undefined` wins outright — including an empty array, which is a valid
 * "explicitly no fallback" declaration at any level. Returns `[]` (not
 * `undefined`) when nothing at all was declared, since every caller downstream
 * wants a plain array to work with.
 */
export function resolveFallbackModelSpec(sources: FallbackModelSources): string[] {
  if (sources.agentFrontmatter !== undefined) return sources.agentFrontmatter;
  if (sources.call !== undefined) return sources.call;
  return sources.global ?? [];
}

export interface QuotaModelDecision {
  block: boolean;
  resetAt?: number;
}

export interface QuotaModelSelection<T, D extends QuotaModelDecision = QuotaModelDecision> {
  selected?: T;
  selectedIndex?: number;
  blocked: Array<{ model: T; decision: D }>;
  earliestResetAt?: number;
}

/**
 * Select the first candidate not blocked by fresh included-quota state.
 * Advisory decisions fail open, so evaluation stops at the first `block: false`.
 */
export function chooseQuotaModel<T, D extends QuotaModelDecision>(
  chain: readonly T[],
  decide: (model: T) => D,
): QuotaModelSelection<T, D> {
  const blocked: Array<{ model: T; decision: D }> = [];
  let earliestResetAt: number | undefined;

  for (const [index, model] of chain.entries()) {
    const decision = decide(model);
    if (!decision.block) {
      return { selected: model, selectedIndex: index, blocked, earliestResetAt };
    }
    blocked.push({ model, decision });
    if (decision.resetAt !== undefined) {
      earliestResetAt = earliestResetAt === undefined
        ? decision.resetAt
        : Math.min(earliestResetAt, decision.resetAt);
    }
  }

  return { blocked, earliestResetAt };
}

export interface FallbackModelChainInput {
  /** Canonical `provider/id` of the already-resolved effective primary model. */
  primaryModelId: string;
  /** Raw candidate strings, precedence-resolved via {@link resolveFallbackModelSpec}. */
  candidates: string[];
  modelRegistry: ModelRegistry & ModelRegistryRef;
  cwd: string;
  /**
   * Whether `candidates` came from agent frontmatter rather than a caller/global
   * source — governs `checkModelScope`'s error-vs-warn split the same way it
   * does for the primary model: an author-pinned choice warns and proceeds, an
   * orchestrator-supplied one is refused (dropped) when out of scope.
   */
  fromFrontmatter: boolean;
}

export interface FallbackModelChainResult {
  /** Primary first, then each resolved, in-scope, de-duplicated fallback — canonical `provider/id` strings. */
  chain: string[];
  /** Human-readable notes for candidates that were dropped, or scope warnings that proceeded. Non-fatal. */
  warnings: string[];
}

/**
 * Build the effective chain for one spawn. Never throws, and never empties the
 * chain below `[primaryModelId]` — a fallback candidate that cannot be used is
 * simply not in the chain.
 */
export function buildFallbackModelChain(input: FallbackModelChainInput): FallbackModelChainResult {
  const { primaryModelId, candidates, modelRegistry, cwd, fromFrontmatter } = input;
  const chain: string[] = [primaryModelId];
  const seen = new Set([primaryModelId.toLowerCase()]);
  const warnings: string[] = [];

  for (const raw of candidates) {
    const resolved = resolveModel(raw, modelRegistry);
    if (typeof resolved === "string") {
      warnings.push(`Fallback model "${raw}" could not be resolved and was dropped: ${resolved.split("\n")[0]}`);
      continue;
    }
    const { modelId } = describeModel(resolved);
    if (seen.has(modelId.toLowerCase())) continue;

    const verdict: ModelScopeVerdict = checkModelScope({
      model: resolved,
      cwd,
      modelRegistry,
      callerSupplied: !fromFrontmatter,
      agentLabel: "fallback model",
      modelInput: raw,
    });
    if (verdict.kind === "error") {
      warnings.push(`Fallback model "${raw}" dropped: ${verdict.message}`);
      continue;
    }
    if (verdict.kind === "warn") warnings.push(verdict.message);

    seen.add(modelId.toLowerCase());
    chain.push(modelId);
  }

  return { chain, warnings };
}

/**
 * One-call convenience wrapping `resolveFallbackModelSpec` +
 * `buildFallbackModelChain`, for the common case: a call site already has the
 * resolved primary `Model` (or none) and the three raw sources, and wants just
 * the fallback tail (chain minus the primary) plus any warnings to surface.
 *
 * Returns `{ fallbackModels: [], warnings: [] }` when there is no primary model
 * to anchor a chain to (mirrors every call site's own "no model, nothing to
 * resolve against" short-circuit).
 */
export function resolveEffectiveFallbackModels(args: {
  primaryModel: { provider: string; id: string } | undefined;
  sources: FallbackModelSources;
  modelRegistry: ModelRegistry & ModelRegistryRef;
  cwd: string;
}): { fallbackModels: string[]; warnings: string[] } {
  const { primaryModel, sources, modelRegistry, cwd } = args;
  if (!primaryModel) return { fallbackModels: [], warnings: [] };

  const candidates = resolveFallbackModelSpec(sources);
  if (candidates.length === 0) return { fallbackModels: [], warnings: [] };

  const { chain, warnings } = buildFallbackModelChain({
    primaryModelId: describeModel(primaryModel).modelId,
    candidates,
    modelRegistry,
    cwd,
    fromFrontmatter: sources.agentFrontmatter !== undefined,
  });
  return { fallbackModels: chain.slice(1), warnings };
}
