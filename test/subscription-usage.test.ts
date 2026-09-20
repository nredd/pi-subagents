import { describe, expect, it, vi } from "vitest";
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

  it("does not block from a formerly fresh snapshot after a forced refresh fails", async () => {
    let calls = 0;
    const service = new SubscriptionUsageService({
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response(JSON.stringify({ five_hour: { utilization: 100 } }), { status: 200 })
          : new Response("denied", { status: 429 });
      },
      now: () => 1_700_000_000_000,
      getAccessToken: async () => "token",
    });
    await service.get({} as never, "anthropic");
    expect(service.decisionFor({ provider: "anthropic", id: "claude-sonnet-5" }).block).toBe(true);

    const refreshed = await service.get({} as never, "anthropic", { force: true });

    expect(refreshed.snapshot.status).toBe("stale");
    expect(service.decisionFor({ provider: "anthropic", id: "claude-sonnet-5" }).block).toBe(false);
  });

  it("allows automatic fresh reads to bypass a valid cache without manual throttling", async () => {
    let usedPercent = 100;
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      five_hour: { utilization: usedPercent, resets_at: 1_700_000_100 },
    }), { status: 200 }));
    const service = new SubscriptionUsageService({
      fetch,
      now: () => 1_700_000_000_000,
      getAccessToken: async () => "token",
    });

    await service.get({} as never, "anthropic");
    usedPercent = 20;
    const refreshed = await service.get({} as never, "anthropic", { fresh: true });

    expect(refreshed.refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.decisionFor({ provider: "anthropic", id: "claude-sonnet-5" }).block).toBe(false);
  });

  it("reports the blocking window and reset time with an exhausted decision", async () => {
    const service = new SubscriptionUsageService(transport({
      five_hour: { utilization: 100, resets_at: 1_700_000_100 },
    }));
    await service.get({} as never, "anthropic");

    expect(service.decisionFor({ provider: "anthropic", id: "claude-sonnet-5" })).toMatchObject({
      block: true,
      window: "five_hour",
      resetAt: 1_700_000_100_000,
    });
  });

  it("throttles manual refresh independently per provider", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("anthropic")
        ? { five_hour: { utilization: 10 } }
        : { rate_limit: { primary_window: { used_percent: 20 } } },
    ), { status: 200 }));
    const service = new SubscriptionUsageService({
      fetch,
      now: () => 1_700_000_000_000,
      getAccessToken: async () => "token",
    });

    const anthropic = await service.get({} as never, "anthropic", { force: true });
    const codex = await service.get({} as never, "openai-codex", { force: true });

    expect(anthropic.refreshed).toBe(true);
    expect(codex.refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("converts credential lookup failures into a safe error snapshot", async () => {
    const service = new SubscriptionUsageService({
      fetch: vi.fn(),
      now: () => 1_700_000_000_000,
      getAccessToken: async () => { throw new Error("secret auth backend detail"); },
    });

    const result = await service.get({} as never, "anthropic");

    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.message).toBe("OAuth credential lookup failed.");
    expect(result.snapshot.message).not.toContain("secret");
  });

  it("reports caller cancellation separately from a request timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new SubscriptionUsageService({
      fetch: async (_url, init) => {
        if (init.signal instanceof AbortSignal && init.signal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return new Response("unreachable", { status: 500 });
      },
      now: () => 1_700_000_000_000,
      getAccessToken: async () => "token",
    });

    const result = await service.get({} as never, "anthropic", { signal: controller.signal });

    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.message).toBe("Usage request was cancelled.");
  });

  it("deduplicates concurrent fresh reads per provider", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const service = new SubscriptionUsageService({
      fetch,
      now: () => 1_700_000_000_000,
      getAccessToken: async () => "token",
    });

    const first = service.get({} as never, "anthropic", { fresh: true });
    const second = service.get({} as never, "anthropic", { fresh: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolveFetch(new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }));

    const results = await Promise.all([first, second]);
    expect(results.map(result => result.snapshot.status)).toEqual(["available", "available"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("detaches a cancelled caller without aborting a shared refresh", async () => {
    let resolveFetch!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { resolveFetch = resolve; });
    });
    const service = new SubscriptionUsageService({
      fetch,
      now: () => 1_700_000_000_000,
      getAccessToken: async () => "token",
    });
    const controller = new AbortController();

    const cancelled = service.get({} as never, "anthropic", { fresh: true, signal: controller.signal });
    const live = service.get({} as never, "anthropic", { fresh: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    const cancelledResult = await cancelled;

    expect(cancelledResult.snapshot.message).toBe("Usage request was cancelled.");
    expect(requestSignal?.aborted).toBe(false);

    resolveFetch(new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }));
    expect((await live).snapshot.status).toBe("available");
    expect(fetch).toHaveBeenCalledTimes(1);
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
