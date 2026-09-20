import { describe, expect, it } from "vitest";
import { nextQuotaCheckAt } from "../src/quota-wait.js";

describe("nextQuotaCheckAt", () => {
  const now = 1_000_000;
  const deadline = now + 10 * 60_000;

  it("uses the earliest future reset", () => {
    expect(nextQuotaCheckAt({
      now,
      deadline,
      unknownPollAttempt: 0,
      blocked: [
        { modelId: "a/one", window: "5h", resetAt: now + 5 * 60_000 },
        { modelId: "b/two", window: "7d", resetAt: now + 3 * 60_000 },
      ],
    })).toBe(now + 3 * 60_000);
  });

  it("polls unknown resets at one, two, then five minutes", () => {
    const blocked = [{ modelId: "a/one", window: "5h" }];
    expect(nextQuotaCheckAt({ now, deadline, unknownPollAttempt: 0, blocked })).toBe(now + 60_000);
    expect(nextQuotaCheckAt({ now, deadline, unknownPollAttempt: 1, blocked })).toBe(now + 2 * 60_000);
    expect(nextQuotaCheckAt({ now, deadline, unknownPollAttempt: 2, blocked })).toBe(now + 5 * 60_000);
    expect(nextQuotaCheckAt({ now, deadline, unknownPollAttempt: 20, blocked })).toBe(now + 5 * 60_000);
  });

  it("polls when a reset is already in the past", () => {
    expect(nextQuotaCheckAt({
      now,
      deadline,
      unknownPollAttempt: 0,
      blocked: [{ modelId: "a/one", window: "5h", resetAt: now - 1 }],
    })).toBe(now + 60_000);
  });

  it("uses the earlier of an unknown poll and a known reset", () => {
    expect(nextQuotaCheckAt({
      now,
      deadline,
      unknownPollAttempt: 0,
      blocked: [
        { modelId: "a/one", window: "5h" },
        { modelId: "b/two", window: "7d", resetAt: now + 4 * 60_000 },
      ],
    })).toBe(now + 60_000);
  });

  it("never schedules beyond the fixed deadline", () => {
    expect(nextQuotaCheckAt({
      now,
      deadline: now + 30_000,
      unknownPollAttempt: 0,
      blocked: [{ modelId: "a/one", window: "5h" }],
    })).toBe(now + 30_000);
  });
});
