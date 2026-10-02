/**
 * model-call.ts -- what an agent's in-flight model call is doing right now.
 *
 * A single model call can sit silent for minutes (long thinking, a slow
 * provider), and the widget used to say `thinking…` for all of it with nothing
 * to tell a busy agent from a dead stream. This tracks the call from the
 * session's streaming events so every surface can say how long it has been
 * thinking, how much it has written, or that it has gone quiet.
 */

/** One streaming event from an assistant message, as the runner reports it. */
export type ModelCallEvent =
  | { type: "start" }
  | { type: "delta"; kind: "thinking" | "writing"; chars: number }
  /** A stream event that carries no text (block boundaries): proof of life only. */
  | { type: "beat" }
  | { type: "end" };

export interface ModelCallState {
  startedAt: number;
  /** The last stream event of any kind, which is what `stalled?` is measured from. */
  lastEventAt: number;
  kind: "thinking" | "writing";
  /** Characters streamed as text or tool-call arguments this call. */
  writtenChars: number;
}

/** Silence this long mid-call reads as stalled. */
export const STALL_MS = 2 * 60_000;

/** Rough characters per token, for a figure shown before the provider reports usage. */
const CHARS_PER_TOKEN = 4;

/** Fold one event into `current`; `undefined` means no call is in flight. */
export function applyModelCallEvent(
  current: ModelCallState | undefined,
  event: ModelCallEvent,
  now: number,
): ModelCallState | undefined {
  switch (event.type) {
    case "start":
      return { startedAt: now, lastEventAt: now, kind: "thinking", writtenChars: 0 };
    case "end":
      return undefined;
    case "beat":
      return current ? { ...current, lastEventAt: now } : current;
    case "delta": {
      const base = current ?? { startedAt: now, lastEventAt: now, kind: "thinking" as const, writtenChars: 0 };
      return {
        ...base,
        lastEventAt: now,
        // Once it has started writing, a late thinking block does not flip it back.
        kind: event.kind === "writing" ? "writing" : base.kind,
        writtenChars: base.writtenChars + (event.kind === "writing" ? event.chars : 0),
      };
    }
  }
}

/** `41s`, `2m41s`, `1h05m`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `950`, `3.2k`. */
function compactCount(n: number): string {
  return n < 1_000 ? `${n}` : `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * `thinking · 2m41s`, `writing · 3.2k tok`, or `stalled? · 2m41s`; undefined
 * when no call is in flight.
 */
export function describeModelCall(state: ModelCallState | undefined, now: number): string | undefined {
  if (!state) return undefined;
  const silent = now - state.lastEventAt;
  if (silent >= STALL_MS) return `stalled? · ${formatClock(silent)}`;
  if (state.kind === "writing") {
    return `writing · ${compactCount(Math.round(state.writtenChars / CHARS_PER_TOKEN))} tok`;
  }
  return `thinking · ${formatClock(now - state.startedAt)}`;
}
