/**
 * Token-bucket rate limiter: two buckets per key (requests and tokens),
 * seeded full, refilled continuously. Keys are `${apiKey[:16]}:${clientIp}`
 * (or the bare IP) so a spoofed forwarded header cannot rotate buckets.
 * Bounded at 1000 keys; over the cap, buckets idle > 600 s are dropped.
 */

export const MAX_RATE_LIMITER_BUCKETS = 1000;
export const STALE_BUCKET_SECONDS = 600;

interface Bucket {
  tokens: number;
  lastUpdate: number;
}

export function refilledTokens(current: number, lastUpdate: number, now: number, ratePerMinute: number): number {
  const elapsed = Math.max(0, (now - lastUpdate) / 1000);
  return Math.min(ratePerMinute, current + (elapsed * ratePerMinute) / 60);
}

export function consumeFromBucket(available: number, requested: number, ratePerMinute: number): { allowed: boolean; remaining: number; waitSeconds: number } {
  if (available >= requested) return { allowed: true, remaining: available - requested, waitSeconds: 0 };
  const wait = ratePerMinute > 0 ? ((requested - available) * 60) / ratePerMinute : 60;
  return { allowed: false, remaining: available, waitSeconds: wait };
}

export interface RateLimitVerdict {
  allowed: boolean;
  waitSeconds: number;
  /** `Retry-After` header value: int(wait) + 1. */
  retryAfter: number;
  kind?: 'requests' | 'tokens';
}

export class RateLimiter {
  private readonly requests = new Map<string, Bucket>();
  private readonly tokens = new Map<string, Bucket>();
  constructor(
    public rpm: number,
    public tpm: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return this.rpm > 0 || this.tpm > 0;
  }

  private bucket(map: Map<string, Bucket>, key: string, cap: number): Bucket {
    let b = map.get(key);
    if (!b) {
      if (map.size > MAX_RATE_LIMITER_BUCKETS) this.cleanup();
      b = { tokens: cap, lastUpdate: this.now() };
      map.set(key, b);
    }
    return b;
  }

  private cleanup(): number {
    const t = this.now();
    let n = 0;
    for (const [k, b] of this.requests) {
      if (t - b.lastUpdate > STALE_BUCKET_SECONDS * 1000) {
        this.requests.delete(k);
        this.tokens.delete(k);
        n++;
      }
    }
    return n;
  }

  /** Consume one request and `tokenCount` tokens for `key`; both must pass. */
  check(key: string, tokenCount = 0): RateLimitVerdict {
    const t = this.now();
    if (this.rpm > 0) {
      const b = this.bucket(this.requests, key, this.rpm);
      const available = refilledTokens(b.tokens, b.lastUpdate, t, this.rpm);
      b.lastUpdate = t;
      const r = consumeFromBucket(available, 1, this.rpm);
      b.tokens = r.remaining;
      if (!r.allowed) return { allowed: false, waitSeconds: r.waitSeconds, retryAfter: Math.floor(r.waitSeconds) + 1, kind: 'requests' };
    }
    if (this.tpm > 0 && tokenCount > 0) {
      const b = this.bucket(this.tokens, key, this.tpm);
      const available = refilledTokens(b.tokens, b.lastUpdate, t, this.tpm);
      b.lastUpdate = t;
      const r = consumeFromBucket(available, tokenCount, this.tpm);
      b.tokens = r.remaining;
      if (!r.allowed) return { allowed: false, waitSeconds: r.waitSeconds, retryAfter: Math.floor(r.waitSeconds) + 1, kind: 'tokens' };
    }
    return { allowed: true, waitSeconds: 0, retryAfter: 0 };
  }

  stats(): { requestsPerMinute: number; tokensPerMinute: number; activeKeys: number } {
    return { requestsPerMinute: this.rpm, tokensPerMinute: this.tpm, activeKeys: this.requests.size };
  }
}

/** `${apiKey[:16]}:${ip}` or the bare ip. Never stores the full key. */
export function rateLimitKey(headers: Record<string, string>, clientIp: string): string {
  const key = headers['x-api-key'] ?? headers['api-key'] ?? headers['x-goog-api-key'] ?? headers.authorization?.replace(/^bearer\s+/i, '') ?? '';
  return key ? `${key.slice(0, 16)}:${clientIp}` : clientIp;
}
