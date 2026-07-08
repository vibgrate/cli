import type { GraphEdge, NodeKind, ResolverKind } from '../schema.js';

/**
 * Edge-level epistemic confidence.
 *
 * Tree-sitter gives syntax, not semantics: a call graph built purely from it is
 * name-matching — heuristic, i.e. conjecture wearing a deterministic costume.
 * Rather than hide that behind a single 0..1 `confidence`, every edge also
 * carries a coarse, honest *tier* describing HOW it was resolved, so a consumer
 * can filter for the assurance it needs (`WHERE epistemic = 'observed'`).
 *
 *   observed     — resolved by a semantic resolver (SCIP / stack-graphs / the
 *                  TypeScript type checker) to a concrete declaration, or a
 *                  structural fact read directly off the parse tree
 *                  (containment, an import that resolves to a corpus file).
 *   name-matched — matched by symbol name only, with no reachability proof.
 *                  This is the heuristic call/heritage/reference graph: useful,
 *                  but conjecture, not observation.
 *   declared     — asserted by a manifest, config, or an external boundary the
 *                  graph does not model internally (external package imports,
 *                  test/coverage linkage). True as a declaration; not verified
 *                  against code.
 *
 * `epistemic` is the coarse honesty axis; the numeric `confidence` remains the
 * fine gradient within a tier. The tier is a pure, deterministic function of the
 * edge's own fields plus the kind of its destination node.
 */
export type EpistemicTier = 'observed' | 'name-matched' | 'declared';

export const EPISTEMIC_TIERS: readonly EpistemicTier[] = ['observed', 'name-matched', 'declared'];

/** Semantic resolvers observe the real target; the heuristic rung only guesses it. */
const SEMANTIC_RESOLVERS = new Set<ResolverKind>(['scip', 'stackgraph', 'tsc']);

/**
 * Classify one edge into its epistemic tier. `dstKind` is the destination node's
 * kind (used to tell an internal import from an external-package import); omit it
 * only when the destination is unknown, in which case imports fall back to
 * `declared` (the safer, less-assured label).
 */
export function classifyEpistemic(edge: GraphEdge, dstKind?: NodeKind): EpistemicTier {
  // A semantic resolver saw the concrete declaration — the strongest tier.
  if (SEMANTIC_RESOLVERS.has(edge.resolution)) return 'observed';

  switch (edge.kind) {
    case 'contains':
      // Direct syntactic containment from the parse tree — observed, not guessed.
      return 'observed';
    case 'import':
      // Resolved to a real file in the corpus is observed; a bare external
      // package reference is only declared (we never see inside it).
      return dstKind === 'external' || dstKind === undefined ? 'declared' : 'observed';
    case 'test':
    case 'coverage':
      // Asserted by test structure / a coverage report, not verified against
      // the runtime call graph.
      return 'declared';
    default:
      // call / extends / implements / references resolved by the heuristic rung:
      // a symbol-name match with no reachability justification.
      return 'name-matched';
  }
}

/** Count edges by epistemic tier (deterministic key order). */
export function epistemicBreakdown(edges: GraphEdge[]): Record<EpistemicTier, number> {
  const out: Record<EpistemicTier, number> = { observed: 0, 'name-matched': 0, declared: 0 };
  for (const e of edges) {
    if (e.epistemic) out[e.epistemic]++;
  }
  return out;
}
