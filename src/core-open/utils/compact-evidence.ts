// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Compact UI purpose evidence for efficient LLM inference
 *
 * Reduces token usage by ~80-90% through:
 * 1. Semantic categorization (pricing, auth, dashboard, etc.)
 * 2. Stem-based deduplication
 * 3. Route normalization
 * 4. Top-N sampling per category
 */

import type { UiPurposeEvidenceItem, UiPurposeResult, CompactUiPurpose } from '../types.js';

/** Semantic category patterns for grouping evidence */
const CATEGORY_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: 'pricing', pattern: /price|pricing|billing|subscri|trial|credit|plan|tier|upgrade|premium|pro|enterprise/i },
  { category: 'auth', pattern: /sign[- ]?in|sign[- ]?up|log[- ]?in|log[- ]?out|auth|sso|oauth|password|register|invite|onboard/i },
  { category: 'dashboard', pattern: /dashboard|overview|home|main|summary|stats/i },
  { category: 'settings', pattern: /setting|config|preference|option|profile|account/i },
  { category: 'users', pattern: /user|member|team|role|permission|access|admin|owner/i },
  { category: 'integrations', pattern: /integrat|connect|webhook|api[- ]?key|sync|import|export/i },
  { category: 'reports', pattern: /report|analy|metric|chart|graph|insight|track/i },
  { category: 'workflows', pattern: /workflow|automat|schedule|trigger|action|job|task|pipeline/i },
  { category: 'projects', pattern: /project|workspace|organization|folder|repo/i },
  { category: 'navigation', pattern: /menu|nav|sidebar|header|footer|breadcrumb/i },
];

/**
 * Compact raw UI evidence into a smaller payload for LLM inference
 */
export function compactUiPurpose(result: UiPurposeResult, maxSamplesPerCategory = 3): CompactUiPurpose {
  const evidence = result.topEvidence;

  // Extract special kinds
  const dependencies = evidence
    .filter((e) => e.kind === 'dependency')
    .map((e) => e.value)
    .slice(0, 10);

  const routes = dedupeRoutes(
    evidence.filter((e) => e.kind === 'route').map((e) => e.value),
  ).slice(0, 15);

  // Process text evidence
  const textEvidence = evidence.filter(
    (e) => e.kind !== 'dependency' && e.kind !== 'route' && e.kind !== 'feature_flag',
  );

  const byCategory = new Map<string, Set<string>>();
  const categoryCounts: Record<string, number> = {};

  for (const item of textEvidence) {
    const category = categorize(item.value);
    if (!byCategory.has(category)) {
      byCategory.set(category, new Set());
    }
    const normalized = normalizeValue(item.value);
    if (normalized.length >= 3) {
      byCategory.get(category)!.add(normalized);
    }
  }

  // Build samples
  const samples: Array<{ kind: string; value: string; category: string }> = [];

  for (const [category, values] of byCategory) {
    const deduped = dedupeStrings([...values]);
    categoryCounts[category] = deduped.length;

    for (const value of deduped.slice(0, maxSamplesPerCategory)) {
      samples.push({ kind: 'text', value, category });
    }
  }

  // Add feature flag indicator
  const featureFlags = evidence.filter((e) => e.kind === 'feature_flag');
  if (featureFlags.length > 0) {
    categoryCounts['feature_flags'] = featureFlags.length;
    samples.push({ kind: 'feature_flag', value: 'feature flags detected', category: 'feature_flags' });
  }

  return {
    samples,
    categoryCounts,
    originalCount: evidence.length,
    dependencies,
    routes,
    detectedFrameworks: result.detectedFrameworks,
  };
}

/** Categorize a value into semantic buckets */
function categorize(value: string): string {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(value)) return category;
  }
  return 'general';
}

/** Normalize a value for deduplication */
function normalizeValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Dedupe strings by prefix/stem similarity */
function dedupeStrings(values: string[]): string[] {
  const sorted = values.sort((a, b) => b.length - a.length);
  const kept: string[] = [];

  for (const value of sorted) {
    const isDupe = kept.some((k) => {
      const stem = value.slice(0, 6);
      return k.startsWith(stem) || k.includes(value) || value.includes(k);
    });
    if (!isDupe) {
      kept.push(value);
    }
  }

  return kept;
}

/** Dedupe routes by normalized path structure */
function dedupeRoutes(routes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const route of routes) {
    const normalized = route
      .replace(/:[a-z_]+/gi, ':param')
      .replace(/\[\[*\.*\.*[a-z_]+\]*\]/gi, ':param')
      .replace(/\/+$/, '')
      .toLowerCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(route);
    }
  }

  return result;
}
