import { sleep } from "./retry";

/**
 * Client-side token bucket per provider: `rps` tokens refill per second, up to `burst`. Pool selection
 * checks it before sending, so calls overflow to the next provider instead of earning a 429.
 *
 * Process-local: each server instance keeps its own budget. Configure `rps` a little under the plan's
 * limit to leave room for other instances and retries.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    readonly rps: number,
    readonly burst: number = Math.max(1, rps),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.updatedAt = now();
  }

  private refill(): void {
    const at = this.now();
    const elapsed = Math.max(0, at - this.updatedAt);
    this.updatedAt = at;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rps) / 1000);
  }

  /** True when a request could be sent right now without waiting. */
  available(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  /** Takes a token only if one is free now. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /**
   * Reserves the next token and waits for it. Reservations queue in call order (tokens may go
   * negative), so concurrent waiters do not stampede.
   */
  async take(signal?: AbortSignal): Promise<void> {
    this.refill();
    this.tokens -= 1;
    if (this.tokens >= 0) return;
    await sleep(Math.ceil((-this.tokens * 1000) / this.rps), signal);
  }
}

const buckets = new Map<string, TokenBucket>();
let clock: (() => number) | null = null;

/** Shared bucket for a provider key; replaced when its rate or burst changes. */
export function rateLimiterFor(key: string, rps: number | null, burst: number | null = null): TokenBucket | null {
  if (rps === null || !(rps > 0)) return null;
  const wantBurst = burst && burst > 0 ? burst : Math.max(1, rps);
  const existing = buckets.get(key);
  if (existing && existing.rps === rps && existing.burst === wantBurst) return existing;
  const created = new TokenBucket(rps, wantBurst, clock ?? undefined);
  buckets.set(key, created);
  return created;
}

/** Test hook. */
export function resetRpcRateLimiters(nextClock: (() => number) | null = null): void {
  buckets.clear();
  clock = nextClock;
}
