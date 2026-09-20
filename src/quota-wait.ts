/** Pure quota-wait timing helpers shared by live and persisted waiters. */

import type { QuotaBlockedModel } from "./types.js";

const UNKNOWN_RESET_POLL_MS = [60_000, 2 * 60_000, 5 * 60_000] as const;

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
