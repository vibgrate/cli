import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fixCommand, applyChosenPlan } from './fix.js';
import type { FixPlanRequest, FixPlanResponse, PlannedUpgrade, VulnDelta } from '../planning/types.js';
import type { ScanArtifact } from '../../core-open/index.js';

/**
 * `vg fix` is a thin, DSN-gated client. These tests mock the hosted planner and
 * assert the client's request shaping, DSN gating, rendering, and exit codes.
 * The planning logic itself is tested server-side in vibgrate-api.
 */

const DSN = 'vibgrate+https://key123:secretabc@us.ingest.vibgrate.com/ws_test';

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function emptyDelta(): VulnDelta {
  return { total: 0, bySeverity: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 } };
}

function mockResponse(over: Partial<FixPlanResponse> = {}): FixPlanResponse {
  return {
    status: 'ok',
    requestId: 'req_1',
    totalCandidates: 1,
    recommended: 'safe',
    rationale: 'Low-risk patch/minor updates are the safe choice.',
    unresolved: emptyDelta(),
    vulnerabilityData: 'osv',
    deepAnalysis: false,
    plans: [
      {
        tier: 'safe',
        label: 'Low-risk',
        description: 'Patch and minor only.',
        upgrades: [
          { package: 'lodash', ecosystem: 'npm', from: '4.17.20', to: '4.17.21', kind: 'patch', blastRadius: 'low', fixes: emptyDelta(), reason: 'low-risk patch update' },
        ],
        excluded: [],
        riskScore: 4,
        confidence: 'high',
        fixes: emptyDelta(),
        introduces: emptyDelta(),
      },
      { tier: 'balanced', label: 'Balanced', description: '', upgrades: [], excluded: [], riskScore: 0, confidence: 'high', fixes: emptyDelta(), introduces: emptyDelta() },
      { tier: 'aggressive', label: 'Full', description: '', upgrades: [], excluded: [], riskScore: 0, confidence: 'high', fixes: emptyDelta(), introduces: emptyDelta() },
    ],
    ...over,
  };
}

/** Build a fake fetch Response for the planner. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => fakeResponse(body, status),
  } as unknown as Response;
}

function writeArtifact(dependencies: unknown[]): void {
  const artifact = {
    schemaVersion: '1.0',
    timestamp: '2024-01-01T00:00:00.000Z',
    vibgrateVersion: 'test',
    rootPath: dir,
    projects: [
      {
        type: 'node',
        path: '.',
        name: 'fixture',
        frameworks: [],
        dependencies,
        dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
      },
    ],
    drift: { score: 40, riskLevel: 'moderate', components: {} },
    findings: [],
  };
  fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vibgrate', 'scan_result.json'), JSON.stringify(artifact));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fix-'));
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

describe('vg fix', () => {
  it('POSTs candidates (all ecosystems) to the planner and renders the response', async () => {
    writeArtifact([
      { package: 'lodash', section: 'dependencies', currentSpec: '^4.17.0', resolvedVersion: '4.17.20', latestStable: '4.17.21', majorsBehind: 0, drift: 'minor-behind' },
    ]);
    let sentBody: FixPlanRequest | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body)) as FixPlanRequest;
      return fakeResponse(mockResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    await fixCommand.parseAsync([dir, '--format', 'json'], { from: 'user' });

    // Request shaping: candidate carries current+latest versions and ecosystem.
    expect(sentBody?.candidates).toHaveLength(1);
    expect(sentBody?.candidates[0]).toMatchObject({ package: 'lodash', ecosystem: 'npm', currentVersion: '4.17.20', latestVersion: '4.17.21' });
    // DSN auth header present.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('VibgrateDSN key123:secretabc');
    // Response rendered as JSON.
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(JSON.parse(printed).recommended).toBe('safe');
  });

  it('requires a DSN and exits with a login CTA when none is set', async () => {
    delete process.env.VIBGRATE_DSN;
    writeArtifact([]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(fixCommand.parseAsync([dir], { from: 'user' })).rejects.toThrow('exit');
    const errs = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errs).toMatch(/needs a Vibgrate login/);
    exitSpy.mockRestore();
  });

  it('surfaces a paid-plan upsell on HTTP 402', async () => {
    writeArtifact([
      { package: 'lodash', section: 'dependencies', currentSpec: '^4.17.0', resolvedVersion: '4.17.20', latestStable: '4.17.21', majorsBehind: 0, drift: 'minor-behind' },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 'error', error: 'not entitled' }, 402)));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(fixCommand.parseAsync([dir], { from: 'user' })).rejects.toThrow('exit');
    const errs = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errs).toMatch(/paid capability/);
    exitSpy.mockRestore();
  });

  it('exits 2 when --fail-on-vulns finds unresolved advisories in the recommended plan', async () => {
    writeArtifact([
      { package: 'lodash', section: 'dependencies', currentSpec: '^4.17.0', resolvedVersion: '4.17.20', latestStable: '4.17.21', majorsBehind: 0, drift: 'minor-behind' },
    ]);
    const resp = mockResponse({
      unresolved: { total: 1, bySeverity: { critical: 1, high: 0, moderate: 0, low: 0, unknown: 0 } },
    });
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(resp)));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    await expect(fixCommand.parseAsync([dir, '--fail-on-vulns', 'high', '--no-apply'], { from: 'user' })).rejects.toThrow('exit:2');
    exitSpy.mockRestore();
  });
});

describe('applyChosenPlan — monorepo routing', () => {
  function upgrade(pkg: string, to: string): PlannedUpgrade {
    return { package: pkg, ecosystem: 'npm', from: '1.0.0', to, kind: 'minor', blastRadius: 'low', fixes: emptyDelta(), reason: 'test' };
  }

  it('routes each upgrade to the sub-project that declares it, with -w only at the workspace root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fix-mono-'));
    // Root is a pnpm workspace; a root devDep (typescript) and a sub-package dep (hono).
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }));

    const artifact = {
      projects: [
        { type: 'typescript', path: '.', packageManager: 'pnpm', dependencies: [{ package: 'typescript' }] },
        { type: 'node', path: 'packages/api', packageManager: 'pnpm', dependencies: [{ package: 'hono' }] },
      ],
    } as unknown as ScanArtifact;

    const results = applyChosenPlan(
      root,
      artifact,
      [upgrade('typescript', '6.0.3'), upgrade('hono', '4.12.28')],
      { dryRun: true },
    );

    const ts = results.find((r) => r.package === 'typescript');
    const hono = results.find((r) => r.package === 'hono');
    // Root workspace dep → -w, no path tag.
    expect(ts?.detail).toContain('would run: pnpm add -w typescript@6.0.3');
    expect(ts?.detail).not.toContain(' in ');
    // Sub-package dep → no -w, tagged with the project path.
    expect(hono?.detail).toContain('would run: pnpm add hono@4.12.28');
    expect(hono?.detail).toContain('in packages/api');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('falls back to the repo root for a package no scanned project declares', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fix-mono-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'solo', private: true }));
    const artifact = { projects: [] } as unknown as ScanArtifact;

    const results = applyChosenPlan(root, artifact, [upgrade('lodash', '4.17.21')], { dryRun: true });
    expect(results[0].detail).toContain('would run: npm install lodash@4.17.21');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
