/**
 * detached-results.ts -- hand completed background agents back to a session
 * after the extension instance that spawned them is gone.
 *
 * `/new`, `/resume`, `/fork` and `/reload` shut the extension down but keep the
 * process alive. Background agents are allowed to finish in the orphaned
 * manager, which can no longer talk to pi (its `pi` handle is stale), so each
 * result is spooled to disk keyed by the PARENT session file. The extension
 * instance bound to that session drains the spool on `session_start`, and while
 * it is active a process-wide sink wakes it for results that land later.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One finished agent, in the shape `session_start` needs to re-announce it. */
export interface DetachedResult {
  id: string;
  /** Pre-rendered `<task-notification>` text for the LLM. */
  content: string;
  /** `subagent-notification` renderer details. */
  details: unknown;
  /** Payload for the `subagents:record` history entry. */
  record: Record<string, unknown>;
}

const SINK_KEY = Symbol.for("pi-subagents:detached-sink");

/** Per-session wake-ups, shared across every extension instance in the process. */
function sinks(): Map<string, () => void> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[SINK_KEY] as Map<string, () => void> | undefined;
  if (!map) {
    map = new Map();
    g[SINK_KEY] = map;
  }
  return map;
}

/** Spool directory for one parent session (created on demand, owner-only). */
export function detachedDir(sessionFile: string): string {
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, "detached", key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Persist a result for `sessionFile` and wake its live extension instance, if any. */
export function spoolDetached(sessionFile: string, result: DetachedResult): void {
  const dir = detachedDir(sessionFile);
  const name = `${Date.now()}-${result.id.replace(/[^\w.-]/g, "_")}.json`;
  // Rename into place so a concurrent drain never reads a half-written file.
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
  renameSync(tmp, join(dir, name));
  try {
    sinks().get(sessionFile)?.();
  } catch {
    // The woken instance is already shutting down; the file stays for the next drain.
  }
}

/** Read and delete every spooled result for `sessionFile`, oldest first. Unreadable files are dropped. */
export function drainDetached(sessionFile: string): DetachedResult[] {
  const dir = detachedDir(sessionFile);
  const out: DetachedResult[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith(".json") && !n.startsWith(".")).sort()) {
    const path = join(dir, name);
    try {
      out.push(JSON.parse(readFileSync(path, "utf8")) as DetachedResult);
    } catch {
      // Corrupt spool entry: nothing recoverable, and retrying it forever helps nobody.
    }
    rmSync(path, { force: true });
  }
  return out;
}

/** Call `onSpooled` whenever a result lands for `sessionFile`. Returns the unsubscribe. */
export function watchDetached(sessionFile: string, onSpooled: () => void): () => void {
  const map = sinks();
  map.set(sessionFile, onSpooled);
  return () => {
    if (map.get(sessionFile) === onSpooled) map.delete(sessionFile);
  };
}
