import { describe, expect, it } from "vitest";
import { SubscriptionUsageService, type SubscriptionUsageTransport } from "../src/subscription-usage.js";

function transport(payload: unknown, status = 200): SubscriptionUsageTransport {
  let now = 1_700_000_000_000;
  return {
    fetch: async () => new Response(JSON.stringify(payload), { status }),
    now: () => now,
    getAccessToken: async () => "token",
  };
}

describe("SubscriptionUsageService", () => {
  it("normalizes Anthropic windows and blocks exhausted included quota", async () => {
    const service = new SubscriptionUsageService(transport({
      five_hour: { utilization: 100, resets_at: 1_700_000_100 },
      seven_day: { utilization: 10, resets_at: 1_700_100_000 },
    }));
    const result = await service.get({} as never, "anthropic");
    expect(result.snapshot.status).toBe("available");
    expect(result.snapshot.windows).toHaveLength(2);
    expect(service.decisionFor({ provider: "anthropic", id: "claude-sonnet-5" } as never).block).toBe(true);
  });

  it("normalizes Codex credits without treating them as included capacity", async () => {
    const service = new SubscriptionUsageService(transport({
      rate_limit: { primary_window: { used_percent: 100, reset_at: 1_700_000_100 } },
      credits: { has_credits: true, unlimited: false, balance: "12.00" },
    }));
    await service.get({} as never, "openai-codex");
    const decision = service.decisionFor({ provider: "openai-codex", id: "gpt-5.6-sol" } as never);
    expect(decision.block).toBe(true);
    expect(decision.snapshot?.credits).toEqual({ available: true, unlimited: false, balance: "12.00" });
  });

  it("marks unsupported providers unavailable", async () => {
    const service = new SubscriptionUsageService(transport({}));
    const result = await service.get({} as never, "openrouter");
    expect(result.snapshot.status).toBe("unavailable");
  });

  it("retains a stale snapshot when a refresh fails", async () => {
    let calls = 0;
    let now = 1_700_000_000_000;
    const service = new SubscriptionUsageService({
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 })
          : new Response("denied", { status: 429 });
      },
      now: () => now,
      getAccessToken: async () => "token",
    });
    await service.get({} as never, "anthropic");
    now += 5 * 60_000;
    const result = await service.get({} as never, "anthropic");
    expect(result.snapshot.status).toBe("stale");
    expect(result.snapshot.windows[0]?.usedPercent).toBe(10);
  });
});
