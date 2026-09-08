/**
 * Session engine: per-conversation sticky state.
 *
 *  - session id: `x-vg-session` header → `metadata.user_id` → hash of the
 *    system prompt + first user message (so two conversations on the same
 *    model never share a session).
 *  - beta-header stickiness: the union of `anthropic-beta` tokens seen in the
 *    session, first-seen order and casing, case-insensitive dedup.
 *  - tool-injection stickiness: once the retrieve (or memory) tool was
 *    injected, its *golden bytes* are replayed every turn — `tools` heads the
 *    provider's cache key, so toggling it busts the prefix.
 *  - compression cache: message-hash → forwarded form, so a previously
 *    forwarded message is replayed byte-identically in cache mode.
 *  - cache_control ttl guard: never downgrade a 1h lane the client paid for;
 *    strip stray `ttl` when the client sent no 1h marker this turn.
 *  - bounded: LRU by last access with an idle TTL.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../engine/hash.js';
import type { Message, MessageFormat } from '../compress/types.js';

export interface Session {
  id: string;
  createdAt: number;
  lastSeen: number;
  turn: number;
  betaTokens: string[];
  /** Golden bytes per injected tool name (canonical JSON), replayed verbatim. */
  injectedTools: Map<string, string>;
  /** Message content hash → forwarded (compressed) message JSON. */
  forwarded: Map<string, string>;
  forwardedOrder: string[];
  sawOneHour: boolean;
  /** Hashes of markers already forwarded (to detect genuinely new ones). */
  markerHashes: Set<string>;
  frozenCount: number;
  cacheReadTokens: number;
  client?: string;
  model?: string;
}

export interface SessionEngineOptions {
  maxSessions?: number;
  ttlSeconds?: number;
  maxForwardedEntries?: number;
  now?: () => number;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Resolve a session id from headers + body (deterministic for the same conversation). */
export function resolveSessionId(headers: Record<string, string>, body: Record<string, unknown>, format: MessageFormat): string {
  const explicit = headers['x-vg-session']?.trim();
  if (explicit) return `hdr:${explicit.slice(0, 128)}`;
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.user_id === 'string' && meta.user_id.trim()) return `meta:${sha256Hex(meta.user_id).slice(0, 24)}`;
  const model = String(body.model ?? '');
  let seed = `${format}\0${model}\0`;
  if (typeof body.system === 'string') seed += body.system.slice(0, 2048);
  else if (Array.isArray(body.system)) seed += (body.system as Array<Record<string, unknown>>).map((b) => (typeof b.text === 'string' ? b.text.slice(0, 2048) : '')).join('\n');
  else if (typeof body.instructions === 'string') seed += body.instructions.slice(0, 2048);
  const first = firstUserText(body, format);
  seed += `\0${first.slice(0, 512)}`;
  return `auto:${sha256Hex(seed).slice(0, 24)}`;
}

export function firstUserText(body: Record<string, unknown>, format: MessageFormat): string {
  if (format === 'responses') {
    const input = body.input;
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) {
      for (const it of input as Array<Record<string, unknown>>) {
        if (it && it.role === 'user') return partText(it.content);
      }
    }
    return '';
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const m of messages as Message[]) {
      if (m.role === 'system' || m.role === 'developer') {
        if (format === 'openai') continue;
      }
      if (m.role === 'user') return partText(m.content);
    }
  }
  return '';
}

function partText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const p of content as Array<Record<string, unknown>>) {
      if (p && typeof p.text === 'string') return p.text;
      if (p && p.type === 'tool_result') {
        if (typeof p.content === 'string') return p.content;
      }
    }
  }
  return '';
}

/** Content hash used by the compression cache (canonical JSON). */
export function messageHash(message: Message): string {
  return sha256Hex(canonicalize(message)).slice(0, 24);
}

