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
  /**
   * After the first 429 (`block()`), refuse every later call for the gate's lifetime instead of reopening when the
   * cooldown ends. The cron gate (one per run) uses it: a 429 ends the run, nothing calls GeckoTerminal again.
   */
  stickyBlock?: boolean;
  /**
   * Attempts per call (callers cap their retries to this). The cron gate uses 1: a retry inside a gate slot would
   * start without the gate's spacing.
   */
  maxAttempts?: number;
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
  private readonly stickyBlock: boolean;
  /** Attempts per call; callers cap their retries to this (see `ThrottleGateOptions.maxAttempts`). */
  readonly maxAttempts: number;
  /** Set by the first `block()` (a 429) and never cleared: the cron run checks it to end the run. */
  hit429 = false;

  constructor(options: ThrottleGateOptions = {}) {
    this.minSpacingMs = options.minSpacingMs ?? 250;
    this.defaultCooldownMs = options.defaultCooldownMs ?? 20_000;
    this.minCooldownMs = options.minCooldownMs ?? 5_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.stickyBlock = options.stickyBlock ?? false;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? Number.POSITIVE_INFINITY);
  }

  /** Milliseconds until calls are allowed again (0 when open). */
  blockedForMs(): number {
    const cooling = Math.max(0, this.blockedUntil - this.now());
    // Sticky: still blocked after the cooldown (reported as the minimum cooldown for messages).
    return this.stickyBlock && this.hit429 ? Math.max(cooling, this.minCooldownMs) : cooling;
  }

  /** Milliseconds until the next call may start (spacing and cooldown), when no call is queued. */
  nextStartInMs(): number {
    return Math.max(this.blockedForMs(), this.lastStart + this.minSpacingMs - this.now(), 0);
  }

  /** Opens (or extends) the cooldown after a 429. */
  block(retryAfterMs?: number): void {
    const wanted = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : this.defaultCooldownMs;
    const ms = Math.min(this.maxCooldownMs, Math.max(this.minCooldownMs, wanted));
    this.hit429 = true;
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
