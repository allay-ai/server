import { settings } from "../settings/settings";

/** A cap per key: at most `max` takes in each fixed window of `ms`. */
export interface Window {
  ms: number;
  max: number;
}

export type Take = { ok: true; release: () => void } | { ok: false; retryAfter: number };

/**
 * Counts questions per server in memory, which is enough while the backend runs as one instance.
 * Fixed windows rather than sliding ones: a burst at a boundary gets at most twice the cap.
 */
export class Limiter {
  private readonly counts = new Map<string, Array<{ start: number; count: number }>>();
  private readonly running = new Map<string, number>();

  /** Fixed caps, or a function that reads them on every take so a settings change applies at once. */
  constructor(
    private readonly caps: Window[] | (() => { windows: Window[]; concurrent: number }),
    private readonly fixedConcurrent = Number.POSITIVE_INFINITY,
  ) {}

  take(key: string, now = Date.now()): Take {
    const { windows, concurrent } = typeof this.caps === "function" ? this.caps() : { windows: this.caps, concurrent: this.fixedConcurrent };
    const counters = (this.counts.get(key) ?? windows.map(() => ({ start: now, count: 0 }))).map((c, i) =>
      now - c.start >= (windows[i]?.ms ?? 0) ? { start: now, count: 0 } : c,
    );
    for (const [i, window] of windows.entries()) {
      if (counters[i].count >= window.max) {
        this.counts.set(key, counters);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((counters[i].start + window.ms - now) / 1000)) };
      }
    }
    const running = this.running.get(key) ?? 0;
    // Busy now, not over a quota: the server can ask again in a few seconds.
    if (running >= concurrent) return { ok: false, retryAfter: 5 };
    for (const c of counters) c.count++;
    this.counts.set(key, counters);
    this.running.set(key, running + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const left = (this.running.get(key) ?? 1) - 1;
        if (left > 0) this.running.set(key, left);
        else this.running.delete(key);
      },
    };
  }
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** BYOK on a backend with billing on: free, but no free proxy. */
export const byokLimiter = () =>
  new Limiter(() => ({
    windows: [
      { ms: MINUTE, max: settings.get("BYOK_PER_MINUTE") },
      { ms: DAY, max: settings.get("BYOK_PER_DAY") },
    ],
    concurrent: settings.get("BYOK_CONCURRENT"),
  }));
/** Every server with its own key together, under one key: free questions never take every slot from paying ones. */
export const byokTotalLimiter = () => new Limiter(() => ({ windows: [], concurrent: settings.get("BYOK_ACTIVE_RUNS") }));
/** Subscriptions pay per dollar; this only keeps one server from taking every slot at once. */
export const hostedLimiter = () => new Limiter([], 4);
/** New licenses per client address (an IPv6 /64 counts as one), so nobody fills the database with them. */
export const licenseLimiter = () => new Limiter([{ ms: 3_600_000, max: 10 }]);
/** New licenses from everyone together, a ceiling for a flood from many addresses. */
export const licenseTotalLimiter = () => new Limiter([{ ms: 3_600_000, max: 500 }]);
