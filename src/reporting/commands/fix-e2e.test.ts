import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCoreScan, type ScanArtifact, type ScanOptions } from '../../core-open/index.js';
import { applyPlan } from '../planning/apply.js';
import type { UpgradeCommand } from '../planning/apply.js';
import type { FixPlanRequest, FixPlanResponse, PlannedUpgrade, VulnDelta } from '../planning/types.js';
import { fixCommand, loadArtifact } from './fix.js';

/**
 * End-to-end tests for the `scan → drift → vg fix → pick a plan → upgrade`
 * journey, exercised on real fixture repositories.
 *
 * Everything is deterministic and offline: the drift scan resolves package
 * versions from a local `--package-manifest` (no registry), the hosted planner
 * is the only network hop and is mocked, and the upgrade is applied through
 * `applyPlan`'s documented test runner (no real `npm install`). The one thing we
 * do for real is compute drift from the actual repository — so a plan applied to
 * the repo and then re-scanned must show the DriftScore actually fall.
 *
 * DriftScore convention (driftscore-2.0): 0 = fully current (best), 100 = worst.
 */

const DSN = 'vibgrate+https://key123:secretabc@us.ingest.vibgrate.com/ws_test';

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function emptyDelta(): VulnDelta {
  return { total: 0, bySeverity: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 } };
}

/** A fake fetch Response for the hosted planner. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => fakeResponse(body, status),
  } as unknown as Response;
}

/** A planner response whose `safe` plan upgrades exactly `upgrades`. */
function plannerResponse(upgrades: PlannedUpgrade[]): FixPlanResponse {
  return {
    status: 'ok',
    requestId: 'req_e2e',
    totalCandidates: upgrades.length,
    recommended: 'safe',
    rationale: 'Low-risk major/minor updates.',
    unresolved: emptyDelta(),
    vulnerabilityData: 'osv',
    deepAnalysis: false,
    plans: [
      {
        tier: 'safe',
        label: 'Low-risk',
        description: 'Ship the recommended upgrades.',
        upgrades,
        excluded: [],
        riskScore: 8,
        confidence: 'high',
        fixes: emptyDelta(),
        introduces: emptyDelta(),
      },
      { tier: 'balanced', label: 'Balanced', description: '', upgrades: [], excluded: [], riskScore: 0, confidence: 'high', fixes: emptyDelta(), introduces: emptyDelta() },
      { tier: 'aggressive', label: 'Full', description: '', upgrades: [], excluded: [], riskScore: 0, confidence: 'high', fixes: emptyDelta(), introduces: emptyDelta() },
    ],
  };
}

/** Install the planner mock and capture the request body the CLI shapes. */
function mockPlanner(response: FixPlanResponse): { sent: () => FixPlanRequest | undefined } {
  let sentBody: FixPlanRequest | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body)) as FixPlanRequest;
      return fakeResponse(response);
    }),
  );
  return { sent: () => sentBody };
}

/** Run a real, fully-offline drift scan of `root` against a local version manifest. */
async function scan(root: string): Promise<ScanArtifact> {
  const opts: ScanOptions = {
    vibgrateVersion: 'test',
    format: 'json',
    out: path.join(dir, 'scratch-scan.json'), // keep JSON off stdout
    quiet: true,
    concurrency: 4,
    offline: true,
    packageManifest: path.join(root, 'versions.json'),
    noLocalArtifacts: false,
  };
  return runCoreScan(root, opts);
}

