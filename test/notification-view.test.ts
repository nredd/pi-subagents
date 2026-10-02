import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "../src/types.js";
import { groupSummary, noticeSummary, renderNotification } from "../src/ui/notification-view.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function details(over: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "a1",
    description: "audit the RPC path",
    status: "completed",
    toolUses: 12,
    turnCount: 5,
    totalTokens: 33_800,
    totalCost: 0.0042,
    durationMs: 41_200,
    resultPreview: "line one\nline two",
    ...over,
  };
}

const render = (d: NotificationDetails, expanded: boolean, showCost = true, width = 120) =>
  renderNotification(d, expanded, theme, showCost).render(width);

describe("collapsed notice", () => {
  it("is one line: ✓ desc · tools · tokens · cost · duration", () => {
    const lines = render(details(), false);
    expect(lines).toEqual(["✓ audit the RPC path · 12 tools · 33.8k token · ~$0.0042 · 41.2s"]);
  });

  it("uses ✗ for failure, stop and abort", () => {
    for (const status of ["error", "stopped", "aborted"]) {
      expect(render(details({ status }), false)[0]).toMatch(/^✗ /);
    }
    expect(render(details({ status: "steered" }), false)[0]).toMatch(/^✓ /);
  });

  it("drops cost unless asked, and zero parts always", () => {
    expect(render(details(), false, false)[0]).not.toContain("$");
    expect(render(details({ toolUses: 0, totalTokens: 0, durationMs: 0, totalCost: 0 }), false)[0]).toBe("✓ audit the RPC path");
  });

  it("singularises one tool", () => {
    expect(render(details({ toolUses: 1 }), false)[0]).toContain("1 tool ·");
  });

  it("draws no disclosure marker of its own", () => {
    expect(render(details(), false).join("")).not.toMatch(/[▸▾]/);
    expect(render(details(), true).join("")).not.toMatch(/[▸▾]/);
  });

  it("truncates a long first line instead of wrapping it, so core can fold on it", () => {
    const lines = render(details({ description: "x".repeat(300) }), false, true, 60);
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(60 + 20); // allows for the ellipsis reset codes
  });
});

describe("grouped notice", () => {
  const group = {
    ...details({ description: "a" }),
    others: [details({ id: "b", description: "b" }), details({ id: "c", description: "c", status: "error" })],
  };

  it("collapses to N agents finished · ✓ a, ✓ b, ✗ c", () => {
    expect(render(group, false)).toEqual(["3 agents finished · ✓ a, ✓ b, ✗ c"]);
    expect(groupSummary([group, ...group.others], theme)).toBe("3 agents finished · ✓ a, ✓ b, ✗ c");
  });

  it("expands to a block per agent, then the total when cost is on", () => {
    const lines = render(group, true);
    expect(lines[0]).toBe("3 agents finished · ✓ a, ✓ b, ✗ c");
    expect(lines).toContain(noticeSummary(group, theme, true));
    expect(lines.filter(l => l.startsWith("✓ b") || l.startsWith("✗ c"))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/in total$/);
  });

  it("shows no total with cost off", () => {
    expect(render(group, true, false).join("\n")).not.toContain("in total");
  });
});

describe("expanded notice", () => {
  it("keeps the summary first, then stats, the preview and nothing else without a transcript", () => {
    const lines = render(details(), true);
    expect(lines[0]).toBe("✓ audit the RPC path · 12 tools · 33.8k token · ~$0.0042 · 41.2s");
    expect(lines[1]).toBe("  ↻5 · 12 tools · 33.8k token · ~$0.0042 · 41.2s");
    expect(lines.slice(2)).toEqual(["  line one", "  line two"]);
  });

  it("says what a non-completed status was", () => {
    expect(render(details({ status: "steered" }), true)[1]).toContain("completed (steered)");
    expect(render(details({ status: "error", error: "boom" }), true).join("\n")).toContain("boom");
  });

  it("links the transcript as an OSC 8 hyperlink labelled transcript ↗", () => {
    const lines = render(details({ outputFile: "/tmp/pi/agent 1.output" }), true);
    const link = lines.at(-1)!;
    expect(link).toContain("\x1b]8;;file:///tmp/pi/agent%201.output");
    expect(link).toContain("transcript ↗");
    expect(link).toContain("/tmp/pi/agent 1.output");
  });

  it("caps the preview", () => {
    const preview = Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n");
    const lines = render(details({ resultPreview: preview }), true);
    expect(lines.some(l => l.includes("row 29"))).toBe(true);
    expect(lines.some(l => l.includes("row 30"))).toBe(false);
  });
});
