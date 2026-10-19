/** Real parent/child sessions with explicit homes, provider barriers and one extension clock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, type FauxProviderRegistration, type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness, type HarnessOptions } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { createSubagentsExtension } from "../../src/index.js";
import type { AgentRecord } from "../../src/types.js";
import { FakeClock } from "./fake-clock.js";

export { fauxAssistantMessage as answer } from "@earendil-works/pi-ai/compat";

/** An explicit rendezvous, never a polling loop or elapsed-time wait. */
export function barrier<T = void>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A real model turn containing tool calls. */
export function calls(...specs: { name: string; args: Record<string, unknown> }[]) {
  return fauxAssistantMessage(specs.map(spec => fauxToolCall(spec.name, spec.args)), { stopReason: "toolUse" });
}

/** Default child spawn; callers override only the scenario's distinguishing arguments. */
export function spawn(description: string, extra: Record<string, unknown> = {}) {
  return { name: "Agent", args: { subagent_type: "general-purpose", description, prompt: "work", model: "kid/child", run_in_background: true, ...extra } };
}

/** Extract text from persisted host messages or tool results without assuming one content block. */
export function text(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("\n");
}

/** Settled results from the real host tool pipeline, including error status. */
export function outcomes(h: Harness, name: string) {
  const ended = new Map(h.eventsOfType("tool_execution_end").map(event => [event.toolCallId, event]));
  return h.eventsOfType("tool_execution_start").filter(event => event.toolName === name).flatMap(start => {
    const event = ended.get(start.toolCallId);
    return event ? [{ text: text(event.result), isError: event.isError }] : [];
  });
}

/** Completion notices as actually delivered to the parent transcript. */
export function notices(h: Harness) {
  return h.session.messages.filter(m => m.role === "custom" && m.customType === "subagent-notification").map(text);
}

/** Listen before starting a real turn; unsubscribe at the exact event. */
export function nextEvent(h: Harness, predicate: (event: AgentSessionEvent) => boolean) {
  const done = barrier<AgentSessionEvent>();
  const off = h.session.subscribe(event => { if (predicate(event)) { off(); done.resolve(event); } });
  return done.promise;
}

/** Own the global-discovery inputs until every child has settled and shut down. */
export class ScenarioSession {
  readonly root = mkdtempSync(join(tmpdir(), "subagent-scenarios-"));
  readonly cwd = join(this.root, "work");
  readonly agentDir = join(this.root, "agent");
  readonly clock = new FakeClock();
  readonly providers: FauxProviderRegistration[] = [];
  readonly admission = barrier();
  private readonly previousCwd = process.cwd();
  private readonly previousHome = process.env.HOME;
  private readonly previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  private h?: Harness;
  host?: InteractiveHarness;
  pi?: ExtensionAPI;
  private releases: (() => void)[] = [];
  private readonly transports = new Map<string, NonNullable<ReturnType<typeof getApiProvider>>>();

