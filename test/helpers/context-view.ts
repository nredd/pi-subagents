/**
 * context-view.ts — read the tools and system prompt a model call actually saw.
 *
 * Pi <1.0 passed them as `context.tools` / `context.systemPrompt`. Pi 1.0 carries
 * both as leading `role: "system"` messages (`toolsAdded` / `toolsRemoved` /
 * `content` / `sections`) and replays them. This replays the same way so the
 * e2e responders work on either side of the change.
 */
import type { Context } from "@earendil-works/pi-ai";

interface SystemMessageLike {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: Array<{ name: string }>;
  toolsRemoved?: Array<{ name: string }>;
}

function systemMessages(ctx: Context): SystemMessageLike[] {
  return (ctx.messages as unknown as SystemMessageLike[]).filter(m => m.role === "system");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(b => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("");
}

/** Names of the tools declared to the model for this call. */
export function contextToolNames(ctx: Context): string[] {
  const legacy = (ctx as { tools?: Array<{ name: string }> }).tools;
  if (legacy) return legacy.map(t => t.name);
  const names = new Set<string>();
  for (const m of systemMessages(ctx)) {
    for (const t of m.toolsRemoved ?? []) names.delete(t.name);
    for (const t of m.toolsAdded ?? []) names.add(t.name);
  }
  return [...names];
}

/** The full system prompt text (base content plus sections) for this call. */
export function contextSystemPrompt(ctx: Context): string {
  const legacy = (ctx as { systemPrompt?: string }).systemPrompt;
  if (legacy !== undefined) return legacy;
  const parts: string[] = [];
  const sections = new Map<string, string>();
  for (const m of systemMessages(ctx)) {
    const text = textOf(m.content);
    if (text) parts.push(text);
    for (const [name, value] of Object.entries(m.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [...parts, ...sections.values()].join("\n\n");
}
