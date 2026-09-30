/**
 * quota-admission.ts — ask a subscription router whether a dispatch may start.
 *
 * Quota tracking lives in a separate extension (nredd/pi-subscription-router),
 * reached over `pi.events` with the same envelope as `cross-extension-rpc.ts`:
 * emit `router:rpc:admit` `{ requestId, model }`, reply on
 * `router:rpc:admit:reply:<requestId>` as `{ success, data?: { ok, resolvedModel?, resetAt? } }` (`resolvedModel` is ignored).
 *
 * Admission fails open. No router installed, a slow router, a malformed reply
 * or a router error all admit the dispatch: quota is advisory here, and the
 * router still routes (or fails) each request inside the child.
 */

import { nanoid } from "nanoid";

export const ADMIT_CHANNEL = "router:rpc:admit";

/**
 * How long to wait for a reply. The router answers from cached state within
 * the same macrotask, so this only bounds the cost when no router is installed.
 */
const ADMIT_TIMEOUT_MS = 100;

/** Minimal `pi.events` surface. */
export interface AdmissionEvents {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** A dispatch the router refused, with the earliest known reset (epoch ms). */
export interface QuotaBlock {
  model: string;
  resetAt?: number;
}

/** `provider/id` for a model, the key the router expects. */
export function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Resolve to the block when the router refuses `model`, else undefined. */
export function checkAdmission(
  events: AdmissionEvents,
  model: string,
  timeoutMs = ADMIT_TIMEOUT_MS,
): Promise<QuotaBlock | undefined> {
  const requestId = nanoid();
  return new Promise(resolve => {
    let done = false;
    const finish = (block: QuotaBlock | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(block);
    };
    const unsubscribe = events.on(`${ADMIT_CHANNEL}:reply:${requestId}`, raw => {
      const reply = raw as { success?: unknown; data?: { ok?: unknown; resetAt?: unknown } } | undefined;
      if (reply?.success !== true || reply.data?.ok !== false) return finish(undefined);
      const resetAt = reply.data.resetAt;
      finish({ model, resetAt: typeof resetAt === "number" && Number.isFinite(resetAt) ? resetAt : undefined });
    });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    events.emit(ADMIT_CHANNEL, { requestId, model });
  });
}

/** One-line reason for a refused dispatch. */
export function describeBlock(block: QuotaBlock): string {
  const when = block.resetAt === undefined ? "an unknown time" : new Date(block.resetAt).toISOString();
  return `Subscription quota for ${block.model} is exhausted; it resets at ${when}.`;
}

/** Delay past a reported reset before a parked dispatch starts, so usage has refilled. */
export const QUOTA_RESTART_GRACE_MS = 60_000;

/**
 * Delay before re-admitting a parked dispatch whose reset passed while pi was
 * closed. The router warms its usage cache on session_start; asking before that
 * finishes would always fail open.
 */
export const PARKED_RESUME_DELAY_MS = 10_000;
