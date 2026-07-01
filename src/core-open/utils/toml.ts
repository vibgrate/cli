// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Thin, safe wrapper over the `smol-toml` parser (BSD-3-Clause, pure ESM, zero dependencies).
 *
 * Centralizes the single TOML dependency so lockfile/manifest parsers don't each import it, and never
 * throws: a malformed file yields `null` so callers can fall back gracefully instead of crashing a
 * scan. Returns the parsed document as a plain object.
 */
import { parse } from 'smol-toml';

export function parseToml(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const doc = parse(text);
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
