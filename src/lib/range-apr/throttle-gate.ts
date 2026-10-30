/**
 * Per-instance gate in front of a rate-limited upstream (GeckoTerminal allows ~30 calls/min per egress IP and
 * serverless IPs are shared). It does three things:
 *  - serialises calls and spaces their starts (no cold-start burst of one call per pool at once);
 *  - after a 429 it opens a cooldown (the upstream's Retry-After when given), during which calls are refused
 *    immediately instead of burning more of the quota;
 *  - lets the cooldown end on its own, so the next call after it goes through (self-healing).
 */
export type ThrottleGateOptions = {
  /** Minimum time between the starts of two calls. */
  minSpacingMs?: number;
  /** Cooldown when the upstream gives no Retry-After. */
  defaultCooldownMs?: number;
  minCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class ThrottleGate {
  private blockedUntil = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly minSpacingMs: number;
  private readonly defaultCooldownMs: number;
  private readonly minCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ThrottleGateOptions = {}) {
    this.minSpacingMs = options.minSpacingMs ?? 250;
    this.defaultCooldownMs = options.defaultCooldownMs ?? 20_000;
    this.minCooldownMs = options.minCooldownMs ?? 5_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Milliseconds until calls are allowed again (0 when open). */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Milliseconds until the next call may start (spacing and cooldown), when no call is queued. */
  nextStartInMs(): number {
    return Math.max(this.blockedForMs(), this.lastStart + this.minSpacingMs - this.now(), 0);
  }

  /** Opens (or extends) the cooldown after a 429. */
  block(retryAfterMs?: number): void {
    const wanted = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : this.defaultCooldownMs;
    const ms = Math.min(this.maxCooldownMs, Math.max(this.minCooldownMs, wanted));
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /**
   * Runs `task` after the earlier ones, at least `minSpacingMs` after the previous start. Resolves to
   * `{ blocked }` without running it when the gate is in cooldown (checked again right before starting).
   */
  run<T>(task: () => Promise<T>): Promise<{ blocked: number } | { value: T }> {
    const next = this.tail.then(async () => {
      const wait = this.lastStart + this.minSpacingMs - this.now();
      if (wait > 0) await this.sleep(wait);
      const blocked = this.blockedForMs();
      if (blocked > 0) return { blocked };
      this.lastStart = this.now();
      return { value: await task() };
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
