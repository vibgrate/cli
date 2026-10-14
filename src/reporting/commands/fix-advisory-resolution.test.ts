import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isVersionAffected } from '../../core-open/scanners/vulnerability-scanner.js';
import { fixCommand } from './fix.js';
import { resolveAdvisoryPlan, type AdvisoryResolutionReport, type AdvisoryStatusEntry } from '../planning/advisory-resolution.js';

/**
 * Fixture proof that `vg fix --offline --package-manifest` never reports an
 * advisory as resolved when the upgrade that would clear it is blocked.
 */

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const prevCreds = process.env.VIBGRATE_CREDENTIALS;
const prevDsn = process.env.VIBGRATE_DSN;

interface LockPackage {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Fixture {
  name: string;
  dependencies: Record<string, string>;
  packages: Record<string, LockPackage>;
  manifest: Record<string, unknown>;
}

function writeFixture(fixture: Fixture): { root: string; manifestPath: string } {
  const root = path.join(dir, fixture.name);
  fs.mkdirSync(root, { recursive: true });
  const pkg = {
    name: fixture.name,
    version: '1.0.0',
    dependencies: fixture.dependencies,
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const packages: Record<string, unknown> = {
    '': { name: fixture.name, version: '1.0.0', dependencies: fixture.dependencies },
  };
  for (const [name, entry] of Object.entries(fixture.packages)) {
    packages[`node_modules/${name}`] = entry;
  }
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ name: fixture.name, lockfileVersion: 3, packages }),
  );
  const manifestPath = path.join(root, 'package-versions.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ npm: fixture.manifest }));
  return { root, manifestPath };
}

