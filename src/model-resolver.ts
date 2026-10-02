/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/** Logical model aliases supplied only by trusted global machine configuration. */
let modelAliases = new Map<string, string[]>();

/**
 * Replace the configured logical aliases. Alias keys are case-insensitive;
 * candidates are canonical provider/model IDs and are resolved against the
 * available registry at dispatch time.
 */
export function setModelAliases(aliases: Record<string, string[]> | undefined): void {
  modelAliases = new Map(
    Object.entries(aliases ?? {}).map(([alias, candidates]) => [alias.toLowerCase(), [...candidates]]),
  );
}

/**
 * Per-agent model overrides from trusted global configuration: agent `type`
 * (or `"*"`) -> model input. Resolved through `resolveModel`, so a value may be
 * an alias, an exact `provider/id`, or a fuzzy name.
 */
let agentModels = new Map<string, string>();

/** Replace the configured per-agent model map. Keys are matched case-insensitively. */
export function setAgentModels(models: Record<string, string> | undefined): void {
  agentModels = new Map(Object.entries(models ?? {}).map(([type, model]) => [type.toLowerCase(), model]));
}

/**
 * The model input a spawn of `type` should use when the caller named none:
 * `agentModels[type]`, then `agentModels["*"]`, then the agent definition's own
 * `model:` (`definitionModel`). The parent model is the floor, applied by the
 * caller when this returns `undefined`.
 */
export function configuredAgentModel(type: string, definitionModel: string | undefined): string | undefined {
  return agentModels.get(type.toLowerCase()) ?? agentModels.get("*") ?? definitionModel;
}

/**
 * Narrows fuzzy candidates to the models the user enabled (pi's `enabledModels`),
 * as lowercase `provider/id` keys. Injected rather than imported so this module
 * stays free of settings I/O; `undefined` means no scope is configured.
 */
export type ModelScopeProvider = (registry: ModelRegistry) => ReadonlySet<string> | undefined;

let modelScopeProvider: ModelScopeProvider | undefined;

/** Install (or clear) the enabled-model scope used to rank fuzzy matches. */
export function setModelScopeProvider(provider: ModelScopeProvider | undefined): void {
  modelScopeProvider = provider;
}

/** A copy for diagnostics and tests; callers cannot mutate resolver state. */
export function getModelAliases(): ReadonlyMap<string, readonly string[]> {
  return new Map([...modelAliases].map(([alias, candidates]) => [alias, [...candidates]]));
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/** Parsed `[major, minor]` of a model id, or undefined when the family has no known scheme. */
export type ModelVersion = readonly [major: number, minor: number];

/**
 * Pull a version out of a model id (provider prefix ignored):
 *   - `claude-<family>-<n>[-<n>]`, e.g. `claude-opus-4-6`, `claude-opus-5`
 *   - `claude-<n>[-<n>]-<family>`, e.g. `claude-3-5-sonnet-20241022`
 *   - `gpt-<n>[.<n>]-<variant>`, e.g. `gpt-6.1-sol`
 * A minor is one or two digits, so a trailing `-20250514` date stamp is never
 * read as one. Dots and dashes are interchangeable between the parts.
 */
export function parseModelVersion(id: string): ModelVersion | undefined {
  const bare = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const claude = /^claude-[a-z]+-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?(?:-|$)/.exec(bare)
    ?? /^claude-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?-[a-z]/.exec(bare);
  const match = claude ?? /^gpt-(\d+)(?:[.-](\d{1,2})(?!\d))?(?:-|$)/.exec(bare);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0)];
}

/** Descending version order; an unversioned model sorts after every versioned one. */
function compareVersionsDesc(a: ModelVersion | undefined, b: ModelVersion | undefined): number {
  if (a && b) return b[0] - a[0] || b[1] - a[1];
  return a ? -1 : b ? 1 : 0;
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  const aliasCandidates = modelAliases.get(input.trim().toLowerCase());
  if (aliasCandidates) {
    for (const candidate of aliasCandidates) {
      const resolved = resolveCanonicalModel(candidate, registry);
      if (typeof resolved !== "string") return resolved;
    }
    return `Model alias "${input}" has no available candidate.\n\nCandidates:\n${aliasCandidates.map(candidate => `  ${candidate}`).join("\n")}`;
  }
  return resolveCanonicalModel(input, registry);
}

/**
 * Pick among fuzzy candidates. Restricted to the enabled model scope when one is
 * configured and any candidate is in it, then newest parsed version first, then
 * match score. A bare family name like "opus" therefore means the newest opus
 * the user has enabled, not whichever id happens to be shortest.
 */
function rankFuzzy(matches: { entry: ModelEntry; score: number }[], registry: ModelRegistry): ModelEntry | undefined {
  const scope = modelScopeProvider?.(registry);
  const scoped = scope ? matches.filter(c => scope.has(`${c.entry.provider}/${c.entry.id}`.toLowerCase())) : [];
  const pool = scoped.length > 0 ? scoped : matches;
  const ranked = pool
    .map(c => ({ ...c, version: parseModelVersion(c.entry.id) }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version) || b.score - a.score);
  return ranked[0]?.entry;
}

/** Resolve an exact or fuzzy provider/model request without consulting aliases. */
function resolveCanonicalModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  const matches: { entry: ModelEntry; score: number }[] = [];

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score >= 20) matches.push({ entry: m, score });
  }

  // An exact id (or provider/id) is the caller naming a model, not describing
  // one: it wins outright, whatever the scope or any newer sibling.
  const exact = matches.find(c => c.score === 100);
  const bestMatch = exact?.entry ?? rankFuzzy(matches, registry);
  if (bestMatch) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  if (slashIdx !== -1) {
    const bare = resolveCanonicalModel(input.slice(slashIdx + 1), registry);
    if (typeof bare !== "string") return bare;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
