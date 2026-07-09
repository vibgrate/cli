import type { AdvancedScanHook } from '../core-open/index.js';
import { advancedScanHook } from './advanced-analysis.js';

/**
 * Resolve the advanced-analysis hook that populates the artifact's `extended`
 * block (tech stack, service integrations, build/deploy, security posture,
 * dependency graph/risk, TypeScript modernity, file hotspots, breaking-change
 * exposure, architecture, code quality, UI purpose).
 *
 * These are the structured, deterministic scanners — they emit typed facts
 * (names, versions, counts, booleans, paths) and never upload raw source text.
 * See {@link advancedScanHook} for the deliberate exclusion of the former
 * raw-line `requirements-scanners` family.
 */
export async function loadAdvancedScanHook(): Promise<AdvancedScanHook | undefined> {
  return advancedScanHook;
}
