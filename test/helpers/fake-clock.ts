import type { Clock } from "../../src/clock.js";

/** Independent clock: advances callbacks by deadline, without patching globals or sleeping. */
export class FakeClock implements Clock {
  private time = Date.parse("2020-01-01T00:00:00.000Z");
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void; interval?: number }>();

  now(): number { return this.time; }
  get pending(): number { return this.timers.size; }

  setTimeout(callback: () => void, ms: number) { return this.schedule(callback, ms); }
  setInterval(callback: () => void, ms: number) { return this.schedule(callback, ms, ms); }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.interval === undefined) this.timers.delete(id);
      else timer.at += timer.interval;
      timer.callback();
    }
    this.time = end;
  }

  private schedule(callback: () => void, ms: number, interval?: number) {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + ms, callback, interval });
    return { cancel: () => { this.timers.delete(id); } };
  }
}
