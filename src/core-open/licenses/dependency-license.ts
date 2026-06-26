// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Helper for ecosystem scanners: turn a declared license string into the
 * compact DependencyLicense carrier stored on each DependencyRow.
 *
 * The scanner records the raw declared string plus a best-effort canonical
 * SPDX id; full classification (category / obligations / risk) and the growing
 * library lookup happen during API enrichment.
 */
import type { DependencyLicense } from '../types.js';
import { normalizeLicense } from './normalize.js';

export function buildDependencyLicense(
  raw: string | null | undefined,
  source: DependencyLicense['source'],
): DependencyLicense {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { raw: null, spdxId: null, source: 'none', confidence: 0 };
  }
  const verdict = normalizeLicense(trimmed);
  return {
    raw: trimmed.slice(0, 200),
    spdxId: verdict.matchStatus === 'unknown' ? null : verdict.spdxId,
    source,
    confidence: verdict.confidence,
  };
}
