/**
 * Project federation bridge edges into capsule pinned facts (Fusion Phase 6).
 *
 * High-confidence bridges become short, secret-free facts the model can see
 * without opening every workspace root. Pure over {@link BridgeEdge}.
 */

import type { BridgeEdge } from './bridge-edges.js';

/**
 * Turn bridge edges into pinned-fact lines for Task Capsules.
 * Default minConfidence 0.8 keeps only workspace/package-strong links
 * (interface bridges sit ~0.68–0.75 and stay out unless lowered).
 */
export function bridgePinnedFacts(
  bridges: BridgeEdge[] | undefined | null,
  options: { minConfidence?: number; maxFacts?: number } = {},
): string[] {
  if (!bridges?.length) return [];
  const min = options.minConfidence ?? 0.8;
  const max = options.maxFacts ?? 12;
  return bridges
    .filter((b) => b.confidence >= min)
    .map((b) => {
      const from = shortLabel(b.fromRoot);
      const to = shortLabel(b.toRoot);
      const via = b.packageName ? ` package ${b.packageName}` : '';
      return `bridge ${b.kind}: ${from} → ${to}${via} (${b.confidence.toFixed(2)})`;
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

function shortLabel(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || root;
}
