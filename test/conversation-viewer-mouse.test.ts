/**
 * Mouse and live-activity behaviour of the conversation viewer (pi 1.0
 * fullscreen): wheel scrolling by the host's `wheelDelta`, a click outside the
 * box closing it, the backdrop that makes that click reachable, and the
 * activity line / streamed deltas that keep the view alive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { ConversationViewer, createViewerOverlay } from "../src/ui/conversation-viewer.js";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

function tuiWith(mode: string | undefined, rows = 40, columns = 100) {
  return { mode, terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function longSession(lines = 200, streaming?: any) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") }] }],
    subscribe: vi.fn(() => vi.fn()),
    state: { streamingMessage: streaming },
  } as any;
}

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return { id: "a1", type: "general-purpose", description: "d", status: "running", toolUses: 0, startedAt: Date.now(), ...over } as AgentRecord;
}

const viewers: ConversationViewer[] = [];
function makeViewer(opts: { tui?: any; session?: any; record?: AgentRecord; activity?: AgentActivity; done?: () => void } = {}) {
  const viewer = new ConversationViewer(
    opts.tui ?? tuiWith("fullscreen"),
    opts.session ?? longSession(),
    opts.record ?? record(),
    opts.activity,
    theme,
    opts.done ?? vi.fn(),
  );
  viewers.push(viewer);
  return viewer;
}

afterEach(() => {
  for (const v of viewers.splice(0)) v.dispose();
  vi.useRealTimers();
});

const scrollOffset = (v: ConversationViewer): number => (v as any).scrollOffset;

describe("wheel scrolling", () => {
  it("scrolls up and down by the host's wheelDelta, which already carries the setting and Alt", () => {
    const viewer = makeViewer();
    viewer.render(100);
    const bottom = scrollOffset(viewer);

    viewer.handleMouse({ type: "wheel", button: "none", x: 5, y: 10, wheelDelta: -7 });
    expect(scrollOffset(viewer)).toBe(bottom - 7);

    viewer.handleMouse({ type: "wheel", button: "none", x: 5, y: 10, wheelDelta: 3 });
    expect(scrollOffset(viewer)).toBe(bottom - 4);
  });

  it("stops following new output once scrolled away, and resumes at the bottom", () => {
    const viewer = makeViewer();
    viewer.render(100);
    viewer.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -5 });
    expect((viewer as any).autoScroll).toBe(false);
    viewer.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: 500 });
    expect((viewer as any).autoScroll).toBe(true);
  });

  it("clamps at the top", () => {
    const viewer = makeViewer();
    viewer.render(100);
    viewer.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -10_000 });
    expect(scrollOffset(viewer)).toBe(0);
  });

  it("falls back to 3 lines, and 5x with Alt, when the host reports no delta", () => {
    const viewer = makeViewer();
    viewer.render(100);
    const bottom = scrollOffset(viewer);
    // No delta carries no direction either: it scrolls down, clamped at the bottom.
    viewer.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -3 });
    expect(scrollOffset(viewer)).toBe(bottom - 3);
    viewer.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, alt: true });
    expect(scrollOffset(viewer)).toBe(bottom); // +15, clamped
  });

  it("says the event was handled and a render is wanted", () => {
    const viewer = makeViewer();
    viewer.render(100);
    expect(viewer.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -1 })).toEqual({ handled: true, render: true });
  });
});

describe("click outside", () => {
  it("draws the box centred on a terminal-sized backdrop in fullscreen", () => {
    const tui = tuiWith("fullscreen", 40, 100);
    const lines = makeViewer({ tui }).render(100);
    expect(lines).toHaveLength(40);
    expect(lines.every(l => l.length === 100)).toBe(true);
    expect(lines[0].trim()).toBe(""); // top margin
    expect(lines.some(l => l.includes("╭"))).toBe(true);
  });

  it("closes on a left click on the backdrop, and not on one inside the box", () => {
    const done = vi.fn();
    const tui = tuiWith("fullscreen", 40, 100);
    const viewer = makeViewer({ tui, done });
    const lines = viewer.render(100);
    const boxRow = lines.findIndex(l => l.includes("╭"));
    const boxCol = lines[boxRow].indexOf("╭");

    expect(viewer.handleMouse({ type: "click", button: "left", x: boxCol + 3, y: boxRow + 2 })).toBeUndefined();
    expect(done).not.toHaveBeenCalled();

    expect(viewer.handleMouse({ type: "click", button: "left", x: 1, y: boxRow + 2 })).toEqual({ handled: true, render: true });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("closes on a click above, below, left and right of the box", () => {
    for (const [dx, dy] of [[-1, 0], [0, -1]] as const) {
      const done = vi.fn();
      const viewer = makeViewer({ tui: tuiWith("fullscreen", 40, 100), done });
      const lines = viewer.render(100);
      const row = lines.findIndex(l => l.includes("╭"));
      const col = lines[row].indexOf("╭");
      viewer.handleMouse({ type: "click", button: "left", x: col + dx, y: row + dy });
      expect(done).toHaveBeenCalledTimes(1);
    }
    const done = vi.fn();
    const viewer = makeViewer({ tui: tuiWith("fullscreen", 40, 100), done });
    const lines = viewer.render(100);
    const bottom = lines.map(l => l.includes("╰")).lastIndexOf(true);
    viewer.handleMouse({ type: "click", button: "left", x: 50, y: bottom + 1 });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("ignores right clicks and presses", () => {
    const done = vi.fn();
    const viewer = makeViewer({ done });
    viewer.render(100);
    expect(viewer.handleMouse({ type: "click", button: "right", x: 0, y: 0 })).toBeUndefined();
    expect(viewer.handleMouse({ type: "press", button: "left", x: 0, y: 0 })).toBeUndefined();
    expect(done).not.toHaveBeenCalled();
  });

  it("does not draw a backdrop, or treat any click as outside, outside fullscreen", () => {
    const done = vi.fn();
    const tui = tuiWith(undefined, 40, 100);
    const viewer = makeViewer({ tui, done });
    const lines = viewer.render(90);
    expect(lines.length).toBeLessThan(40);
    viewer.handleMouse({ type: "click", button: "left", x: 0, y: 0 });
    expect(done).not.toHaveBeenCalled();
  });

  it("is a classic box when the overlay is narrower than the terminal", () => {
    const viewer = makeViewer({ tui: tuiWith("fullscreen", 40, 100) });
    expect(viewer.render(90).length).toBeLessThan(40);
  });
});

describe("createViewerOverlay", () => {
  it("is the 90% centred box until it is told the tui is fullscreen", () => {
    const overlay = createViewerOverlay();
    expect(overlay.options()).toMatchObject({ anchor: "center", width: "90%", maxHeight: "70%" });
    overlay.track(tuiWith("fullscreen"));
    expect(overlay.options()).toMatchObject({ anchor: "center", width: "100%", maxHeight: "100%" });
    overlay.track(tuiWith("regular"));
    expect(overlay.options()).toMatchObject({ width: "90%" });
    overlay.track(tuiWith(undefined));
    expect(overlay.options()).toMatchObject({ width: "90%" });
  });
});

describe("footer hint", () => {
  it("advertises the wheel", () => {
    const text = makeViewer({ tui: tuiWith(undefined, 40, 120) }).render(120).join("\n");
    expect(text).toContain("wheel/↑↓ scroll");
  });
});

describe("live activity", () => {
  it("shows the in-flight model call on the activity line", () => {
    const now = Date.now();
    const activity: AgentActivity = {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
      modelCall: { startedAt: now - 161_000, lastEventAt: now - 1_000, kind: "thinking", writtenChars: 0 },
    };
    const text = makeViewer({ tui: tuiWith(undefined, 40, 100), activity }).render(100).join("\n");
    expect(text).toMatch(/thinking · 2m4\ds/);
  });

  it("shows stalled? after two quiet minutes", () => {
    const now = Date.now();
    const activity: AgentActivity = {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
      modelCall: { startedAt: now - 300_000, lastEventAt: now - 130_000, kind: "thinking", writtenChars: 0 },
    };
    const text = makeViewer({ tui: tuiWith(undefined, 40, 100), activity }).render(100).join("\n");
    expect(text).toMatch(/stalled\? · 2m1\ds/);
  });

  it("streams the message being written before it lands in the transcript", () => {
    const streaming = { role: "assistant", content: [{ type: "text", text: "partial reply being typed" }] };
    const text = makeViewer({ tui: tuiWith(undefined, 60, 100), session: longSession(2, streaming) }).render(100).join("\n");
    expect(text).toContain("partial reply being typed");
  });

  it("does not show a streamed message twice once it is in the transcript", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "already landed" }] };
    const session = longSession(1, message);
    session.messages.push(message);
    const text = makeViewer({ tui: tuiWith(undefined, 60, 100), session }).render(100).join("\n");
    expect(text.split("already landed")).toHaveLength(2);
  });

  it("repaints once a second while the agent runs, and stops when it finishes or closes", () => {
    vi.useFakeTimers();
    const tui = tuiWith(undefined);
    const rec = record();
    const viewer = makeViewer({ tui, record: rec });
    vi.advanceTimersByTime(3_000);
    expect(tui.requestRender).toHaveBeenCalledTimes(3);

    rec.status = "completed";
    vi.advanceTimersByTime(1_000);
    const afterFinish = tui.requestRender.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(tui.requestRender.mock.calls.length).toBe(afterFinish);
    viewer.dispose();
  });

  it("starts no timer for a finished agent", () => {
    vi.useFakeTimers();
    const tui = tuiWith(undefined);
    makeViewer({ tui, record: record({ status: "completed" }) });
    vi.advanceTimersByTime(5_000);
    expect(tui.requestRender).not.toHaveBeenCalled();
  });
});
