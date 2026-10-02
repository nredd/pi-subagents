/**
 * notification-view.ts -- the `subagent-notification` message renderer.
 *
 * Core gives a custom message with a registered renderer a ▸/▾ gutter, collapses
 * it to the renderer's first line, and toggles it on click. So the first line is
 * the whole collapsed notice and no marker is drawn here:
 *
 *   ✓ audit the RPC path · 12 tools · 33.8k token · ~$0.0042 · 41.2s
 *   3 agents finished · ✓ a, ✓ b, ✗ c
 *
 * Expanded adds the stats, the result preview and the transcript as a link.
 */

import { pathToFileURL } from "node:url";
import { type Component, hyperlink, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NotificationDetails } from "../types.js";
import { formatCost, formatMs, formatTokens, formatTurns, type Theme } from "./agent-widget.js";

/** Lines of the result preview shown when expanded. */
const EXPANDED_PREVIEW_LINES = 30;

const FAILED = new Set(["error", "stopped", "aborted"]);

function icon(d: NotificationDetails, theme: Theme): string {
  return FAILED.has(d.status) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

/** The parts after the description: tools, tokens, cost, duration. */
function statParts(d: NotificationDetails, showCost: boolean): string[] {
  const parts: string[] = [];
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
  if (showCost) {
    const cost = formatCost(d.totalCost ?? 0);
    if (cost) parts.push(cost);
  }
  if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
  return parts;
}

/** `✓ desc · 12 tools · 33.8k token · ~$0.0042 · 41.2s`. */
export function noticeSummary(d: NotificationDetails, theme: Theme, showCost: boolean): string {
  const dot = ` ${theme.fg("dim", "·")} `;
  const head = `${icon(d, theme)} ${theme.bold(d.description)}`;
  const stats = statParts(d, showCost).map(p => theme.fg("dim", p));
  return [head, ...stats].join(dot);
}

/** `3 agents finished · ✓ a, ✓ b, ✗ c`. */
export function groupSummary(all: NotificationDetails[], theme: Theme): string {
  const names = all.map(d => `${icon(d, theme)} ${d.description}`).join(theme.fg("dim", ", "));
  return `${theme.bold(`${all.length} agents finished`)} ${theme.fg("dim", "·")} ${names}`;
}

/** The transcript as an OSC 8 hyperlink, so a click opens it. */
function transcriptLine(path: string, theme: Theme): string {
  return `${hyperlink("transcript ↗", pathToFileURL(path).href)} ${theme.fg("dim", path)}`;
}

/** Detail lines for one agent, shown only when expanded. */
function detailLines(d: NotificationDetails, theme: Theme, showCost: boolean, indent: string): string[] {
  const lines: string[] = [];
  const stats: string[] = [];
  if (d.status !== "completed") {
    stats.push(d.status === "steered" ? "completed (steered)" : d.status);
  }
  if (d.turnCount > 0) stats.push(formatTurns(d.turnCount, d.maxTurns));
  stats.push(...statParts(d, showCost));
  if (stats.length > 0) lines.push(indent + theme.fg("dim", stats.join(" · ")));
  if (d.error) lines.push(indent + theme.fg("error", d.error));
  for (const line of d.resultPreview.split("\n").slice(0, EXPANDED_PREVIEW_LINES)) {
    lines.push(indent + theme.fg("dim", line));
  }
  if (d.outputFile) lines.push(indent + transcriptLine(d.outputFile, theme));
  return lines;
}

/** First line truncated (core folds on it), the rest wrapped. */
class NoticeView implements Component {
  constructor(
    private readonly first: string,
    private readonly rest: string[],
  ) {}

  render(width: number): string[] {
    return [truncateToWidth(this.first, width), ...this.rest.flatMap(line => wrapTextWithAnsi(line, width))];
  }

  invalidate(): void { /* static */ }
}

export function renderNotification(
  details: NotificationDetails,
  expanded: boolean,
  theme: Theme,
  showCost: boolean,
): Component {
  const all = [details, ...(details.others ?? [])];
  if (all.length === 1) {
    return new NoticeView(
      noticeSummary(details, theme, showCost),
      expanded ? detailLines(details, theme, showCost, "  ") : [],
    );
  }
  const rest: string[] = [];
  if (expanded) {
    for (const d of all) {
      rest.push(noticeSummary(d, theme, showCost));
      rest.push(...detailLines(d, theme, showCost, "  "));
    }
    if (showCost) {
      const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
      if (total) {
        const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
        rest.push(theme.fg("dim", `${formatTokens(tokens)} · ${total} in total`));
      }
    }
  }
  return new NoticeView(groupSummary(all, theme), rest);
}
