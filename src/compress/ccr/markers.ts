/**
 * Retrieval marker formats (the exact strings the model sees).
 *
 * Two families, both carrying a hash that resolves in `ccr/store.ts`:
 *
 *  - Opaque offload markers (12-char short hash):
 *      `<<vg-ccr:HASH N_rows_offloaded>>`        rows dropped from a JSON array
 *      `<<vg-ccr:HASH,KIND,SIZE>>`               KIND ∈ lines|bytes|chars|items
 *    plus the in-array sentinel `{"_vg_dropped": N, "hash": "HASH"}`.
 *  - Retrieval hints (24-char hash), one line, last in a compressed block:
 *      `Retrieve original: hash=HASH24 (ORIG → COMP tokens[, tool=NAME])`
 *      `Retrieve more: hash=HASH24 (…)` for partial keeps.
 *
 * Every scanner here is a single left-to-right pass with bounded regexes
 * (no nested quantifiers), so scanning is linear in the input size.
 */

export type MarkerKind = 'rows' | 'items' | 'lines' | 'bytes' | 'chars';

export const MARKER_PREFIX = '<<vg-ccr:';
export const MARKER_SUFFIX = '>>';
export const RETRIEVE_ORIGINAL_PREFIX = 'Retrieve original: hash=';
export const RETRIEVE_MORE_PREFIX = 'Retrieve more: hash=';
/** Key of the sentinel row left inside a JSON array when rows were offloaded. */
export const DROPPED_SENTINEL_KEY = '_vg_dropped';

export interface FoundMarker {
  hash: string;
  /** `rows|items|lines|bytes|chars` for opaque markers, `hint` for retrieval hints, `sentinel` for the JSON row sentinel. */
  kind: string;
  count: number;
  start: number;
  end: number;
  raw: string;
}

const HEX = /^[0-9a-f]+$/;

/** True for a lowercase-able hex hash of exactly 12 or 24 chars. */
export function isValidHash(hash: unknown): hash is string {
  if (typeof hash !== 'string') return false;
  const h = hash.toLowerCase();
  return (h.length === 12 || h.length === 24) && HEX.test(h);
}

/** Canonical (lowercase) form of a hash the model echoed back, or null. */
export function normalizeHash(hash: unknown): string | null {
  return isValidHash(hash) ? hash.toLowerCase() : null;
}

/** Build an opaque offload marker. `hash` may be 12 or 24 chars; the marker carries the 12-char form. */
export function makeMarker(kind: MarkerKind, hash: string, count: number, extra: { tool?: string } = {}): string {
  const short = hash.toLowerCase().slice(0, 12);
  const n = Math.max(0, Math.floor(count));
  if (kind === 'rows') return `${MARKER_PREFIX}${short} ${n}_rows_offloaded${MARKER_SUFFIX}`;
  const tool = extra.tool ? `,tool=${sanitizeTool(extra.tool)}` : '';
  return `${MARKER_PREFIX}${short},${kind},${n}${tool}${MARKER_SUFFIX}`;
}

/** The JSON row sentinel (`{"_vg_dropped": N, "hash": "HASH"}`) as a compact string. */
export function makeDroppedSentinel(hash: string, count: number): string {
  return JSON.stringify({ [DROPPED_SENTINEL_KEY]: Math.max(0, Math.floor(count)), hash: hash.toLowerCase().slice(0, 12) });
}

function sanitizeTool(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
}

/** Trailing retrieval-hint line for a compressed block. */
export function retrieveHint(hash: string, opts: { originalTokens: number; compressedTokens: number; toolName?: string; partial?: boolean }): string {
  const prefix = opts.partial ? RETRIEVE_MORE_PREFIX : RETRIEVE_ORIGINAL_PREFIX;
  const tool = opts.toolName ? `, tool=${sanitizeTool(opts.toolName)}` : '';
  return `${prefix}${hash.toLowerCase()} (${Math.max(0, Math.floor(opts.originalTokens))} → ${Math.max(0, Math.floor(opts.compressedTokens))} tokens${tool})`;
}

// `<<vg-ccr:HASH` then either ` N_rows_offloaded` or `,KIND,SIZE[,tool=NAME]`, then `>>`.
const OPAQUE_RE = /<<vg-ccr:([0-9a-fA-F]{12,24})(?: (\d+)_rows_offloaded|,([a-z]+),(\d+)(?:,tool=[A-Za-z0-9_.:-]{1,64})?)?>>/g;
const HINT_RE = /Retrieve (?:original|more): hash=([0-9a-fA-F]{12,24})\b/g;
const SENTINEL_RE = /\{"_vg_dropped":\s*(\d+),\s*"hash":\s*"([0-9a-fA-F]{12,24})"\}/g;

/** Every marker in `text`, in document order (ties by family), with byte offsets. */
export function findMarkers(text: string): FoundMarker[] {
  const out: FoundMarker[] = [];
  if (!text || (!text.includes(MARKER_PREFIX) && !text.includes('hash=') && !text.includes(DROPPED_SENTINEL_KEY))) return out;
  let m: RegExpExecArray | null;
  OPAQUE_RE.lastIndex = 0;
  while ((m = OPAQUE_RE.exec(text)) !== null) {
    const hash = m[1].toLowerCase();
    if (m[2] !== undefined) out.push({ hash, kind: 'rows', count: Number.parseInt(m[2], 10), start: m.index, end: m.index + m[0].length, raw: m[0] });
    else if (m[3] !== undefined) out.push({ hash, kind: m[3], count: Number.parseInt(m[4], 10), start: m.index, end: m.index + m[0].length, raw: m[0] });
    else out.push({ hash, kind: 'bare', count: 0, start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  HINT_RE.lastIndex = 0;
  while ((m = HINT_RE.exec(text)) !== null) {
    out.push({ hash: m[1].toLowerCase(), kind: 'hint', count: 0, start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  SENTINEL_RE.lastIndex = 0;
  while ((m = SENTINEL_RE.exec(text)) !== null) {
    out.push({ hash: m[2].toLowerCase(), kind: 'sentinel', count: Number.parseInt(m[1], 10), start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  out.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  return out;
}

/** Distinct hashes referenced by `text`, insertion order. */
export function extractHashes(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of findMarkers(text)) {
    if (seen.has(m.hash)) continue;
    seen.add(m.hash);
    out.push(m.hash);
  }
  return out;
}

/** True when any retrieval marker is present. */
export function hasMarkers(text: string): boolean {
  return findMarkers(text).length > 0;
}

/**
 * Remove every marker from `text`. Whole-line hints (the trailing
 * `Retrieve original: …` line) are removed with their line break; inline
 * markers are removed in place.
 */
export function stripMarkers(text: string): string {
  const markers = findMarkers(text);
  if (markers.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const m of markers) {
    if (m.start < pos) continue;
    let start = m.start;
    let end = m.end;
    if (m.kind === 'hint') {
      // Extend to the parenthesised suffix and, when the hint owns its line, the line.
      const close = text.indexOf(')', end);
      const nl = text.indexOf('\n', end);
      if (close !== -1 && (nl === -1 || close < nl)) end = close + 1;
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = nl === -1 ? text.length : nl;
      if (text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '') {
        start = lineStart > 0 ? lineStart - 1 : lineStart;
        end = lineEnd;
      }
    }
    out += text.slice(pos, start);
    pos = end;
  }
  out += text.slice(pos);
  return out;
}