export class SessionEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly maxForwarded: number;
  private readonly now: () => number;

  constructor(opts: SessionEngineOptions = {}) {
    this.maxSessions = Math.max(1, opts.maxSessions ?? 1000);
    this.ttlMs = Math.max(600, opts.ttlSeconds ?? 3600) * 1000;
    this.maxForwarded = Math.max(100, opts.maxForwardedEntries ?? 10_000);
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Get-or-create with LRU bump; evicts idle sessions lazily. */
  resolve(id: string): Session {
    const t = this.now();
    let s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      s.lastSeen = t;
      s.turn++;
    } else {
      this.sweep(t);
      s = { id, createdAt: t, lastSeen: t, turn: 1, betaTokens: [], injectedTools: new Map(), forwarded: new Map(), forwardedOrder: [], sawOneHour: false, markerHashes: new Set(), frozenCount: 0, cacheReadTokens: 0 };
    }
    this.sessions.set(id, s);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return s;
  }

  /** Read-only lookup (no create, no LRU bump). */
  peek(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  sweep(now = this.now()): number {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (now - s.lastSeen > this.ttlMs) {
        this.sessions.delete(k);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.sessions.clear();
  }

  stats(): { sessions: number; maxSessions: number; ttlSeconds: number } {
    return { sessions: this.sessions.size, maxSessions: this.maxSessions, ttlSeconds: this.ttlMs / 1000 };
  }

  // --- beta headers ---------------------------------------------------------

  /** Union of the client's tokens with previously seen ones; returns the header value. */
  stickyBeta(session: Session, headerValue: string | undefined, enabled: boolean): string | undefined {
    if (!enabled) return headerValue;
    const incoming = (headerValue ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set(session.betaTokens.map((t) => t.toLowerCase()));
    for (const t of incoming) {
      if (!seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        session.betaTokens.push(t);
      }
    }
    return session.betaTokens.length ? session.betaTokens.join(',') : headerValue;
  }

  // --- sticky tool injection ---------------------------------------------------

  /**
   * Decide whether to append `tool` this turn. Decisions mirror the reference
   * table: already present → skip; previously injected → replay golden bytes;
   * fresh + `injectThisTurn` → inject and pin.
   */
  stickyTool(session: Session | null, tools: unknown, tool: Record<string, unknown>, name: string, injectThisTurn: boolean, sticky: boolean): { tools: unknown[]; decision: string; injected: boolean } {
    const list = Array.isArray(tools) ? [...(tools as unknown[])] : [];
    if (list.some((t) => toolName(t) === name)) return { tools: list, decision: 'skip_present', injected: false };
    if (!sticky || !session) {
      if (injectThisTurn) return { tools: [...list, tool], decision: 'inject_first_time', injected: true };
      return { tools: list, decision: 'skip', injected: false };
    }
    const golden = session.injectedTools.get(name);
    if (golden !== undefined) {
      try {
        return { tools: [...list, JSON.parse(golden) as unknown], decision: 'inject_sticky_replay', injected: true };
      } catch {
        session.injectedTools.set(name, canonicalize(tool));
        return { tools: [...list, tool], decision: 'inject_regenerated', injected: true };
      }
    }
    if (injectThisTurn) {
      session.injectedTools.set(name, canonicalize(tool));
      return { tools: [...list, tool], decision: 'inject_first_time', injected: true };
    }
    return { tools: list, decision: 'skip', injected: false };
  }

  // --- compression cache -------------------------------------------------------

  /** Remember the forwarded form of each original message (bounded FIFO). */
  rememberForwarded(session: Session, originals: Message[], forwarded: Message[]): void {
    const n = Math.min(originals.length, forwarded.length);
    for (let i = 0; i < n; i++) {
      const h = messageHash(originals[i]);
      if (session.forwarded.has(h)) continue;
      session.forwarded.set(h, JSON.stringify(forwarded[i]));
      session.forwardedOrder.push(h);
    }
    while (session.forwardedOrder.length > this.maxForwarded) {
      const old = session.forwardedOrder.shift();
      if (old) session.forwarded.delete(old);
    }
  }

  /**
   * Replay previously forwarded forms over the leading prefix of `messages`
   * (stops at the first unknown message). Returns the messages plus the
   * number replayed — the frozen prefix a cache-mode turn must not touch.
   */
  replayForwarded(session: Session, messages: Message[]): { messages: Message[]; frozen: number } {
    const out = [...messages];
    let frozen = 0;
    for (let i = 0; i < messages.length; i++) {
      const h = messageHash(messages[i]);
      const prior = session.forwarded.get(h);
      if (prior === undefined) break;
      try {
        out[i] = JSON.parse(prior) as Message;
      } catch {
        break;
      }
      frozen = i + 1;
    }
    return { messages: out, frozen };
  }

  // --- markers ------------------------------------------------------------------

  /** Hashes not seen in a previous turn of this session. */
  newMarkers(session: Session, hashes: string[]): string[] {
    const fresh = hashes.filter((h) => !session.markerHashes.has(h));
    for (const h of hashes) session.markerHashes.add(h);
    return fresh;
  }
}

export function toolName(t: unknown): string | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Record<string, unknown>;
  if (typeof o.name === 'string') return o.name;
  const fn = o.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === 'string') return fn.name;
  if (typeof o.type === 'string') return o.type;
  return undefined;
}

// ---------------------------------------------------------------------------
// cache_control ttl guard
// ---------------------------------------------------------------------------

interface Marker {
  holder: Record<string, unknown>;
}

function collectMarkers(body: Record<string, unknown>): Marker[] {
  const out: Marker[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.cache_control && typeof o.cache_control === 'object') out.push({ holder: o });
    if (Array.isArray(o.content)) visit(o.content);
  };
  // Anthropic renders tools → system → messages; walk in that order.
  visit(body.tools);
  if (Array.isArray(body.system)) visit(body.system);
  visit(body.messages);
  return out;
}

/**
 * Lane containment + ordering. `clientUsesOneHour` is whether the *client's*
 * request carried any `ttl: 1h` marker this turn.
 *   - client sent no 1h marker → strip `ttl` from every outbound 1h marker
 *     (any such marker is a replay from an earlier turn);
 *   - otherwise promote every 5m marker that precedes the last 1h marker
 *     (demotion is never performed).
 * Returns the number of markers repaired.
 */
export function enforceCacheControlTtlOrder(body: Record<string, unknown>, clientUsesOneHour: boolean): number {
  const markers = collectMarkers(body);
  let repaired = 0;
  const ttlOf = (m: Marker): string | undefined => (m.holder.cache_control as Record<string, unknown>).ttl as string | undefined;
  if (!clientUsesOneHour) {
    for (const m of markers) {
      const cc = m.holder.cache_control as Record<string, unknown>;
      if (cc.ttl !== undefined) {
        delete cc.ttl;
        repaired++;
      }
    }
    return repaired;
  }
  let lastOneHour = -1;
  markers.forEach((m, i) => {
    if (ttlOf(m) === '1h') lastOneHour = i;
  });
  for (let i = 0; i < lastOneHour; i++) {
    const cc = markers[i].holder.cache_control as Record<string, unknown>;
    if (cc.ttl !== '1h') {
      cc.ttl = '1h';
      repaired++;
    }
  }
  return repaired;
}

export function clientUsesOneHour(body: Record<string, unknown>): boolean {
  return collectMarkers(body).some((m) => (m.holder.cache_control as Record<string, unknown>).ttl === '1h');
}

export function countCacheBreakpoints(body: Record<string, unknown>): number {
  return collectMarkers(body).length;
}
