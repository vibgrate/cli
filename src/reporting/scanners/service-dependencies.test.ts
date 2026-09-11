import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emptyServiceDependencies, scanServiceDependencies, toServiceDependencies } from './service-dependencies.js';
import { observePackages } from './surfaces/index.js';
import { resetSurfaceCatalogCache } from '../../engine/surface-provider.js';
import type { DependencyRow, ProjectScan } from '../../core-open/index.js';

/**
 * The vendor table this scanner used to inline now lives in the surface
 * catalog, so what is tested here is the **contract**: which packages get
 * observed, how the catalog's rows fold back into the ten legacy buckets, and
 * that an unavailable catalog degrades to empty rather than to a stale partial.
 *
 * The vendor expectations themselves — that `stripe` is Stripe and lands in
 * `payment`, that `@aws-sdk/client-s3` appears in both `cloud` and `storage` —
 * are asserted against the real catalog in the monorepo, next to the data:
 * `packages/vibgrate-relevance/tests/legacy-service-buckets.test.ts`.
 */

function makeDep(pkg: string, version: string | null = '1.0.0'): DependencyRow {
  return {
    package: pkg,
    currentSpec: version ? `^${version}` : '^0.0.0',
    resolvedVersion: version,
    latestStable: version,
    majorsBehind: 0,
    drift: 'current',
    section: 'dependencies',
  };
}

