/**
 * startup-error.ts — bridge to the host SDK's optional `ExtensionStartupError`.
 *
 * A `session_start` handler that throws `ExtensionStartupError` makes the host
 * fail the bind (no provider request, nonzero exit in the CLI modes). Hosts
 * predating that class export nothing of the sort, and this package's peer
 * range still admits them, so the class cannot be a static named import: on an
 * older host the import would fail to link and take the whole extension down
 * with an opaque error. The namespace is probed at runtime instead, and callers
 * that need the fatal path refuse clearly when it is absent.
 */

import * as hostSdk from "@earendil-works/pi-coding-agent";

/** Shape of the host's `ExtensionStartupError`: a normal `Error` constructor. */
export type StartupErrorConstructor = new (message: string, options?: ErrorOptions) => Error;

function isStartupErrorConstructor(value: unknown): value is StartupErrorConstructor {
  return typeof value === "function" && value.prototype instanceof Error;
}

/**
 * The host's `ExtensionStartupError` class, or `undefined` on a host that does
 * not export one. `sdk` defaults to the real host module; tests pass a stand-in.
 */
export function hostStartupErrorClass(sdk: object = hostSdk): StartupErrorConstructor | undefined {
  const candidate: unknown = Reflect.get(sdk, "ExtensionStartupError");
  return isStartupErrorConstructor(candidate) ? candidate : undefined;
}
