/** A timer owns cancellation, without requiring a Node-specific handle. */
export interface TimerHandle {
  cancel(): void;
}

/** Scheduling boundary, structurally compatible with pi-session-kit's clock. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  setInterval(callback: () => void, ms: number): TimerHandle;
}

/** Native timers keep their original reference/unref behavior; cancellation uses the native clear functions. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(timer) };
  },
  setInterval(callback, ms) {
    const timer = setInterval(callback, ms);
    return { cancel: () => clearInterval(timer) };
  },
};
