/**
 * agent-row.ts -- the `Agent` tool row.
 *
 * Core folds every collapsed tool row to one line,
 * `<first line of renderCall> · <first line of renderResult>`, and draws the
 * ▸/▾ disclosure marker itself. So the call's first line is just `Plan  desc`,
 * the result's first line is the summary (`thinking · 2m41s · 12s · 3.2k token`),
 * and neither draws a marker of its own. The result is a live component: it
 * reads the agent record on every render, so the summary keeps moving without
 * the tool re-emitting a result.
 */

import { pathToFileURL } from "node:url";
import { type Component, hyperlink, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatClock } from "../model-call.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import {
  type AgentActivity,
  type AgentDetails,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatTokens,
  SPINNER,
  type Theme,
} from "./agent-widget.js";

/** Lines of the result shown when expanded; the rest is one `get_subagent_result` away. */
const EXPANDED_RESULT_LINES = 50;
/** Lines of the prompt shown when expanded. */
const EXPANDED_PROMPT_LINES = 30;

/** What the row reads at render time. */
export interface AgentRowLive {
  getRecord(id: string): AgentRecord | undefined;
  getActivity(id: string): AgentActivity | undefined;
  showCost(): boolean;
}

/** Statuses after which nothing about the run changes any more. */
const TERMINAL = new Set(["completed", "steered", "aborted", "stopped", "error"]);

/** Whether the row still has something live to show. */
export function isRowLive(details: AgentDetails, live: AgentRowLive): boolean {
  const record = details.agentId ? live.getRecord(details.agentId) : undefined;
  if (record) return record.status === "running" || record.status === "queued";
  return details.status === "running" || details.status === "queued";
}

/** The icon and wording for a run's state, reading the record when the details are not final. */
function statusOf(
  details: AgentDetails,
  record: AgentRecord | undefined,
  activity: AgentActivity | undefined,
  theme: Theme,
  now: number,
): { icon: string; text: string } {
  // A terminal result is the tool's own verdict (it also knows the worktree note
  // and the final error). Only a non-final one is replaced by the live record.
  const status = TERMINAL.has(details.status) ? details.status : (record?.status ?? details.status);
  switch (status) {
    case "completed":
      return { icon: theme.fg("success", "✓"), text: "done" };
    case "steered":
      return { icon: theme.fg("warning", "✓"), text: "wrapped up (turn limit)" };
    case "stopped":
      return { icon: theme.fg("dim", "■"), text: "stopped" };
    case "aborted":
      return { icon: theme.fg("error", "✗"), text: "aborted (max turns exceeded)" };
    case "error":
      return { icon: theme.fg("error", "✗"), text: `error: ${record?.error ?? details.error ?? "unknown"}` };
    case "queued":
      return { icon: theme.fg("muted", "◦"), text: details.activity ?? "queued" };
    default: {
      const frame = SPINNER[Math.floor(now / 80) % SPINNER.length];
      const text = activity
        ? describeActivity(activity.activeTools, activity.responseText, activity.modelCall, now)
        : (details.status === "background" ? "running in background" : (details.activity ?? "thinking…"));
      return { icon: theme.fg("accent", frame), text };
    }
  }
}

/** `✓ done · 12s · 33.8k token`: the first line of the result, and half of the folded row. */
export function agentRowSummary(
  details: AgentDetails,
  live: AgentRowLive,
  theme: Theme,
  now: number = Date.now(),
): string {
  const record = details.agentId ? live.getRecord(details.agentId) : undefined;
  const activity = details.agentId ? live.getActivity(details.agentId) : undefined;
  const { icon, text } = statusOf(details, record, activity, theme, now);

  const finished = TERMINAL.has(details.status) || (record !== undefined && TERMINAL.has(record.status));
  const elapsed = record
    ? (finished ? (record.completedAt ?? now) : now) - record.startedAt
    : details.durationMs;
  const tokens = record ? getLifetimeTotal(record.lifetimeUsage) : 0;
  const tokenText = record ? (tokens > 0 ? formatTokens(tokens) : "") : details.tokens;
  const cost = live.showCost() ? formatCost(record ? getLifetimeCost(record.lifetimeUsage) : (details.cost ?? 0)) : "";

  const parts = [text, formatClock(elapsed)];
  if (tokenText) parts.push(tokenText);
  if (cost) parts.push(cost);
  return `${icon} ${parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(` ${theme.fg("dim", "·")} `)}`;
}

