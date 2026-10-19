/** Exercise the factory through registered tools, session events and detached delivery. */
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { spoolDetached } from "../src/detached-results.js";
import subagentsExtension, { createSubagentsExtension } from "../src/index.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;
afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx());
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

async function boot(factory: ExtensionFactory) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, fallbackSubagent: "none" } });
  const b = makePi();
  booted = b;
  await factory(b.pi);
  const sessionFile = join(hermetic.dir, "parent.jsonl");
  const parent = ctx({ sessionManager: { getSessionId: () => "clock", getSessionFile: () => sessionFile } });
  await b.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" }, parent);
  return { ...b, parent, sessionFile, storePath: resolveStorePath(hermetic.dir, "clock") };
}

it("threads the factory clock into scheduling and the idle completion outbox", async () => {
  const clock = new FakeClock();
  const b = await boot(createSubagentsExtension({ clock }));
  await b.tools.get("Agent").execute("scheduled", {
    prompt: "later", description: "later", subagent_type: "general-purpose", schedule: "+1s",
  }, undefined, undefined, b.parent);
  const job = new ScheduleStore(b.storePath).list()[0];
  expect(job.schedule).toBe("2020-01-01T00:00:01.000Z");
  // Change the persisted type before it fires: the real scheduler must validate it,
  // without making this boundary test depend on a model/provider or a child process.
  const store = new ScheduleStore(b.storePath);
  store.update(job.id, { subagent_type: "deleted-agent" });
  // The scheduler reads its own store cache, so rebind as a resumed activation would.
  await b.lifecycle.get("session_before_switch")?.({ type: "session_shutdown", reason: "quit" }, b.parent);
  await b.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" }, b.parent);
  clock.advance(999);
  expect(new ScheduleStore(b.storePath).get(job.id)?.lastStatus).toBeUndefined();
  clock.advance(1);
  expect(new ScheduleStore(b.storePath).get(job.id)?.lastStatus).toBe("error");
  expect(b.pi.events.emit.mock.calls).toContainEqual(["subagents:scheduled", expect.objectContaining({
    type: "error", error: expect.stringContaining("Unknown or disabled agent type"),
  })]);

  spoolDetached(b.sessionFile, { id: "done", content: "child completed", details: { id: "done" } });
  clock.advance(199);
  expect(b.pi.sendMessage).not.toHaveBeenCalled();
  clock.advance(1);
  expect(b.pi.sendMessage.mock.calls).toEqual([[expect.objectContaining({ content: "child completed" }), { deliverAs: "steer", triggerTurn: true }]]);
});

it("keeps the default export on real time without a clock option", async () => {
  const b = await boot(subagentsExtension);
  const before = Date.now();
  await b.tools.get("Agent").execute("real", {
    prompt: "later", description: "real", subagent_type: "general-purpose", schedule: "+1h",
  }, undefined, undefined, b.parent);
  const after = Date.now();
  const job = new ScheduleStore(b.storePath).list()[0];
  expect(Date.parse(job.createdAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(job.createdAt)).toBeLessThanOrEqual(after);
  expect(Date.parse(job.schedule)).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(Date.parse(job.schedule)).toBeLessThanOrEqual(after + 3_600_000);
});
