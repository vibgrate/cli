import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  loadSubscriptionState,
  onDemandPollAllowed,
  pollIntervalSeconds,
  recordWindowReset,
  resetSubscriptionState,
  shouldPoll,
  subscriptionStatePath,
  trackUsage,
  trackingEnabled,
  windowStatus,
} from './subscription.js';

const envFor = (): NodeJS.ProcessEnv => ({ VG_CONTEXT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sub-')) });
const H = 60 * 60 * 1000;

describe('subscription windows', () => {
  it('records usage (0600, atomic), sums rolling 5 h / 7 d windows, prunes beyond 7 d', () => {
    const env = envFor();
    const now = 100 * 24 * H;
    trackUsage({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, tokensSaved: 400, model: 'm' }, env, now - 8 * 24 * H); // pruned
    trackUsage({ inputTokens: 500, outputTokens: 50 }, env, now - 6 * H); // 7d only
    trackUsage({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 150, tokensSaved: 80 }, env, now - H); // both
    trackUsage({ inputTokens: 100, outputTokens: 10, tokensSaved: 20 }, env, now);
    expect(fs.statSync(subscriptionStatePath(env)).mode & 0o777).toBe(0o600);
    const s = windowStatus(now, env);
    expect(s.enabled).toBe(true);
    expect(s.pollIntervalSeconds).toBe(300);
    expect(s.fiveHour).toMatchObject({ start: now - FIVE_HOUR_MS, end: now, requests: 2, inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, tokensSaved: 100, cacheMissSuspected: false, surgeSuspected: false });
    expect(s.sevenDay).toMatchObject({ start: now - SEVEN_DAY_MS, end: now, requests: 3, inputTokens: 800, outputTokens: 80, tokensSaved: 100 });
    expect(loadSubscriptionState(env).events).toHaveLength(3);
    // Deterministic: same state, same now → deep-equal status.
    expect(windowStatus(now, env)).toEqual(s);
  });

  it('opt-out and poll interval knobs', () => {
    const env = { ...envFor(), VG_SUBSCRIPTION_TRACKING: 'false', VG_SUBSCRIPTION_POLL_INTERVAL: '99999' };
    expect(trackingEnabled(env)).toBe(false);
    expect(pollIntervalSeconds(env)).toBe(3600);
    expect(pollIntervalSeconds({ VG_SUBSCRIPTION_POLL_INTERVAL: '0' })).toBe(1);
    trackUsage({ inputTokens: 1, outputTokens: 1 }, env, 1000);
    expect(fs.existsSync(subscriptionStatePath(env))).toBe(false);
    expect(windowStatus(1000, env).enabled).toBe(false);
    expect(shouldPoll(loadSubscriptionState(env), 1000, env)).toBe(false);
  });

  it('anchors: a provider reset time bounds the window; only a forward jump > 1 min is a rollover', () => {
    const env = envFor();
    const now = 50 * 24 * H;
    const resetsAt = now + 2 * H;
    let r = recordWindowReset('fiveHour', { resetsAt, utilizationPct: 40 }, env, now);
    expect(r.rolledOver).toBe(false);
    trackUsage({ inputTokens: 10, outputTokens: 1 }, env, now - 4 * H); // outside the anchored window (starts at resetsAt - 5h = now - 3h)
    trackUsage({ inputTokens: 20, outputTokens: 2 }, env, now - 2 * H);
    let s = windowStatus(now, env);
    expect(s.fiveHour).toMatchObject({ start: resetsAt - FIVE_HOUR_MS, end: resetsAt, requests: 1, inputTokens: 20, utilizationPct: 40 });
    // Jitter within a minute: not a rollover.
    r = recordWindowReset('fiveHour', { resetsAt: resetsAt + 1000 }, env, now + 1000);
    expect(r.rolledOver).toBe(false);
    // Forward jump by a full window: rollover.
    r = recordWindowReset('fiveHour', { resetsAt: resetsAt + FIVE_HOUR_MS }, env, resetsAt + 1);
    expect(r.rolledOver).toBe(true);
    s = windowStatus(resetsAt + 1, env);
    expect(s.fiveHour.requests).toBe(0);
    expect(s.lastPollAt).toBe(resetsAt + 1);
    // A stale anchor (reset already passed) falls back to a rolling window.
    s = windowStatus(resetsAt + FIVE_HOUR_MS + 10, env);
    expect(s.fiveHour.start).toBe(resetsAt + FIVE_HOUR_MS + 10 - FIVE_HOUR_MS);
  });

  it('anomaly flags: cache-miss (< 10 % cache reads over 50k input) and surge (utilisation far ahead of elapsed)', () => {
    const env = envFor();
    const now = 10 * 24 * H;
    trackUsage({ inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 1000 }, env, now);
    expect(windowStatus(now, env).fiveHour.cacheMissSuspected).toBe(true);
    expect(windowStatus(now, env).fiveHour.surgeSuspected).toBe(false);
    recordWindowReset('fiveHour', { resetsAt: now + 4 * H, utilizationPct: 90 }, env, now); // 20 % elapsed, 90 % used
    expect(windowStatus(now, env).fiveHour.surgeSuspected).toBe(true);
  });

  it('polling cadence: only while active in the last minute, at the configured interval; on-demand floor 60 s', () => {
    const env = envFor();
    const now = 1_000_000_000;
    expect(shouldPoll(loadSubscriptionState(env), now, env)).toBe(false);
    trackUsage({ inputTokens: 1, outputTokens: 1 }, env, now);
    let state = loadSubscriptionState(env);
    expect(shouldPoll(state, now + 1000, env)).toBe(true);
    expect(shouldPoll(state, now + 61_000, env)).toBe(false);
    state = recordWindowReset('sevenDay', { resetsAt: now + SEVEN_DAY_MS }, env, now + 1000).state;
    expect(shouldPoll(state, now + 2000, env)).toBe(false);
    expect(shouldPoll({ ...state, lastActivityAt: now + 300_000 }, now + 1000 + 300_000, env)).toBe(true);
    expect(onDemandPollAllowed(state, now + 30_000)).toBe(false);
    expect(onDemandPollAllowed(state, now + 61_000)).toBe(true);
    expect(resetSubscriptionState(env)).toBe(true);
    expect(resetSubscriptionState(env)).toBe(false);
    expect(loadSubscriptionState(env).events).toEqual([]);
  });
});
