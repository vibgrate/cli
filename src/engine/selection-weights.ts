/**
 * Weights for the deterministic README/doc section selector (engine/select.ts).
 *
 * These are STATIC NUMBERS applied by plain arithmetic at runtime — no ML, no LLM,
 * no network, no key. They are tuned OFFLINE (scripts/tune-selection.mjs) against a
 * corpus of real READMEs with an oracle, then re-cut into this file per release and
 * version-stamped, so a given CLI version selects byte-deterministically. The corpus
 * and tuner stay server-side (the moat); only the resulting weights ship.
 */
export interface SelectionWeights {
  headingUsage: number; // heading looks like usage/example/getting-started/api
  headingPreamble: number; // heading looks like install/license/contributing/badges (negative)
  hasCode: number; // section contains a fenced code block
  codeDensity: number; // per additional code block
  queryOverlap: number; // per distinct query term present
  symbolMatch: number; // per exported symbol name present (from the .d.ts surface)
  position: number; // per section index (negative → earlier slightly preferred)
  linkDensity: number; // link/badge-heavy section (negative)
}

/** Stamp the weights so output is reproducible per CLI version and tunes are auditable. */
export const SELECTION_WEIGHTS_VERSION = '2026.06.26-hand-v1';

/** Hand-set v1 baseline. Superseded by tuned weights once the harness runs on the corpus. */
export const DEFAULT_SELECTION_WEIGHTS: SelectionWeights = {
  headingUsage: 4,
  headingPreamble: -6,
  hasCode: 3,
  codeDensity: 0.5,
  queryOverlap: 5,
  symbolMatch: 2,
  position: -0.1,
  linkDensity: -3,
};