function makeProject(name: string, deps: DependencyRow[], type: ProjectScan['type'] = 'node'): ProjectScan {
  return {
    type,
    name,
    path: `/test/${name}`,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

/**
 * A stand-in catalog module. It answers the one call the scanner makes, so the
 * fold-back logic can be tested deterministically without shipping vendor data
 * into this package — which is the whole point of the split.
 */
const STUB_ROWS = [
  { bucket: 'payment', name: 'Stripe', package: 'stripe', version: '14.0.0' },
  { bucket: 'observability', name: 'Winston', package: 'winston', version: '3.0.0' },
  { bucket: 'observability', name: 'Datadog', package: 'dd-trace', version: '5.0.0' },
  { bucket: 'observability', name: 'MiniSearch', package: 'minisearch', version: null },
  { bucket: 'cloud', name: 'AWS S3', package: '@aws-sdk/client-s3', version: '3.600.0' },
  { bucket: 'storage', name: 'AWS S3', package: '@aws-sdk/client-s3', version: '3.600.0' },
  { bucket: 'not-a-real-bucket', name: 'Nope', package: 'nope', version: null },
];

let stubDir: string;
const previousPath = process.env.VIBGRATE_RELEVANCE_PATH;

beforeAll(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-surface-stub-'));
  fs.writeFileSync(
    path.join(stubDir, 'index.js'),
    `export function createSurfaceCatalog() {
       return {
         classify: (observations) => ({
           inventory: { schema: 'vg-surfaces/1.0', catalog: {}, counts: {}, surfaces: [], unknownHosts: [] },
           serviceDependencies: ${JSON.stringify(STUB_ROWS)}.filter(
             (r) => (observations.packages ?? []).some((p) => p.name === r.package),
           ),
         }),
         search: () => [],
         get: () => null,
         info: () => ({ version: '0', generatedAt: '2026-09-11', providers: 0 }),
       };
     }\n`,
  );
});

afterAll(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

afterEach(() => {
  if (previousPath === undefined) delete process.env.VIBGRATE_RELEVANCE_PATH;
  else process.env.VIBGRATE_RELEVANCE_PATH = previousPath;
  resetSurfaceCatalogCache();
});

function useStub(): void {
  process.env.VIBGRATE_RELEVANCE_PATH = stubDir;
  resetSurfaceCatalogCache();
}

describe('observePackages', () => {
  it('reports package names and versions without knowing any vendor', () => {
    const observed = observePackages([makeProject('shop', [makeDep('stripe', '14.0.0'), makeDep('lodash')])]);
    expect(observed).toEqual([
      { eco: 'npm', name: 'lodash', version: '1.0.0', file: '/test/shop/package.json', project: '/test/shop' },
      { eco: 'npm', name: 'stripe', version: '14.0.0', file: '/test/shop/package.json', project: '/test/shop' },
    ]);
  });

  it('keeps the first version seen when projects disagree', () => {
    const observed = observePackages([
      makeProject('a', [makeDep('stripe', '12.0.0')]),
      makeProject('b', [makeDep('stripe', '14.0.0')]),
    ]);
    expect(observed).toHaveLength(1);
    expect(observed[0].version).toBe('12.0.0');
  });

  it('preserves a null version rather than inventing one', () => {
    expect(observePackages([makeProject('nullver', [makeDep('stripe', null)])])[0].version).toBeNull();
  });

  it('tags each ecosystem so non-Node repos are not silently dropped', () => {
    const observed = observePackages([
      makeProject('api', [makeDep('stripe')], 'python'),
      makeProject('svc', [makeDep('github.com/stripe/stripe-go')], 'go'),
    ]);
    expect(observed.map((o) => o.eco).sort()).toEqual(['go', 'pypi']);
  });

  it('skips project types with no manifest ecosystem', () => {
    expect(observePackages([makeProject('mobile', [makeDep('stripe')], 'swift')])).toEqual([]);
  });
});

describe('toServiceDependencies', () => {
  it('folds catalog rows into the ten legacy buckets', () => {
    const result = toServiceDependencies(STUB_ROWS);
    expect(result.payment).toEqual([{ name: 'Stripe', package: 'stripe', version: '14.0.0' }]);
    expect(result.cloud.map((i) => i.name)).toContain('AWS S3');
    expect(result.storage.map((i) => i.name)).toContain('AWS S3');
  });

  it('drops a bucket the artifact does not define', () => {
    const result = toServiceDependencies(STUB_ROWS);
    expect(Object.keys(result).sort()).toEqual(
      ['auth', 'cloud', 'crm', 'databases', 'email', 'messaging', 'observability', 'payment', 'search', 'storage'],
    );
    expect(JSON.stringify(result)).not.toContain('Nope');
  });

  it('sorts within a bucket the way the artifact always has', () => {
    // Locale-aware, not byte order: 'MiniSearch' sorts after 'Datadog' and
    // before 'Winston', where a byte sort would put every capital first.
    expect(toServiceDependencies(STUB_ROWS).observability.map((i) => i.name)).toEqual([
      'Datadog',
      'MiniSearch',
      'Winston',
    ]);
  });

  it('returns all ten buckets empty for no rows', () => {
    const result = toServiceDependencies([]);
    for (const items of Object.values(result)) expect(items).toEqual([]);
    expect(result).toEqual(emptyServiceDependencies());
  });
});

describe('scanServiceDependencies', () => {
  it('classifies observed packages through the catalog', async () => {
    useStub();
    const result = await scanServiceDependencies([makeProject('shop', [makeDep('stripe', '14.0.0')])]);
    expect(result.payment).toEqual([{ name: 'Stripe', package: 'stripe', version: '14.0.0' }]);
  });

  it('returns empty buckets for projects with no matching packages', async () => {
    useStub();
    const result = await scanServiceDependencies([makeProject('clean', [makeDep('express'), makeDep('lodash')])]);
    for (const items of Object.values(result)) expect(items).toEqual([]);
  });

  it('returns empty buckets — never a stale partial — when no catalog is available', async () => {
    process.env.VIBGRATE_RELEVANCE_PATH = path.join(stubDir, 'does-not-exist');
    resetSurfaceCatalogCache();
    const result = await scanServiceDependencies([makeProject('shop', [makeDep('stripe', '14.0.0')])]);
    expect(result).toEqual(emptyServiceDependencies());
  });

  it('survives a catalog that throws', async () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-surface-broken-'));
    fs.writeFileSync(
      path.join(brokenDir, 'index.js'),
      `export function createSurfaceCatalog() {
         return { classify: () => { throw new Error('boom'); }, search: () => [], get: () => null, info: () => ({}) };
       }\n`,
    );
    process.env.VIBGRATE_RELEVANCE_PATH = brokenDir;
    resetSurfaceCatalogCache();
    try {
      await expect(scanServiceDependencies([makeProject('shop', [makeDep('stripe')])])).resolves.toEqual(
        emptyServiceDependencies(),
      );
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true });
    }
  });
});