/** A runner that edits the manifest the way a real package-manager pin would. */
function manifestEditingRunner(command: UpgradeCommand, cwd: string): { ok: boolean } {
  const spec = command.args[command.args.length - 1]; // e.g. "lodash@4.17.21" / "@scope/x@2.0.0"
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string>>;
  for (const section of ['dependencies', 'devDependencies']) {
    if (pkg[section] && name in pkg[section]) pkg[section][name] = version;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return { ok: true };
}

/** Build an npm fixture: lodash is 2 majors behind, chalk is current. */
function npmFixture(): string {
  const root = path.join(dir, 'npm-app');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'npm-app', version: '1.0.0', dependencies: { lodash: '^2.0.0', chalk: '^5.0.0' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), "const _ = require('lodash');\nmodule.exports = _.chunk([1, 2, 3], 2);\n");
  fs.writeFileSync(
    path.join(root, 'versions.json'),
    JSON.stringify({
      npm: {
        lodash: { latest: '4.17.21', versions: ['2.4.2', '3.10.1', '4.17.21'] },
        chalk: { latest: '5.3.0', versions: ['5.3.0'] },
      },
    }),
  );
  return root;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fix-e2e-'));
  process.env.VIBGRATE_DSN = DSN;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.VIBGRATE_DSN;
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vg fix — end to end on real repos', () => {
  it('scans an npm repo, reports drift, and posts only the drifted deps to the planner', async () => {
    const root = npmFixture();

    // 1) Scan first — real, offline drift.
    const artifact = await scan(root);
    const project = artifact.projects[0];
    const lodash = project.dependencies.find((d) => d.package === 'lodash')!;
    expect(lodash.resolvedVersion).toBe('2.4.2');
    expect(lodash.latestStable).toBe('4.17.21');
    expect(lodash.majorsBehind).toBe(2);
    expect(project.dependencyAgeBuckets).toMatchObject({ current: 1, twoPlusBehind: 1 });
    expect(artifact.drift.score).toBeGreaterThan(0); // drift is real, not fabricated

    // 2) vg fix — the planner is mocked; assert the CLI shaped the request from
    //    the scan (chalk is current, so it must NOT be a candidate).
    const planner = mockPlanner(
      plannerResponse([
        { package: 'lodash', ecosystem: 'npm', from: '2.4.2', to: '4.17.21', kind: 'major', blastRadius: 'moderate', fixes: emptyDelta(), reason: 'two majors behind' },
      ]),
    );
    logSpy.mockClear(); // drop the scan's "JSON written" chatter; keep only fix's output
    await fixCommand.parseAsync([root, '--format', 'json'], { from: 'user' });

    const sent = planner.sent();
    expect(sent?.candidates.map((c) => c.package)).toEqual(['lodash']);
    expect(sent?.candidates[0]).toMatchObject({ package: 'lodash', ecosystem: 'npm', currentVersion: '2.4.2', latestVersion: '4.17.21', majorsBehind: 2 });

    // 3) The response is rendered as JSON (a single console.log), and each plan is
    //    annotated with the DriftScore it would reach — computed client-side from
    //    the real scan.
    const printed = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const rendered = JSON.parse(printed) as FixPlanResponse;
    expect(rendered.currentDriftScore).toBe(artifact.drift.score);
    const safe = rendered.plans.find((p) => p.tier === 'safe')!;
    expect(safe.expectedDriftScore).toBe(0); // upgrading lodash to current clears all drift
    expect(safe.driftDelta).toBe(-artifact.drift.score); // strictly better
  });

  it('picks a plan non-interactively and previews the exact upgrade command (--plan --dry-run)', async () => {
    const root = npmFixture();
    await scan(root);
    mockPlanner(
      plannerResponse([
        { package: 'lodash', ecosystem: 'npm', from: '2.4.2', to: '4.17.21', kind: 'major', blastRadius: 'moderate', fixes: emptyDelta(), reason: 'two majors behind' },
      ]),
    );

    await fixCommand.parseAsync([root, '--plan', 'safe', '--dry-run'], { from: 'user' });

    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toMatch(/Dry run/);
    expect(out).toContain('npm install lodash@4.17.21');
    // Dry run never touches the manifest.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies.lodash).toBe('^2.0.0');
  });

  it('applies the chosen plan and a re-scan confirms the DriftScore actually falls', async () => {
    const root = npmFixture();
    const before = await scan(root);
    expect(before.drift.score).toBeGreaterThan(0);

    // The plan the (mocked) planner recommends.
    const upgrades: PlannedUpgrade[] = [
      { package: 'lodash', ecosystem: 'npm', from: '2.4.2', to: '4.17.21', kind: 'major', blastRadius: 'moderate', fixes: emptyDelta(), reason: 'two majors behind' },
    ];

    // Apply it through the same code path the command uses, with a runner that
    // performs the manifest edit a real package manager would.
    const results = applyPlan(root, upgrades, { run: manifestEditingRunner });
    expect(results).toEqual([{ package: 'lodash', to: '4.17.21', status: 'applied', detail: undefined }]);

    // The repository is genuinely upgraded…
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies.lodash).toBe('4.17.21');

    // …and a fresh scan proves the drift is gone, matching the pre-apply estimate.
    const after = await scan(root);
    expect(after.drift.score).toBeLessThan(before.drift.score);
    expect(after.drift.score).toBe(0);
    expect(after.projects[0].dependencyAgeBuckets).toMatchObject({ current: 2, twoPlusBehind: 0 });
  });

  it('collects drifted deps from a python repo too (different ecosystem)', async () => {
    const root = path.join(dir, 'py-app');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'flask==1.1.4\nrequests==2.32.0\n');
    fs.writeFileSync(
      path.join(root, 'versions.json'),
      JSON.stringify({
        pypi: {
          flask: { latest: '3.0.0', versions: ['1.1.4', '2.3.0', '3.0.0'] },
          requests: { latest: '2.32.0', versions: ['2.32.0'] },
        },
      }),
    );

    const artifact = await scan(root);
    const flask = artifact.projects[0].dependencies.find((d) => d.package === 'flask')!;
    expect(flask.resolvedVersion).toBe('1.1.4');
    expect(flask.majorsBehind).toBe(2);
    expect(artifact.drift.score).toBeGreaterThan(0);

    const planner = mockPlanner(
      plannerResponse([
        { package: 'flask', ecosystem: 'pypi', from: '1.1.4', to: '3.0.0', kind: 'major', blastRadius: 'high', fixes: emptyDelta(), reason: 'two majors behind' },
      ]),
    );
    await fixCommand.parseAsync([root, '--format', 'json'], { from: 'user' });

    const sent = planner.sent();
    expect(sent?.candidates.map((c) => c.package)).toContain('flask');
    expect(sent?.candidates.find((c) => c.package === 'flask')).toMatchObject({ ecosystem: 'pypi', currentVersion: '1.1.4', latestVersion: '3.0.0' });
  });
});

