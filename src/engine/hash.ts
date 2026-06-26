import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Content hashing — the bedrock of vg's determinism contract.
 *
 * Ids are blake3 over a canonical payload. blake3 is pure-WASM/JS (no native
 * build, no platform variance), so identical input → identical id on every
 * machine. We never let timestamps, RNG, locale, or filesystem order into a
 * hashed payload (VG-ENGINE-TEARDOWN.md §5).
 */

const encoder = new TextEncoder();

/** Full hex digest of a UTF-8 string. */
export function hashString(input: string): string {
  return bytesToHex(blake3(encoder.encode(input)));
}

/** Full hex digest of raw bytes (file contents). */
export function hashBytes(input: Uint8Array): string {
  return bytesToHex(blake3(input));
}

/**
 * A short, collision-resistant id for nodes/edges. 16 bytes (128 bits) of
 * blake3 is ample for repo-scale graphs and keeps `graph.json` compact and
 * human-diffable.
 */
export function shortId(input: string): string {
  return bytesToHex(blake3(encoder.encode(input), { dkLen: 16 }));
}

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace.
 * The single source of truth for "what bytes get hashed" so two runs that see
 * the same logical payload produce byte-identical input to blake3.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