  constructor(settings: Record<string, unknown> = {}) {
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.agentDir, { recursive: true });
    process.chdir(this.cwd);
    process.env.HOME = this.root;
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    this.settings(settings);
  }

  /** Persist complete per-test settings, independent of machine defaults. */
  settings(extra: Record<string, unknown>) {
    writeFileSync(join(this.agentDir, "subagents.json"), JSON.stringify({ outputTranscript: true, rememberAgents: false, defaultJoinMode: "async", showModel: true, widgetMode: "off", ...extra }));
  }

  /** Register an explicit, credential-free physical transport before host construction. */
  physical(provider = "kid", id = "child", responses: FauxResponseStep[] = []) {
    const p = registerFauxProvider({ provider, models: [{ id }] });
    p.setResponses(responses);
    this.providers.push(p);
    const transport = getApiProvider(p.api);
    if (!transport) throw new Error(`Missing transport ${p.api}`);
    this.transports.set(p.api, transport);
    if (this.h) this.installProvider(this.h, p);
    return p;
  }

  /** Hold an open provider stream with start already visible to the production observer. */
  holdStream(p: FauxProviderRegistration) {
    const entered = barrier();
    const release = barrier();
    const delegate = getApiProvider(p.api);
    if (!delegate) throw new Error(`Missing transport ${p.api}`);
    const stream: typeof delegate.streamSimple = (model, context, options) => {
      const output = new AssistantMessageEventStream();
      output.push({ type: "start", partial: { ...fauxAssistantMessage(""), provider: model.provider, model: model.id, api: model.api } });
      entered.resolve();
      void release.promise.then(async () => {
        const inner = delegate.streamSimple(model, context, options);
        for await (const event of inner) output.push(event);
        output.end(await inner.result());
      });
      return output;
    };
    registerApiProvider({ ...delegate, stream, streamSimple: stream }, this.root);
    this.releases.push(() => release.resolve());
    return { entered: entered.promise, release: () => release.resolve() };
  }

  /** Install a tool held by a promise in both the parent and real disk-discovered child. */
  heldTool() {
    const entered = barrier();
    const release = barrier();
    const execute = async () => { entered.resolve(); await release.promise; return { content: [{ type: "text" as const, text: "SLEPT" }] }; };
    Reflect.set(globalThis, "__subagentScenarioHold", execute);
    const extensions = join(this.cwd, ".pi", "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(join(extensions, "hold.ts"), 'import { Type } from "typebox";\nexport default pi => pi.registerTool({ name: "hold", label: "hold", description: "Promise barrier", parameters: Type.Object({}), execute: globalThis.__subagentScenarioHold });\n');
    this.releases.push(() => release.resolve());
    const factory: ExtensionFactory = pi => {
      pi.registerTool({ name: "hold", label: "hold", description: "Promise barrier", parameters: { type: "object", properties: {} }, execute });
    };
    return { entered: entered.promise, release: () => release.resolve(), factory };
  }

  /** Bind the actual extension; admission replies are an optional advisory-service double. */
  async start(options: { terminal?: boolean; noRouter?: boolean; factories?: ExtensionFactory[]; harness?: HarnessOptions } = {}) {
    const observer: ExtensionFactory = pi => {
      this.pi = pi;
      pi.events.on("router:rpc:admit", raw => {
        this.admission.resolve();
        if (!options.noRouter) {
          const { requestId } = raw as { requestId: string };
          pi.events.emit(`router:rpc:admit:reply:${requestId}`, { success: true, data: { ok: true } });
        }
      });
    };
    const config: HarnessOptions = {
      cwd: this.cwd,
      settings: { retry: { enabled: false }, compaction: { enabled: false }, fullscreenWheelScrollLines: 3, fullscreenScrollbar: "hidden" },
      extensionFactories: [createSubagentsExtension({ clock: this.clock }), observer, ...(options.factories ?? [])],
      ...options.harness,
    };
    if (options.terminal) {
      this.host = await createInteractiveHarness({ ...config, columns: 160, rows: 40 });
      this.h = this.host.harness;
    } else {
      this.h = await createHarness(config);
      await this.h.session.bindExtensions({ mode: "print" });
    }
    for (const p of this.providers) this.installProvider(this.h, p);
    return this.h;
  }

  /** Core reload clears global transports; restore owned doubles, never a live credential provider. */
  restoreProviders(h: Harness) {
    for (const transport of this.transports.values()) registerApiProvider(transport, this.root);
    for (const p of this.providers) this.installProvider(h, p);
  }

  /** Get the public manager registry's actual record after a real Agent result. */
  record(id: string): AgentRecord {
    const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { getRecord(id: string): AgentRecord | undefined };
    const record = manager.getRecord(id);
    if (!record) throw new Error(`No record ${id}`);
    return record;
  }

  /** Await the lifecycle event rather than racing its completion callback. */
  completion() {
    const done = barrier();
    if (!this.pi) throw new Error("Host not started");
    const off = this.pi.events.on("subagents:completed", () => { off(); done.resolve(); });
    return done.promise;
  }

  /** Release every held producer before disposing sessions or restoring discovery paths. */
  async dispose() {
    try {
      for (const release of this.releases) release();
      const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { waitForAll(): Promise<void> } | undefined;
      await manager?.waitForAll();
      if (this.host) await this.host.dispose();
      else if (this.h) {
        await this.h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        this.h.cleanup();
      }
    } finally {
      unregisterApiProviders(this.root);
      for (const p of this.providers) p.unregister();
      Reflect.deleteProperty(globalThis, "__subagentScenarioHold");
      process.chdir(this.previousCwd);
      if (this.previousHome === undefined) delete process.env.HOME; else process.env.HOME = this.previousHome;
      if (this.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = this.previousAgentDir;
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  private installProvider(h: Harness, p: FauxProviderRegistration) {
    const model = p.getModel();
    h.session.modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "faux", api: p.api, models: p.models });
  }
}
