import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScanReachabilityFinding } from '../../core-open/index.js';
import type { ArchSlice } from './arch-types.js';
import { loadReachabilityFindings, withVulnBadges } from './vuln-annotations.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function finding(overrides: Partial<ScanReachabilityFinding> = {}): ScanReachabilityFinding {
  return {
    advisoryId: 'GHSA-xxxx',
    ecosystem: 'npm',
    package: 'left-pad',
    version: '1.0.0',
    tier: 'reachable',
    sites: [{ file: 'src/api/Billing.ts', line: 12, function: 'charge' }],
    evidence: 'imported in src/api/Billing.ts, called at line 12',
    graphConfidence: 0.9,
    ...overrides,
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
  };
}

describe('loadReachabilityFindings', () => {
  it('returns an empty list when no scan artifact exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vuln-'));
    expect(loadReachabilityFindings(dir)).toEqual([]);
  });

  it('reads findings from reachability.findings', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vuln-'));
    fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.vibgrate', 'scan_result.json'),
      JSON.stringify({ reachability: { findings: [finding()] } }),
    );
    const out = loadReachabilityFindings(dir);
    expect(out).toHaveLength(1);
    expect(out[0]?.advisoryId).toBe('GHSA-xxxx');
  });

  it('never throws on a malformed artifact', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vuln-'));
    fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vibgrate', 'scan_result.json'), 'not json');
    expect(loadReachabilityFindings(dir)).toEqual([]);
  });
});

describe('withVulnBadges', () => {
  it('attaches a vulnerability badge to the matching card', () => {
    const out = withVulnBadges(baseSlice(), [finding()]);
    const card = out.columns[0]?.cards[0];
    expect(card?.vulnerabilities).toHaveLength(1);
    expect(card?.vulnerabilities?.[0]).toMatchObject({ advisoryId: 'GHSA-xxxx', tier: 'reachable', package: 'left-pad' });
  });

  it('is a no-op when no site matches a file in this slice', () => {
    const out = withVulnBadges(baseSlice(), [finding({ sites: [{ file: 'unrelated/File.ts' }] })]);
    expect(out.columns[0]?.cards[0]?.vulnerabilities).toBeUndefined();
  });

  it('drops not_reached and unknown tiers', () => {
    const out = withVulnBadges(baseSlice(), [finding({ tier: 'not_reached' }), finding({ tier: 'unknown' })]);
    expect(out.columns[0]?.cards[0]?.vulnerabilities).toBeUndefined();
  });

  it('returns the same slice reference when there are no findings at all', () => {
    const slice = baseSlice();
    expect(withVulnBadges(slice, [])).toBe(slice);
  });

  it('sorts reachable ahead of potentially_reachable', () => {
    const out = withVulnBadges(baseSlice(), [
      finding({ advisoryId: 'GHSA-later', tier: 'potentially_reachable' }),
      finding({ advisoryId: 'GHSA-first', tier: 'reachable' }),
    ]);
    const vulns = out.columns[0]?.cards[0]?.vulnerabilities;
    expect(vulns?.map((v) => v.advisoryId)).toEqual(['GHSA-first', 'GHSA-later']);
  });
});
