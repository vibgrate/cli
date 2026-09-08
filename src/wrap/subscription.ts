/**
 * Subscription-window tracker: how much of a 5-hour and a 7-day usage window
 * has been consumed, and how much the proxy saved inside each — for plans
 * billed by rolling windows rather than by token.
 *
 * Local-only: usage is recorded from what the proxy observes; windows are
 * rolling from `now` unless the provider advertises a reset time, in which
 * case a rollover is accepted only for a *forward* jump larger than a minute
 * (reset times jitter by a second between polls). State is a small JSON file
 * under `contextDir()`, 0600, written atomically; events older than 7 days
 * are pruned on every write. Opt-out: `VG_SUBSCRIPTION_TRACKING=false`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { contextDir } from '../compress/paths.js';
import { env as knobs } from '../compress/config.js';
import { readJsonSafe, writePrivateFile } from './edit.js';

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
export const ROLLOVER_MIN_ADVANCE_MS = 60 * 1000;
export const ACTIVE_WINDOW_MS = 60 * 1000;
export const ON_DEMAND_POLL_FLOOR_MS = 60 * 1000;
export const SURGE_THRESHOLD_PCT = 15;
export const CACHE_MISS_RATIO_THRESHOLD = 0.1;
export const CACHE_MISS_MIN_INPUT_TOKENS = 50_000;

export type WindowKind = 'fiveHour' | 'sevenDay';

export interface UsageEvent {
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Tokens the proxy removed before the request left the machine. */
  tokensSaved?: number;
  model?: string;
}

export interface WindowAnchor {
  /** Provider-reported reset time (ms). */
  resetsAt: number;
  /** Provider-reported utilisation 0–100 at the last poll. */
  utilizationPct?: number;
}

export interface SubscriptionState {
  version: 1;
  events: UsageEvent[];
  anchors: Partial<Record<WindowKind, WindowAnchor>>;
  lastPollAt?: number;
  lastActivityAt?: number;
}

export interface WindowStatus {
  kind: WindowKind;
  start: number;
  end: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tokensSaved: number;
  /** Provider utilisation when known. */
  utilizationPct?: number;
  /** Expected utilisation from local token counts (percent of the previous poll's pace) — heuristic. */
  cacheMissSuspected: boolean;
  surgeSuspected: boolean;
}

export interface SubscriptionStatus {
  enabled: boolean;
  pollIntervalSeconds: number;
  fiveHour: WindowStatus;
  sevenDay: WindowStatus;
  lastPollAt?: number;
}

export function subscriptionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(contextDir(env), 'subscription-state.json');
}

export function trackingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return knobs.bool('VG_SUBSCRIPTION_TRACKING', env);
}

/** Poll cadence in seconds, clamped to 1..3600. */
export function pollIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return knobs.int('VG_SUBSCRIPTION_POLL_INTERVAL', env, { min: 1, max: 3600 });
}

function emptyState(): SubscriptionState {
  return { version: 1, events: [], anchors: {} };
}

export function loadSubscriptionState(env: NodeJS.ProcessEnv = process.env): SubscriptionState {
  const s = readJsonSafe<SubscriptionState>(subscriptionStatePath(env));
  if (!s || s.version !== 1 || !Array.isArray(s.events)) return emptyState();
  return { ...emptyState(), ...s, anchors: s.anchors && typeof s.anchors === 'object' ? s.anchors : {} };
}

export function saveSubscriptionState(state: SubscriptionState, env: NodeJS.ProcessEnv = process.env): string {
  const file = subscriptionStatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivateFile(file, `${JSON.stringify(state)}\n`);
  return file;
}

function pruneEvents(events: UsageEvent[], now: number): UsageEvent[] {
  const floor = now - SEVEN_DAY_MS;
  return events.filter((e) => e.ts >= floor && e.ts <= now).sort((a, b) => a.ts - b.ts);
}

