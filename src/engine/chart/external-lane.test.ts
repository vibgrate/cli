import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExternalSurface } from '../../core-open/index.js';
import type { ArchSlice } from './arch-types.js';
import { loadExternalSurfaces, withExternalLane } from './external-lane.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function surface(overrides: Partial<ExternalSurface> = {}): ExternalSurface {
  return {
    id: 'sid',
    kind: 'saas',
    provider: { id: 'stripe', displayName: 'Stripe', iconId: 'stripe', category: 'payment' },
    detectedId: 'stripe',
    displayName: 'Stripe',
    version: null,
    freshness: { status: 'unknown', detected: null, latest: null, alternatives: [], catalogSource: 'none' },
    confidence: 'high',
    evidence: [{ signal: 'sdk-package', file: 'src/api/Billing.ts', confidence: 0.9 }],
    callSites: 1,
    projects: [],
    ...overrides,
  };
}

function baseSlice(overrides: Partial<ArchSlice> = {}): ArchSlice {
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
            file: 'src/api/Billing.ts',
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
    ...overrides,
  };
}

describe('loadExternalSurfaces', () => {
  it('returns an empty list when no scan artifact exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ext-lane-'));
    expect(loadExternalSurfaces(dir)).toEqual([]);
  });

  it('reads surfaces from extended.surfaceInventory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ext-lane-'));
    fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.vibgrate', 'scan_result.json'),
      JSON.stringify({ extended: { surfaceInventory: { surfaces: [surface()] } } }),
    );
    const out = loadExternalSurfaces(dir);
    expect(out).toHaveLength(1);
    expect(out[0]?.provider.id).toBe('stripe');
  });

  it('never throws on a malformed artifact', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ext-lane-'));
    fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vibgrate', 'scan_result.json'), 'not json');
    expect(loadExternalSurfaces(dir)).toEqual([]);
  });
});

describe('withExternalLane', () => {
  it('adds a trailing column with an edge from the calling card', () => {
    const out = withExternalLane(baseSlice(), [surface()]);
    expect(out.columns.map((c) => c.id)).toEqual(['app', 'external']);
    const extCol = out.columns.find((c) => c.id === 'external')!;
    expect(extCol.title).toBe('External services');
    expect(extCol.cards[0]?.title).toBe('Stripe');
    expect(extCol.cards[0]?.subtitle).toBe('Payment · SaaS');
    expect(extCol.cards[0]?.logoText).toBe('ST');
    expect(extCol.cards[0]?.providerId).toBe('stripe');
    expect(out.edges).toContainEqual({ id: 'card:billing|calls|external:sid', src: 'card:billing', dst: 'external:sid', kind: 'calls' });
  });

  it('is a no-op when no surface evidence matches a file in this slice', () => {
    const out = withExternalLane(baseSlice(), [surface({ evidence: [{ signal: 'sdk-package', file: 'unrelated/File.ts', confidence: 0.9 }] })]);
    expect(out.columns.map((c) => c.id)).toEqual(['app']);
    expect(out.edges).toEqual([]);
  });

  it('returns the same slice reference when there are no surfaces at all', () => {
    const slice = baseSlice();
    expect(withExternalLane(slice, [])).toBe(slice);
  });

  it('falls back to directory-owned cards when evidence is a manifest declaration, not a traced import', () => {
    // Most real evidence is "this package.json depends on X", not a call
    // site — package.json is never itself a card, so exact-file matching
    // alone would drop this surface entirely.
    const out = withExternalLane(
      baseSlice(),
      [surface({ evidence: [{ signal: 'sdk-package', file: 'src/api/package.json', confidence: 0.9 }] })],
    );
    const extCol = out.columns.find((c) => c.id === 'external');
    expect(extCol?.cards[0]?.title).toBe('Stripe');
    expect(out.edges).toContainEqual({ id: 'card:billing|calls|external:sid', src: 'card:billing', dst: 'external:sid', kind: 'calls' });
  });

  it('attributes a root-level manifest to the package\'s own cards', () => {
    const out = withExternalLane(
      baseSlice(),
      [surface({ evidence: [{ signal: 'sdk-package', file: 'package.json', confidence: 0.9 }] })],
    );
    const extCol = out.columns.find((c) => c.id === 'external');
    expect(extCol?.cards[0]?.title).toBe('Stripe');
  });

  it('does not fall back for a non-manifest file with no card match', () => {
    const out = withExternalLane(
      baseSlice(),
      [surface({ evidence: [{ signal: 'sdk-package', file: 'unrelated/File.ts', confidence: 0.9 }] })],
    );
    expect(out.columns.map((c) => c.id)).toEqual(['app']);
  });

  it('tags a hyperscaler-prefixed product with its vendor family', () => {
    const out = withExternalLane(
      baseSlice(),
      [surface({ provider: { id: 'aws-s3', displayName: 'AWS S3', iconId: 'aws-s3', category: 'storage' }, displayName: 'AWS S3' })],
    );
    const extCol = out.columns.find((c) => c.id === 'external');
    expect(extCol?.cards[0]?.vendorFamily).toBe('aws');
  });

  it('tags a bare vendor product name with no hyperscaler prefix', () => {
    const out = withExternalLane(
      baseSlice(),
      [surface({ provider: { id: 'sql-server', displayName: 'SQL Server', iconId: 'sql-server', category: 'databases' }, displayName: 'SQL Server' })],
    );
    const extCol = out.columns.find((c) => c.id === 'external');
    expect(extCol?.cards[0]?.vendorFamily).toBe('microsoft');
  });

  it('leaves vendorFamily unset for a product with its own brand mark', () => {
    const out = withExternalLane(baseSlice(), [surface()]);
    const extCol = out.columns.find((c) => c.id === 'external');
    expect(extCol?.cards[0]?.vendorFamily).toBeUndefined();
  });
});
