/** Fleet lifecycle and in-flight activity through InteractiveMode and its actual terminal renderer. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { answer, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

/** Boot one held real child; a provider start barrier precedes every screen assertion. */
async function start(description: string) {
  fixture = new ScenarioSession();
  const p = fixture.physical("fauxchild", "child", [answer("CHILD DONE")]);
  const stream = fixture.holdStream(p);
  const h = await fixture.start({ terminal: true, harness: { sessionManager: SessionManager.create(fixture.cwd, join(fixture.root, "sessions")) } });
  h.setResponses([calls(spawn(description, { model: "fauxchild/child" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await stream.entered;
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  await host.settle();
  fixture.clock.advance(200);
  await host.settle();
  const row = () => host.viewport().find(line => /^\s+[●○] Agent\s+/.test(line)) ?? "";
  expect(host.viewport().join("\n")).toContain("SPAWNED");
  expect(host.viewport().join("\n")).toMatch(/^\s+[●○] main\s*$/m);
  expect(row()).toContain(description);
  return { h, host, stream, row };
}

it("running fleet re-registers after core reload", async () => {
  const { h, host, stream, row } = await start("probe child");
  const id = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").flatMap(m => m.content).find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  const record = fixture.record(id);
  const oldRunner = h.session.extensionRunner;
  host.input("/reload");
  host.input("\r");
  await host.settle();
  expect(h.session.extensionRunner).not.toBe(oldRunner);
  expect(host.viewport().join("\n")).toContain("Reloaded ");
  expect(record.status).toBe("running");
  expect(row()).toContain("probe child");
  // Raw fleet navigation still owns the keys after the real widget reset/rebind.
  host.input("\x1b[B");
  await host.settle();
  expect(host.viewport().join("\n")).toContain("enter view");
  stream.release();
  await record.promise;
});

it("fleet paints model and live thinking activity", async () => {
  const { host, row } = await start("probe child");
  expect(row()).toMatch(/\bchild\b/);
  fixture.clock.advance(2800);
  await host.settle();
  expect(row()).toContain("thinking · 3s");
});

it("silent stream repaints at the stall threshold without input", async () => {
  const { host, row } = await start("silent child");
  fixture.clock.advance(119_600);
  await host.settle();
  expect(row()).toContain("thinking · 1m59s");
  expect(row()).not.toContain("stalled?");
  fixture.clock.advance(199);
  await host.settle();
  expect(row()).not.toContain("stalled?");
  fixture.clock.advance(1);
  await host.settle();
  expect(row()).toContain("stalled? · 2m00s");
});

it("virtual child row repaints physical model after first response", async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  const physical = fixture.physical("fauxphys", "physical", [calls({ name: "hold", args: {} }), answer("CHILD DONE")]);
  const stream = fixture.holdStream(physical);
  const h = await fixture.start({ terminal: true });
  const model = physical.getModel();
  h.session.modelRuntime.registerVirtualModel({ provider: "vroute", id: "default", name: "vroute default", route: async () => ({ model }) });
  h.setResponses([calls(spawn("probe child", { model: "vroute/default" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await stream.entered;
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  fixture.clock.advance(200);
  await host.settle();
  const row = () => host.viewport().find(line => /^\s+[●○] Agent\s+probe child/.test(line)) ?? "";
  expect(row()).toMatch(/vroute default \(routing\) · thinking: /);
  stream.release();
  await hold.entered;
  fixture.clock.advance(200);
  await host.settle();
  expect(row()).toMatch(/physical · thinking: /);
  expect(row()).not.toContain("(routing)");
});
