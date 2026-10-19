/** Fleet -> observer -> fleet, with raw SGR wheel and close input through the real terminal. */
import { afterEach, expect, it } from "vitest";
import { answer, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

it("fleet opens viewer and raw mouse closes its footer", async () => {
  fixture = new ScenarioSession();
  const child = fixture.physical("fauxchild", "child", [answer("CHILD DONE")]);
  const stream = fixture.holdStream(child);
  const h = await fixture.start({ terminal: true });
  const host = fixture.host;
  if (!host) throw new Error("Missing terminal host");
  host.resize(120, 40);
  const prompt = Array.from({ length: 200 }, (_, i) => `- L${String(i + 1).padStart(3, "0")}`).join("\n");
  h.setResponses([calls(spawn("viewer child", { prompt, model: "fauxchild/child" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await stream.entered;
  fixture.clock.advance(200);
  await host.settle();
  const fleetRow = /^\s+[●○] Agent\s+viewer child/m;
  expect(host.viewport().join("\n")).toMatch(fleetRow);
  expect(host.viewport().join("\n")).toContain("↓ to manage");
  host.input("\x1b[B");
  await host.settle();
  expect(host.viewport().join("\n")).toContain("enter view");
  host.input("\x1b[B");
  host.input("\r");
  await host.settle();
  expect(host.viewport().join("\n")).toContain("↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");
  expect(host.viewport().join("\n")).toContain("L200");
  const first = () => {
    const numbers = host.viewport().flatMap(line => [...line.matchAll(/\bL(\d{3})\b/g)].map(m => Number(m[1])));
    expect(numbers.length).toBeGreaterThan(0);
    return Math.min(...numbers);
  };
  const start = first();
  expect(start).toBeGreaterThan(18);
  host.input("\x1b[<64;61;21M");
  await host.settle();
  expect(first()).toBe(start - 3);
  host.input("\x1b[<72;61;21M");
  await host.settle();
  expect(first()).toBe(start - 18);
  host.input("\x1b[<65;61;21M");
  await host.settle();
  expect(first()).toBe(start - 15);
  const rows = host.viewport();
  const y = rows.findLastIndex(line => line.includes("Esc close"));
  const x = (rows[y]?.indexOf("Esc close") ?? -1) + 4;
  expect(y).toBeGreaterThanOrEqual(0);
  host.input(`\x1b[<0;${x + 1};${y + 1}M`);
  host.input(`\x1b[<0;${x + 1};${y + 1}m`);
  await host.settle();
  expect(host.viewport().join("\n")).not.toContain("PgUp/PgDn or Shift+↑↓");
  expect(host.viewport().join("\n")).toMatch(fleetRow);
});
