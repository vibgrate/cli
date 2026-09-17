import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchOverview, ArchSlice } from './arch-types.js';
import { resetOverlayContextCache } from './overlay-context.js';
import { matchCodeownersPattern, parseCodeowners, heatOf, ownerTone } from './overlay-context.js';
import { withArchOverviewOverlays, withArchSliceOverlays } from './overlays.js';
import { sanitizeOverview, sanitizeSlice } from './sanitize.js';

let dir: string | undefined;

afterEach(() => {
  resetOverlayContextCache();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tmp(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ov-'));
  return dir;
}

function writeScan(root: string, body: unknown): void {
  fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vibgrate', 'scan_result.json'), JSON.stringify(body));
}

function baseOverview(): ArchOverview {
  return {
    magic: 'vg.arch.overview.v1',
    packages: [
      {
        id: 'pkg-api',
        name: 'api',
        path: 'packages/api',
        kind: 'package',
        symbols: 4,
        findings: 0,
        missingSteps: 0,
        job: 'service',
        policy: null,
        lane: 'app',
      },
      {
        id: 'pkg-web',
        name: 'web',
        path: 'packages/web',
        kind: 'package',
        symbols: 2,
        findings: 0,
        missingSteps: 0,
        job: 'web',
        policy: null,
        lane: 'ui',
      },
    ],
    edges: [],
    meta: {
      architectureLoaded: false,
      policy: null,
      policyLabel: null,
      symbols: 6,
      packages: 2,
      findings: 0,
      missingSteps: 0,
      title: 'Code map',
    },
  };
}

function baseSlice(): ArchSlice {
  return {
    magic: 'vg.arch.slice.v1',
    packageId: 'pkg-api',
    packageName: 'api',
    policy: 'hexagonal-v1',
    columns: [
      {
        id: 'app',
        title: 'Application',
        cards: [
          {
            id: 'card:billing',
            title: 'BillingService',
            subtitle: 'Service',
            lane: 'app',
            file: 'packages/api/src/Billing.ts',
            line: 10,
            symbolId: 'BillingService',
            count: 1,
            job: 'Service',
            color: '#22c55e',
            classified: true,
            pulse: false,
            missingStep: false,
          },
        ],
      },
    ],
    guards: [],
    edges: [],
    overflow: {},
    focusCardId: null,
  };
}

describe('CODEOWNERS parser', () => {
  it('is last-match-wins and ownership-only', () => {
    const rules = parseCodeowners(`
# comment
* @org/default
/packages/api/ @team-api
*.md @docs
`);
    expect(rules).toHaveLength(3);
    expect(matchCodeownersPattern('/packages/api/', 'packages/api/src/Billing.ts')).toBe(true);
    expect(matchCodeownersPattern('*.md', 'docs/guide.md')).toBe(true);
    expect(matchCodeownersPattern('*.md', 'packages/api/src/Billing.ts')).toBe(false);
  });

  it('hashes a team to a stable tone, not a score', () => {
    expect(ownerTone('@team-api')).toBe(ownerTone('@team-api'));
    expect(ownerTone('@team-api')).toBeGreaterThanOrEqual(0);
    expect(ownerTone('@team-api')).toBeLessThan(8);
  });
});

describe('churn heat', () => {
  it('omits zero and ranks only among positive counts', () => {
    expect(heatOf(0, [1, 2, 3])).toBeNull();
    expect(heatOf(3, [1, 2, 3, 4, 5])).toBeGreaterThanOrEqual(1);
    expect(heatOf(5, [1, 2, 3, 4, 5])).toBe(5);
  });
});

describe('architecture overlays', () => {
  it('is honest-empty when the repo has no scan, owners, or git', () => {
    const root = tmp();
    const overview = withArchOverviewOverlays(baseOverview(), root);
    expect(overview.overlays?.vulns.source).toBe(false);
    expect(overview.overlays?.drift.source).toBe(false);
    expect(overview.overlays?.ownership.source).toBe(false);
    expect(overview.overlays?.churn.source).toBe(false);
    expect(overview.overlays?.vulns.painted).toBe(0);
    expect(overview.packages.every((p) => !p.vulnerabilities && !p.drift && !p.owners && !p.churn)).toBe(true);
    expect(overview.overlays?.vulns.empty).toMatch(/reachability/i);
    expect(JSON.stringify(overview)).not.toMatch(/Architecture Health Score/i);
    expect(JSON.stringify(overview)).not.toMatch(/HAILE/i);
  });

  it('paints vulns on the matching card and package, never not_reached', () => {
    const root = tmp();
    writeScan(root, {
      reachability: {
        findings: [
          {
            advisoryId: 'GHSA-xxxx',
            package: 'left-pad',
            tier: 'reachable',
            sites: [{ file: 'packages/api/src/Billing.ts' }],
            evidence: 'imported in packages/api/src/Billing.ts',
          },
          {
            advisoryId: 'GHSA-skip',
            package: 'left-pad',
            tier: 'not_reached',
            sites: [{ file: 'packages/web/src/Home.tsx' }],
          },
        ],
      },
    });
    const slice = withArchSliceOverlays(baseSlice(), root);
    expect(slice.columns[0]?.cards[0]?.vulnerabilities?.[0]?.advisoryId).toBe('GHSA-xxxx');
    expect(slice.overlays?.vulns.source).toBe(true);
    expect(slice.overlays?.vulns.painted).toBe(1);
    const overview = withArchOverviewOverlays(baseOverview(), root);
    expect(overview.packages.find((p) => p.id === 'pkg-api')?.vulnerabilities?.[0]?.package).toBe('left-pad');
    expect(overview.packages.find((p) => p.id === 'pkg-web')?.vulnerabilities).toBeUndefined();
  });

  it('joins scan drift by path and omits current/unknown', () => {
    const root = tmp();
    writeScan(root, {
      projects: [
        {
          path: 'packages/api',
          name: 'api',
          dependencies: [
            { package: 'left-pad', drift: 'major-behind' },
            { package: 'fresh', drift: 'current' },
            { package: 'mystery', drift: 'unknown' },
          ],
        },
      ],
    });
    const overview = withArchOverviewOverlays(baseOverview(), root);
    const api = overview.packages.find((p) => p.id === 'pkg-api');
    const web = overview.packages.find((p) => p.id === 'pkg-web');
    expect(api?.drift).toEqual({ band: 'major', packages: ['left-pad'] });
    expect(web?.drift).toBeUndefined();
    expect(overview.overlays?.drift.source).toBe(true);
    expect(overview.overlays?.drift.painted).toBe(1);
    const slice = withArchSliceOverlays(baseSlice(), root);
    expect(slice.columns[0]?.cards[0]?.drift?.band).toBe('major');
    expect(slice.columns[0]?.cards[0]?.drift?.packages).toEqual(['left-pad']);
  });

  it('joins CODEOWNERS to cards without inventing layers', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.github'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'CODEOWNERS'), '* @org/default\n/packages/api/ @team-api\n');
    const overview = withArchOverviewOverlays(baseOverview(), root);
    expect(overview.packages.find((p) => p.id === 'pkg-api')?.owners?.teams).toEqual(['@team-api']);
    expect(overview.packages.find((p) => p.id === 'pkg-web')?.owners?.teams).toEqual(['@org/default']);
    const slice = withArchSliceOverlays(baseSlice(), root);
    expect(slice.columns[0]?.cards[0]?.owners?.teams).toEqual(['@team-api']);
    expect(slice.overlays?.ownership.source).toBe(true);
    expect(JSON.stringify(slice)).not.toMatch(/layer/i);
  });

  it('rolls up bounded git churn and omits paths with no history', () => {
    const root = tmp();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root, stdio: 'ignore' });
    fs.mkdirSync(path.join(root, 'packages/api/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/api/src/Billing.ts'), 'export const n = 1;\n');
    execFileSync('git', ['add', 'packages/api/src/Billing.ts'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'billing'], { cwd: root, stdio: 'ignore' });
    resetOverlayContextCache();
    const slice = withArchSliceOverlays(baseSlice(), root);
    expect(slice.columns[0]?.cards[0]?.churn?.commits).toBeGreaterThan(0);
    expect(slice.columns[0]?.cards[0]?.churn?.heat).toBeGreaterThanOrEqual(1);
    expect(slice.overlays?.churn.source).toBe(true);
    expect(slice.overlays?.churn.painted).toBe(1);
  });

  it('sanitises overlay marks additively and drops a current-looking zero', () => {
    const clean = sanitizeOverview({
      magic: 'vg.arch.overview.v1',
      packages: [
        {
          id: 'p',
          name: 'api',
          path: 'packages/api',
          kind: 'package',
          symbols: 1,
          findings: 0,
          missingSteps: 0,
          job: 'service',
          policy: null,
          lane: 'app',
          drift: { band: 'major', packages: ['left-pad'] },
          owners: { teams: ['@team-api'], tone: 3 },
          churn: { heat: 4, commits: 9 },
        },
      ],
      edges: [],
      meta: {
        architectureLoaded: false,
        policy: null,
        policyLabel: null,
        symbols: 1,
        packages: 1,
        findings: 0,
        missingSteps: 0,
        title: 'Code map',
      },
      overlays: {
        vulns: { kind: 'vulns', source: false, painted: 0, empty: 'No reachability from a connected scan. Run vg scan online with a workspace connection.' },
        drift: { kind: 'drift', source: true, painted: 1, empty: 'No drifted dependencies on this map.' },
        ownership: { kind: 'ownership', source: true, painted: 1, empty: 'CODEOWNERS does not match any card on this map.' },
        churn: { kind: 'churn', source: true, painted: 1, empty: 'No commit history for files on this map.' },
      },
    });
    expect(clean?.packages[0]?.drift?.band).toBe('major');
    expect(clean?.overlays?.drift.painted).toBe(1);
    expect(sanitizeSlice({ ...baseSlice(), columns: [{ id: 'app', title: 'Application', cards: [{ ...baseSlice().columns[0]!.cards[0], churn: { heat: 0, commits: 0 } }] }] })?.columns[0]?.cards[0]?.churn).toBeUndefined();
  });
});