/** Record one request's usage. No-op when tracking is off. Returns the new state. */
export function trackUsage(usage: Omit<UsageEvent, 'ts'> & { ts?: number }, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): SubscriptionState {
  const state = loadSubscriptionState(env);
  if (!trackingEnabled(env)) return state;
  const ev: UsageEvent = {
    ts: usage.ts ?? now,
    inputTokens: Math.max(0, Math.floor(usage.inputTokens || 0)),
    outputTokens: Math.max(0, Math.floor(usage.outputTokens || 0)),
  };
  if (usage.cacheReadTokens) ev.cacheReadTokens = Math.max(0, Math.floor(usage.cacheReadTokens));
  if (usage.tokensSaved) ev.tokensSaved = Math.max(0, Math.floor(usage.tokensSaved));
  if (usage.model) ev.model = usage.model;
  const next: SubscriptionState = { ...state, events: pruneEvents([...state.events, ev], now), lastActivityAt: now };
  saveSubscriptionState(next, env);
  return next;
}

/**
 * Accept a provider-advertised window reset. Only a forward jump of more than
 * a minute counts as a rollover (which clears the window's events); jitter
 * within a minute just refreshes the anchor.
 */
export function recordWindowReset(kind: WindowKind, anchor: WindowAnchor, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): { rolledOver: boolean; state: SubscriptionState } {
  const state = loadSubscriptionState(env);
  const prev = state.anchors[kind];
  const rolledOver = prev !== undefined && anchor.resetsAt - prev.resetsAt > ROLLOVER_MIN_ADVANCE_MS;
  // Events are never discarded here: each window is derived from its anchor
  // (or rolls from `now`), so a 5-hour rollover cannot erase 7-day data.
  const next: SubscriptionState = { ...state, events: pruneEvents(state.events, now), anchors: { ...state.anchors, [kind]: anchor }, lastPollAt: now };
  saveSubscriptionState(next, env);
  return { rolledOver, state: next };
}

function windowBounds(kind: WindowKind, state: SubscriptionState, now: number): { start: number; end: number } {
  const length = kind === 'fiveHour' ? FIVE_HOUR_MS : SEVEN_DAY_MS;
  const anchor = state.anchors[kind];
  if (anchor && anchor.resetsAt > now && anchor.resetsAt - length <= now) return { start: anchor.resetsAt - length, end: anchor.resetsAt };
  return { start: now - length, end: now };
}

function summarize(kind: WindowKind, state: SubscriptionState, now: number): WindowStatus {
  const { start, end } = windowBounds(kind, state, now);
  const inWindow = state.events.filter((e) => e.ts >= start && e.ts <= now);
  const s = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, tokensSaved: 0 };
  for (const e of inWindow) {
    s.requests++;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.cacheReadTokens += e.cacheReadTokens ?? 0;
    s.tokensSaved += e.tokensSaved ?? 0;
  }
  const anchor = state.anchors[kind];
  const cacheMissSuspected = s.inputTokens > CACHE_MISS_MIN_INPUT_TOKENS && s.cacheReadTokens / s.inputTokens < CACHE_MISS_RATIO_THRESHOLD;
  // Surge: provider utilisation runs well ahead of the share of the window elapsed with usage.
  const elapsedPct = ((now - start) / (end - start)) * 100;
  const surgeSuspected = anchor?.utilizationPct !== undefined && anchor.utilizationPct - elapsedPct > SURGE_THRESHOLD_PCT && s.requests > 0;
  return { kind, start, end, ...s, utilizationPct: anchor?.utilizationPct, cacheMissSuspected, surgeSuspected };
}

export function windowStatus(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): SubscriptionStatus {
  const state = loadSubscriptionState(env);
  return {
    enabled: trackingEnabled(env),
    pollIntervalSeconds: pollIntervalSeconds(env),
    fiveHour: summarize('fiveHour', state, now),
    sevenDay: summarize('sevenDay', state, now),
    lastPollAt: state.lastPollAt,
  };
}

/** Poll only while a session was active in the last minute and the cadence has elapsed. */
export function shouldPoll(state: SubscriptionState, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!trackingEnabled(env)) return false;
  if (state.lastActivityAt === undefined || now - state.lastActivityAt > ACTIVE_WINDOW_MS) return false;
  return state.lastPollAt === undefined || now - state.lastPollAt >= pollIntervalSeconds(env) * 1000;
}

/** Dashboard-triggered refreshes are floored at one per minute. */
export function onDemandPollAllowed(state: SubscriptionState, now: number): boolean {
  return state.lastPollAt === undefined || now - state.lastPollAt >= ON_DEMAND_POLL_FLOOR_MS;
}

export function resetSubscriptionState(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.unlinkSync(subscriptionStatePath(env));
    return true;
  } catch {
    return false;
  }
}
