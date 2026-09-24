/**
 * quota-wait.ts — Pure timing for quota-parked dispatches.
 *
 * Kept free of manager and I/O state so the live waiter (`quota-waiter.ts`)
 * and the persisted-wait restore paths (session entries, scheduler store)
 * compute the same next check from the same inputs, and so the schedule is
 * unit-testable without timers.
 */

import type { QuotaBlockedModel } from "./types.js";

/**
 * Backoff for a blocked model whose reset time is unknown (or already past but
 * still reported exhausted). Stepped rather than fixed: a provider that omits
 * `resets_at` is usually one whose endpoint is flaky, and polling it every
 * minute for a week would be pure noise. The last step repeats.
 */
const UNKNOWN_RESET_POLL_MS = [60_000, 2 * 60_000, 5 * 60_000] as const;

/**
 * When a parked wait should next re-read usage: the earliest future reset among
 * the blocked models, or — when any reset is unknown or already past — the
 * unknown-reset backoff step for `unknownPollAttempt`, whichever comes first.
 * Never later than `deadline`, so the timeout fires on time even when every
 * reset lies beyond it.
 */
export function nextQuotaCheckAt(args: {
  now: number;
  deadline: number;
  unknownPollAttempt: number;
  blocked: readonly QuotaBlockedModel[];
}): number {
  const { now, deadline, unknownPollAttempt, blocked } = args;
  const futureResets = blocked
    .map(item => item.resetAt)
    .filter((resetAt): resetAt is number => resetAt !== undefined && resetAt > now);
  const hasUnknownReset = blocked.some(item => item.resetAt === undefined || item.resetAt <= now);
  const candidates: number[] = futureResets;

  if (hasUnknownReset || candidates.length === 0) {
    const pollIndex = Math.min(Math.max(unknownPollAttempt, 0), UNKNOWN_RESET_POLL_MS.length - 1);
    candidates.push(now + UNKNOWN_RESET_POLL_MS[pollIndex]);
  }

  return Math.min(deadline, ...candidates);
}
