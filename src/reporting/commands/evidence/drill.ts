// ── Drill: a timed dry-run of the determination step ──
//
// Honest scope: this exercises the deterministic determination against a
// SIMULATED advisory built from a component you actually ship, records which
// fields would come back undetermined and which readiness gaps would block a
// real filing, and stores a record so `readiness` can see a recent drill. It
// does not fabricate a human tabletop timer — pass `--elapsed` to record the
// wall-clock your team actually took.

import * as path from 'node:path';
import { writeJsonFile, pathExists } from '../../utils/fs.js';
import type { Advisory, ExposureResult, Regime, Release } from './types.js';
import { evidenceDir } from './state.js';

export interface DrillRecord {
  drillId: string;
  regime: string;
  scenario: string;
  simAdvisoryId: string;
  overallStatus: string;
  undeterminedFields: string[];
  ranAt: string;
  elapsedSeconds?: number;
}

/** Build a simulated advisory that affects a component drawn from a shipped release. */
export function synthesizeAdvisory(releases: Release[], scenarioSeed: string): Advisory | null {
  const withComponents = releases.filter((r) => r.components.length > 0);
  if (withComponents.length === 0) return null;
  // Deterministic pick from the seed so a given scenario is reproducible.
  let h = 0;
  for (let i = 0; i < scenarioSeed.length; i++) h = (h * 31 + scenarioSeed.charCodeAt(i)) >>> 0;
  const release = withComponents[h % withComponents.length];
  const component = release.components[h % release.components.length];
  return {
    id: `SIM-${scenarioSeed.toUpperCase()}-${(h % 9973).toString().padStart(4, '0')}`,
    ranges: [{ ecosystem: component.ecosystem, package: component.name, introduced: '0.0.0' }],
    sourceProvenance: `drill:${scenarioSeed} (simulated advisory — NOT a real vulnerability)`,
  };
}

/** Fields a real filing needs that this determination could not fill. */
export function undeterminedFields(result: ExposureResult, regime: Regime): string[] {
  const gaps: string[] = [];
  if (!result.coordinatorCsirt) gaps.push('coordinator_csirt');
  if (!result.responsiblePerson) gaps.push('responsible_person');
  if (result.products.some((p) => p.status === 'undetermined')) gaps.push('exposure (missing manifest)');
  if (result.products.some((p) => p.status === 'affected' && p.memberStates.length === 0)) gaps.push('member_states');
  return gaps.filter((g) => regime.submission.requires.some((r) => g.startsWith(r)) || g.startsWith('exposure') || g.startsWith('member'));
}

export async function recordDrill(root: string, record: DrillRecord): Promise<string> {
  const dir = path.join(evidenceDir(root), 'drills');
  const p = path.join(dir, `${record.drillId}.json`);
  await writeJsonFile(p, record);
  return p;
}

/** Whether any drill record exists within the last 90 days of `asOf`. */
export async function hasRecentDrill(root: string, asOf: string): Promise<boolean | undefined> {
  const dir = path.join(evidenceDir(root), 'drills');
  if (!(await pathExists(dir))) return undefined;
  const { readdir } = await import('node:fs/promises');
  const { readJsonFile } = await import('../../utils/fs.js');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return undefined;
  const cutoff = new Date(new Date(asOf).getTime() - 90 * 24 * 3600 * 1000).toISOString();
  for (const f of files) {
    const rec = await readJsonFile<DrillRecord>(path.join(dir, f));
    if (rec.ranAt >= cutoff) return true;
  }
  return false;
}