/**
 * `↳ opus 4.6 · thinking: high · background`. Taken from the details, which the
 * tool already builds from the record's effective values once a session exists
 * (pi may have clamped the level) and which carry the `twin` label.
 */
function tagsLine(details: AgentDetails, theme: Theme): string | undefined {
  const parts = [...(details.modelName ? [details.modelName] : []), ...(details.tags ?? [])];
  return parts.length > 0 ? theme.fg("dim", `↳ ${parts.join(" · ")}`) : undefined;
}

/** The transcript as an OSC 8 hyperlink, so a click opens it. */
export function transcriptLink(path: string, theme: Theme): string {
  return `${hyperlink("transcript ↗", pathToFileURL(path).href)} ${theme.fg("dim", path)}`;
}

/** Redraw cadence while a row has something live to show. */
const ROW_TICK_MS = 1000;

interface RowTickState {
  ticker?: ReturnType<typeof setInterval>;
  details?: AgentDetails;
  invalidate?: () => void;
}

/**
 * Ask the host to redraw a live row once a second. The result component is live
 * (it reads the record on render) but nothing repaints a quiet screen, and the
 * widget/fleet timers are not guaranteed to be running. The ticker lives on the
 * row's shared `state`, always reads the newest details, and stops by itself
 * once the run is over.
 */
export function keepRowTicking(
  context: { state?: unknown; invalidate?: () => void },
  details: AgentDetails,
  live: AgentRowLive,
): void {
  const state = context.state as RowTickState | undefined;
  if (!state || !context.invalidate) return;
  state.details = details;
  state.invalidate = context.invalidate;
  if (state.ticker !== undefined || !isRowLive(details, live)) return;
  state.ticker = setInterval(() => {
    if (state.details && isRowLive(state.details, live)) {
      state.invalidate?.();
      return;
    }
    clearInterval(state.ticker);
    state.ticker = undefined;
    state.invalidate?.(); // one last repaint, showing the final state
  }, ROW_TICK_MS);
  state.ticker.unref?.();
}

/**
 * The result half of the row. Re-evaluates on every render, so what it shows is
 * the agent's state now rather than the state when the tool last returned.
 */
export class AgentResultView implements Component {
  constructor(
    private readonly details: AgentDetails,
    private readonly resultText: string,
    private readonly expanded: boolean,
    private readonly live: AgentRowLive,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const lines = [truncateToWidth(agentRowSummary(this.details, this.live, this.theme), width)];
    if (!this.expanded) return lines;

    const record = this.details.agentId ? this.live.getRecord(this.details.agentId) : undefined;
    const tags = tagsLine(this.details, this.theme);
    if (tags) lines.push(truncateToWidth(tags, width));
    const transcript = record?.outputFile ?? this.details.outputFile;
    if (transcript) lines.push(truncateToWidth(transcriptLink(transcript, this.theme), width));

    if (this.details.status === "completed" || this.details.status === "steered") {
      const body = this.resultText.split("\n");
      for (const line of body.slice(0, EXPANDED_RESULT_LINES)) {
        lines.push(...wrapTextWithAnsi(this.theme.fg("dim", `  ${line}`), width));
      }
      if (body.length > EXPANDED_RESULT_LINES) {
        lines.push(this.theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)"));
      }
    }
    return lines;
  }

  invalidate(): void { /* reads live state on every render */ }
}

/** The call half: `Plan  desc`, and the prompt underneath when expanded. */
export class AgentCallView implements Component {
  constructor(
    private readonly header: string,
    private readonly prompt: string | undefined,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const lines = [truncateToWidth(this.header, width)];
    if (this.prompt) {
      const wrapped = this.prompt.split("\n").flatMap(line => wrapTextWithAnsi(this.theme.fg("dim", `  ${line}`), width));
      lines.push(...wrapped.slice(0, EXPANDED_PROMPT_LINES));
      if (wrapped.length > EXPANDED_PROMPT_LINES) lines.push(this.theme.fg("muted", "  …"));
    }
    return lines;
  }

  invalidate(): void { /* static */ }
}