function advisory(
  id: string,
  severity: string,
  range: { introduced?: string; fixed?: string },
  versions?: string[],
): Record<string, unknown> {
  return {
    id,
    severity,
    ...(versions ? { versions } : { ranges: [range] }),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fix-advisory-'));
  delete process.env.VIBGRATE_DSN;
  process.env.VIBGRATE_CREDENTIALS = path.join(dir, 'no-credentials.json');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (prevDsn === undefined) delete process.env.VIBGRATE_DSN;
  else process.env.VIBGRATE_DSN = prevDsn;
  if (prevCreds === undefined) delete process.env.VIBGRATE_CREDENTIALS;
  else process.env.VIBGRATE_CREDENTIALS = prevCreds;
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function runFix(root: string, manifestPath: string, extra: string[] = []): Promise<AdvisoryResolutionReport> {
  logSpy.mockClear();
  await fixCommand.parseAsync([root, '--offline', '--package-manifest', manifestPath, '--format', 'json', '--no-apply', ...extra], {
    from: 'user',
  });
  const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  return JSON.parse(printed) as AdvisoryResolutionReport;
}

function planOf(report: AdvisoryResolutionReport): AdvisoryResolutionReport['plans'][number] {
  expect(report.offline).toBe(true);
  expect(report.plans).toHaveLength(1);
  return report.plans[0];
}

function entry(report: AdvisoryResolutionReport, id: string): AdvisoryStatusEntry {
  const found = planOf(report).advisories.find((item) => item.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

/** Resolved rows must name a planned version outside the affected range. */
function assertResolvedAreOutside(report: AdvisoryResolutionReport, manifest: Record<string, unknown>): void {
  for (const advisoryEntry of planOf(report).advisories) {
    if (advisoryEntry.status !== 'resolved') {
      expect(advisoryEntry.plannedVersion).toBeNull();
      continue;
    }
    expect(advisoryEntry.plannedVersion).toBeTruthy();
    const pkg = manifest[advisoryEntry.package] as { vulns?: Array<Record<string, unknown>> };
    const vuln = pkg.vulns?.find((item) => item.id === advisoryEntry.id);
    expect(vuln).toBeDefined();
    const ranges = vuln?.ranges as Array<{ introduced?: string; fixed?: string }> | undefined;
    const versions = vuln?.versions as string[] | undefined;
    expect(isVersionAffected(advisoryEntry.plannedVersion!, ranges, versions)).toBe(false);
    expect(planOf(report).upgrades.some((upgrade) => upgrade.package === advisoryEntry.package && upgrade.to === advisoryEntry.plannedVersion)).toBe(true);
  }
}

describe('vg fix --offline --package-manifest advisory resolution', () => {
  it('resolves a direct dependency when the fixed version is inside the allowed policy', async () => {
    const manifest = {
      lodash: {
        latest: '4.17.21',
        versions: ['4.17.20', '4.17.21'],
        vulns: [advisory('GHSA-lodash-clean', 'high', { introduced: '0', fixed: '4.17.21' })],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'direct-clean',
      dependencies: { lodash: '^4.17.0' },
      packages: { lodash: { version: '4.17.20' } },
      manifest,
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('offline fix must not call the network');
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await runFix(root, manifestPath);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.policy).toBe('safe');
    const row = entry(report, 'GHSA-lodash-clean');
    expect(row.status).toBe('resolved');
    expect(row.plannedVersion).toBe('4.17.21');
    expect(row.reason).toBe('resolved by lodash@4.17.21');
    expect(planOf(report).upgrades).toEqual([
      { package: 'lodash', ecosystem: 'npm', from: '4.17.20', to: '4.17.21' },
    ]);
    assertResolvedAreOutside(report, manifest);
  });

  it('blocks a transitive advisory pinned to a vulnerable range when the parent cannot move', async () => {
    const manifest = {
      wrapper: {
        latest: '1.0.0',
        versions: ['1.0.0'],
        requires: { '1.0.0': { nested: '>=1.0.0 <1.0.2' } },
      },
      nested: {
        latest: '1.0.2',
        versions: ['1.0.1', '1.0.2'],
        vulns: [advisory('GHSA-nested-pin', 'high', { introduced: '0', fixed: '1.0.2' })],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'transitive-pin',
      dependencies: { wrapper: '1.0.0' },
      packages: {
        wrapper: { version: '1.0.0', dependencies: { nested: '>=1.0.0 <1.0.2' } },
        nested: { version: '1.0.1' },
      },
      manifest,
    });

    const report = await runFix(root, manifestPath);
    const row = entry(report, 'GHSA-nested-pin');
    expect(row.status).toBe('blocked');
    expect(row.plannedVersion).toBeNull();
    expect(row.reason).toContain('wrapper@1.0.0');
    expect(row.reason).toContain('nested@>=1.0.0 <1.0.2');
    expect(planOf(report).upgrades).toEqual([]);
    assertResolvedAreOutside(report, manifest);
  });

  it('resolves a transitive advisory only when the plan also bumps the parent that pins it', async () => {
    const manifest = {
      wrapper: {
        latest: '1.1.0',
        versions: ['1.0.0', '1.1.0'],
        requires: {
          '1.0.0': { nested: '>=1.0.0 <1.0.2' },
          '1.1.0': { nested: '^1.0.2' },
        },
      },
      nested: {
        latest: '1.0.2',
        versions: ['1.0.1', '1.0.2'],
        vulns: [advisory('GHSA-nested-parent', 'high', { introduced: '0', fixed: '1.0.2' })],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'transitive-parent-bump',
      dependencies: { wrapper: '1.0.0' },
      packages: {
        wrapper: { version: '1.0.0', dependencies: { nested: '>=1.0.0 <1.0.2' } },
        nested: { version: '1.0.1' },
      },
      manifest,
    });
    const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;

    const childOnly = resolveAdvisoryPlan({
      rootDir: root,
      manifest: manifestJson,
      policy: 'safe',
      upgrades: [{ package: 'nested', to: '1.0.2' }],
    });
    const blocked = entry(childOnly, 'GHSA-nested-parent');
    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toContain('wrapper@1.0.0');
    expect(blocked.reason).toContain('nested@>=1.0.0 <1.0.2');

    const report = await runFix(root, manifestPath);
    const row = entry(report, 'GHSA-nested-parent');
    expect(row.status).toBe('resolved');
    expect(row.plannedVersion).toBe('1.0.2');
    expect(planOf(report).upgrades).toEqual([
      { package: 'nested', ecosystem: 'npm', from: '1.0.1', to: '1.0.2' },
      { package: 'wrapper', ecosystem: 'npm', from: '1.0.0', to: '1.1.0' },
    ]);
    assertResolvedAreOutside(report, manifest);
  });

  it('reports a major fix outside the allowed policy as blocked, naming the package and range', async () => {
    const manifest = {
      legacy: {
        latest: '2.0.0',
        versions: ['1.2.3', '2.0.0'],
        vulns: [advisory('GHSA-legacy-major', 'critical', { introduced: '0', fixed: '2.0.0' })],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'major-policy',
      dependencies: { legacy: '^1.2.0' },
      packages: { legacy: { version: '1.2.3' } },
      manifest,
    });

    const blockedReport = await runFix(root, manifestPath);
    const blocked = entry(blockedReport, 'GHSA-legacy-major');
    expect(blocked.status).toBe('blocked');
    expect(blocked.plannedVersion).toBeNull();
    expect(blocked.reason).toContain('legacy');
    expect(blocked.reason).toContain('>=1.2.3 <2.0.0');
    expect(blocked.reason).toContain('fix requires 2.0.0');
    expect(planOf(blockedReport).upgrades).toEqual([]);
    assertResolvedAreOutside(blockedReport, manifest);

    const allowed = await runFix(root, manifestPath, ['--plan', 'aggressive']);
    const resolved = entry(allowed, 'GHSA-legacy-major');
    expect(allowed.policy).toBe('aggressive');
    expect(resolved.status).toBe('resolved');
    expect(resolved.plannedVersion).toBe('2.0.0');
    assertResolvedAreOutside(allowed, manifest);
  });

  it('reports an advisory with no fixed version as "no fix available" and does not hide it', async () => {
    const manifest = {
      abandoned: {
        latest: '1.0.0',
        versions: ['1.0.0'],
        vulns: [advisory('GHSA-abandoned-nofix', 'moderate', { introduced: '0' })],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'no-fix',
      dependencies: { abandoned: '1.0.0' },
      packages: { abandoned: { version: '1.0.0' } },
      manifest,
    });

    const report = await runFix(root, manifestPath);
    expect(planOf(report).advisories).toHaveLength(1);
    const row = entry(report, 'GHSA-abandoned-nofix');
    expect(row.status).toBe('no-fix');
    expect(row.reason).toBe('no fix available');
    expect(row.plannedVersion).toBeNull();
    expect(planOf(report).upgrades).toEqual([]);
  });

  it('does not resolve an upgrade that is still inside the affected range', async () => {
    const manifest = {
      half: {
        latest: '1.5.0',
        versions: ['1.0.0', '1.5.0', '2.0.0'],
        vulns: [advisory('GHSA-still-affected', 'high', { introduced: '0', fixed: '2.0.0' })],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'still-affected',
      dependencies: { half: '^1.0.0' },
      packages: { half: { version: '1.0.0' } },
      manifest,
    });

    const report = await runFix(root, manifestPath);
    const row = entry(report, 'GHSA-still-affected');
    expect(row.status).toBe('blocked');
    expect(row.plannedVersion).toBeNull();
    expect(row.reason).toContain('half');
    expect(row.reason).toContain('>=1.0.0 <2.0.0');
    expect(planOf(report).upgrades).toEqual([]);
    expect(isVersionAffected('1.5.0', [{ introduced: '0', fixed: '2.0.0' }], undefined)).toBe(true);
  });

  it('emits the same advisory order on every run', async () => {
    const manifest = {
      zebra: {
        latest: '1.0.0',
        versions: ['1.0.0'],
        vulns: [advisory('GHSA-z', 'low', { introduced: '0' })],
      },
      alpha: {
        latest: '1.0.0',
        versions: ['1.0.0'],
        vulns: [
          advisory('GHSA-b', 'high', { introduced: '0' }),
          advisory('GHSA-a', 'low', { introduced: '0' }),
        ],
      },
    };
    const { root, manifestPath } = writeFixture({
      name: 'order-fixture',
      dependencies: { zebra: '1.0.0', alpha: '1.0.0' },
      packages: {
        zebra: { version: '1.0.0' },
        alpha: { version: '1.0.0' },
      },
      manifest,
    });

    const first = await runFix(root, manifestPath);
    const second = await runFix(root, manifestPath);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(planOf(first).advisories.map((item) => `${item.package}:${item.id}`)).toEqual([
      'alpha:GHSA-a',
      'alpha:GHSA-b',
      'zebra:GHSA-z',
    ]);
  });

  it('refuses --offline without a manifest and does not call the network', async () => {
    const root = path.join(dir, 'empty');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }));
    const fetchMock = vi.fn(async () => {
      throw new Error('offline fix must not call the network');
    });
    vi.stubGlobal('fetch', fetchMock);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(fixCommand.parseAsync([root, '--offline', '--format', 'json'], { from: 'user' })).rejects.toThrow('exit:1');
    expect(fetchMock).not.toHaveBeenCalled();
    const errs = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(errs).toContain('--offline requires --package-manifest <file>.');
    exitSpy.mockRestore();
  });
});
