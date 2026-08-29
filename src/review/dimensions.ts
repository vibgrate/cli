/**
 * Voting dimensions — the questions a peer vote can actually answer.
 *
 * A dimension turns a file into one label, so peers can be compared. Review
 * votes only on dimensions that are *architectural*: how a file reaches its
 * data, and whether an entrypoint is guarded. Naming, import order, comment
 * style and TODO density are style questions a linter already owns, and putting
 * them in the receipt would drown the two findings that matter (the crib's
 * "do not do this" list, item 4 — hygiene linters stay out of Review).
 *
 * Every label here is derived from the code map, never from a filename.
 */

import type { ArchitectureLayer } from '../core-open/types.js';

export type Dimension = 'data_access';

/**
 * How a file reaches persistence.
 *
 * - `direct-persistence` — it imports/calls data-access or infrastructure itself
 * - `via-service`        — it goes through the services layer
 * - `via-domain`         — it only touches domain/entities
 * - `no-data-access`     — it reaches neither (a pure view, a util)
 */
export type DataAccessPattern =
  | 'direct-persistence'
  | 'via-service'
  | 'via-domain'
  | 'no-data-access';

/** Layers that are not tiers, and so never define a file's data-access shape. */
const EXEMPT = new Set<ArchitectureLayer>(['config', 'shared', 'testing']);

const PERSISTENCE = new Set<ArchitectureLayer>(['data-access', 'infrastructure']);

/**
 * Label one file from the layers it depends on.
 *
 * Precedence is deliberate and not a max/min: reaching persistence *directly*
 * is the fact that matters, and it is not cancelled out by also going through a
 * service. A handler that calls both the service and the repository has still
 * bypassed the boundary once.
 */
export function classifyDataAccess(
  fileLayer: ArchitectureLayer,
  dependsOnLayers: readonly ArchitectureLayer[],
): DataAccessPattern | null {
  // A file that *is* the persistence layer cannot bypass it.
  if (PERSISTENCE.has(fileLayer) || EXEMPT.has(fileLayer)) return null;

  const targets = dependsOnLayers.filter((l) => !EXEMPT.has(l) && l !== fileLayer);
  if (targets.some((l) => PERSISTENCE.has(l))) return 'direct-persistence';
  if (targets.includes('services')) return 'via-service';
  if (targets.includes('domain')) return 'via-domain';
  return 'no-data-access';
}

/**
 * Is deviating from `dominant` toward `actual` a step away from the declared
 * architecture, or merely different?
 *
 * Only `direct-persistence` is inherently a bypass. Moving from
 * `direct-persistence` to `via-service` is a file getting *better* than its
 * peers — Review must not flag the first file to modernise, which is precisely
 * the failure mode of treating a majority as correct.
 */
export function isRegression(actual: DataAccessPattern, dominant: DataAccessPattern | null): boolean {
  if (actual !== 'direct-persistence') return false;
  return dominant !== null && dominant !== 'direct-persistence';
}

/** Human-readable label for a pattern, used in claims and the context file. */
export function describePattern(pattern: string): string {
  switch (pattern) {
    case 'direct-persistence':
      return 'reaches persistence directly';
    case 'via-service':
      return 'goes through the service layer';
    case 'via-domain':
      return 'touches only domain types';
    case 'no-data-access':
      return 'does not reach data';
    default:
      return pattern;
  }
}
