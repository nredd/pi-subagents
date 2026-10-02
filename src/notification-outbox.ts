/**
 * notification-outbox.ts -- queues completion notices and delivers them as ONE
 * message when the parent can take them.
 *
 * Core delivers a `followUp` message per turn while the parent is busy, so
 * notices sent as agents finished arrived late, one per turn, and often after
 * the parent had already fetched the result itself. Here a notice only queues.
 * It is delivered when the parent is idle, or on `agent_end` otherwise, and
 * whatever was read in the meantime is dropped first.
 */

import type { NotificationDetails } from "./types.js";

/** One finished agent (or workflow run) waiting to be announced. */
export interface OutboxNotice {
  id: string;
  /** Re-read at delivery: true once the parent fetched the result, which suppresses the notice. */
  consumed(): boolean;
  /** The `<task-notification>` block, with the result preview cut to `resultMaxLen`. */
  text(resultMaxLen: number): string;
  /** Renderer details, with the result preview cut to `resultMaxLen`. */
  details(resultMaxLen: number): NotificationDetails;
  /** Appended after a lone notice, e.g. the transcript path. */
  footer?: string;
}

/** The message a flush sends. */
export interface OutboxMessage {
  content: string;
  details: NotificationDetails;
}

/** Preview budget for a lone notice, and per agent once several share a message. */
const SINGLE_RESULT_MAX = 500;
const GROUP_RESULT_MAX = 300;

/** Coalesce pending notices into the one message that announces them. */
export function composeNotice(notices: readonly OutboxNotice[]): OutboxMessage | undefined {
  const [first, ...rest] = notices;
  if (!first) return undefined;
  if (rest.length === 0) {
    return { content: first.text(SINGLE_RESULT_MAX) + (first.footer ?? ""), details: first.details(SINGLE_RESULT_MAX) };
  }
  const body = notices.map(n => n.text(GROUP_RESULT_MAX)).join("\n\n");
  return {
    content: `Background agent group completed: ${notices.length} agent(s) finished\n\n${body}\n\nUse get_subagent_result for full output.`,
    details: { ...first.details(GROUP_RESULT_MAX), others: rest.map(n => n.details(GROUP_RESULT_MAX)) },
  };
}

export interface OutboxOptions {
  /** Whether the parent is between turns. Treated as idle when it cannot be read. */
  isIdle(): boolean;
  deliver(message: OutboxMessage): void;
  /** Coalescing window after the first notice queues. */
  holdMs?: number;
}

export class NotificationOutbox {
  private pending = new Map<string, OutboxNotice>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: OutboxOptions) {}

  /** Queue a notice. A repeat id replaces the earlier one (a resumed agent finishing again). */
  enqueue(notice: OutboxNotice): void {
    this.pending.set(notice.id, notice);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush(false);
    }, this.options.holdMs ?? 200);
  }

  /** Forget a notice, e.g. because its result was just fetched. */
  drop(id: string): void {
    this.pending.delete(id);
  }

  /** Number of notices waiting. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Deliver everything still unread as one message. Unless `force`, only while
   * the parent is idle; `agent_end` forces, because the next turn is the only
   * thing left to wait for.
   */
  flush(force: boolean): void {
    if (this.pending.size === 0) return;
    if (!force && !this.options.isIdle()) return;
    const unread = [...this.pending.values()].filter(n => !n.consumed());
    this.pending.clear();
    const message = composeNotice(unread);
    if (!message) return;
    try {
      this.options.deliver(message);
    } catch {
      // The session this notice belonged to is already gone (a stale extension
      // context throws on use). The transcript file still has the result.
    }
  }

  /** Drop everything, e.g. at shutdown. */
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