describe('vg fix — auto-scan freshness (loadArtifact)', () => {
  const IN = '.vibgrate/scan_result.json';

  /** A minimal on-disk artifact plus a package.json, with controlled mtimes. */
  function seedArtifact(root: string, manifestMtime: number, artifactMtime: number): void {
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    const pkg = path.join(root, 'package.json');
    fs.writeFileSync(pkg, '{"dependencies":{"lodash":"^2.0.0"}}');
    const art = path.join(root, IN);
    fs.writeFileSync(art, JSON.stringify({ schemaVersion: '1.0', projects: [], drift: { score: 12 }, findings: [] }));
    fs.utimesSync(pkg, manifestMtime, manifestMtime);
    fs.utimesSync(art, artifactMtime, artifactMtime);
  }

  it('uses the existing scan when it is up to date (no re-scan)', async () => {
    const root = fs.mkdtempSync(path.join(dir, 'fresh-'));
    seedArtifact(root, 1_700_000_000, 1_700_000_100); // manifest older than artifact
    const rescanner = vi.fn(async () => ({}) as ScanArtifact);

    const artifact = await loadArtifact(root, IN, rescanner);

    expect(rescanner).not.toHaveBeenCalled();
    expect(artifact.drift?.score).toBe(12); // the on-disk scan
  });

  it('auto-triggers a scan when there is no prior scan', async () => {
    const root = fs.mkdtempSync(path.join(dir, 'missing-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const fresh = { schemaVersion: '1.0', projects: [], drift: { score: 3 }, findings: [] } as unknown as ScanArtifact;
    const rescanner = vi.fn(async () => fresh);

    const artifact = await loadArtifact(root, IN, rescanner);

    expect(rescanner).toHaveBeenCalledTimes(1);
    expect(artifact).toBe(fresh);
    const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(err).toMatch(/No scan found/);
  });

  it('auto-triggers a re-scan when the working tree drifted since the scan', async () => {
    const root = fs.mkdtempSync(path.join(dir, 'stale-'));
    seedArtifact(root, 1_700_000_200, 1_700_000_100); // manifest NEWER than artifact
    const fresh = { schemaVersion: '1.0', projects: [], drift: { score: 5 }, findings: [] } as unknown as ScanArtifact;
    const rescanner = vi.fn(async () => fresh);

    const artifact = await loadArtifact(root, IN, rescanner);

    expect(rescanner).toHaveBeenCalledTimes(1);
    expect(artifact).toBe(fresh); // the fresh re-scan, not the stale on-disk one
    const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(err).toMatch(/out of date/);
    expect(err).toMatch(/package\.json/);
  });
});
