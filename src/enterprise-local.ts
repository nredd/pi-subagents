/**
 * Optional machine-local enterprise overlay.
 *
 * This extension deliberately knows no enterprise provider, endpoint, model, or
 * credential. A user-provisioned manifest lives beside Pi's other private state
 * at `<agentDir>/enterprise.local.json`; it is never read from a project.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = "enterprise.local.json";

export interface EnterpriseLocalManifest {
  version: number;
  settings?: Record<string, unknown>;
  models?: { providers?: Record<string, unknown> };
  subagents?: Record<string, unknown>;
}

/** Return the target-local manifest path without reading it. */
export function enterpriseLocalPath(): string {
  return join(getAgentDir(), MANIFEST_NAME);
}

/**
 * Read and minimally validate the machine-local manifest. It never exposes its
 * contents in diagnostics: providers can include command-backed credentials.
 */
export function readEnterpriseLocalManifest(): EnterpriseLocalManifest | undefined {
  const path = enterpriseLocalPath();
  if (!existsSync(path)) return undefined;

  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.warn(`[pi-subagents] Ignoring ${path}: permissions must not grant group or other access.`);
      return undefined;
    }
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected a JSON object");
    }
    const manifest = raw as Record<string, unknown>;
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`unsupported manifest version (expected ${MANIFEST_VERSION})`);
    }
    for (const section of ["settings", "models", "subagents"] as const) {
      const value = manifest[section];
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`section "${section}" must be an object`);
      }
    }
    const models = manifest.models as Record<string, unknown> | undefined;
    if (models?.providers !== undefined && (!models.providers || typeof models.providers !== "object" || Array.isArray(models.providers))) {
      throw new Error('section "models.providers" must be an object');
    }
    return manifest as unknown as EnterpriseLocalManifest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-subagents] Ignoring invalid ${path}: ${reason}`);
    return undefined;
  }
}
