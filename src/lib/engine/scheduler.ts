// Adaptive concurrency: probe upward while throughput keeps improving, back off on
// throttling/errors (AIMD-style, like TCP congestion control). Pure & unit-tested.

export interface ConcurrencyOptions {
  min: number;
  max: number;
  initial: number;
}

export class AdaptiveConcurrency {
  limit: number;
  private bytes = 0;
  private rate = 0;
  private best = 0;
  private lastMove: 'up' | 'down' | 'hold' = 'hold';
  private holdTicks = 0;
  private ticks = 0;

  constructor(private o: ConcurrencyOptions) {
    this.limit = Math.max(o.min, Math.min(o.max, o.initial));
  }

  setMax(max: number) {
    this.o.max = Math.max(this.o.min, max);
    this.limit = Math.min(this.limit, this.o.max);
  }

  record(n: number) {
    this.bytes += n;
  }

  /** Current smoothed throughput in bytes/s. */
  get throughput() {
    return this.rate;
  }

  /**
   * Call once per `intervalMs`. `saturated` = all slots were busy during the interval
   * (no point growing if the queue can't feed more connections).
   */
  tick(intervalMs: number, saturated: boolean): number {
    const sample = (this.bytes * 1000) / intervalMs;
    this.bytes = 0;
    this.rate = this.rate ? this.rate * 0.6 + sample * 0.4 : sample;
    this.ticks++;
    if (this.holdTicks > 0) {
      this.holdTicks--;
      return this.limit;
    }
    if (this.ticks % 2) return this.limit;

    if (this.rate > this.best * 1.04) {
      this.best = this.rate;
      if (saturated && this.limit < this.o.max) {
        this.limit = Math.min(this.o.max, this.limit + (this.limit < 8 ? 2 : 1));
        this.lastMove = 'up';
        return this.limit;
      }
    } else if (this.lastMove === 'up' && this.rate < this.best * 0.85) {
      // The last increase hurt → step back and settle for a while.
      this.limit = Math.max(this.o.min, this.limit - 1);
      this.lastMove = 'down';
      this.holdTicks = 6;
      return this.limit;
    } else if (saturated && this.limit < this.o.max && this.ticks % 8 === 0) {
      // Periodically re-probe: networks change.
      this.limit++;
      this.lastMove = 'up';
    }
    this.best *= 0.985;
    return this.limit;
  }

  /** Server pushed back (429/503) or connections are failing → multiplicative decrease. */
  throttle() {
    this.limit = Math.max(this.o.min, Math.floor(this.limit * 0.6));
    this.best = this.rate;
    this.lastMove = 'down';
    this.holdTicks = 10;
  }
}

/** Exponential backoff with full jitter, honoring Retry-After. */
export function backoff(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null) return Math.min(60_000, retryAfterMs + Math.random() * 500);
  const cap = Math.min(30_000, 400 * 2 ** attempt);
  return cap / 2 + Math.random() * (cap / 2);
}

/** Choose chunk size for ranged parallel downloads of a single file. */
export function chunkPlan(size: number, maxConnections: number): { chunk: number; count: number } {
  const MB = 1024 * 1024;
  if (size <= 2 * MB) return { chunk: size, count: 1 };
  const target = Math.ceil(size / (maxConnections * 4));
  const chunk = Math.min(32 * MB, Math.max(1 * MB, Math.ceil(target / (256 * 1024)) * 256 * 1024));
  return { chunk, count: Math.ceil(size / chunk) };
}
