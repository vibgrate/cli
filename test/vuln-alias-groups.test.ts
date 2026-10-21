import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCoreScan } from '../src/core-open/index.js';
import { orderScanFindings } from '../src/core-open/findings-order.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import {
  generateVulnerabilityFindings,
  groupAdvisoriesByAlias,
  scanVulnerabilities,
} from '../src/core-open/scanners/vulnerability-scanner.js';
import type { Finding, VulnerabilityAdvisory, VulnerabilityScanResult } from '../src/core-open/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

/** Linking record is last. A names B, C names the CVE, and B is what joins them. */
const LODASH_LINK_LAST = [
  {
    id: 'GHSA-aaaa',
    aliases: ['GHSA-bbbb'],
    severity: 'critical' as const,
    cvss: 9.8,
    ranges: [{ introduced: '0', fixed: '4.17.21' }],
  },
  {
    id: 'OSV-1',
    aliases: ['CVE-2024-1111'],
    severity: 'moderate' as const,
    ranges: [{ introduced: '0' }],
  },
  {
    id: 'GHSA-cccc',
    aliases: [] as string[],
    severity: 'low' as const,
    ranges: [{ introduced: '0' }],
  },
  {
    id: 'GHSA-bbbb',
    aliases: ['OSV-1'],
    severity: 'high' as const,
    cvss: 7.5,
    ranges: [{ introduced: '0', fixed: '4.17.22' }],
  },
];

/** Same advisories, linking record first. */
const LODASH_LINK_FIRST = [
  LODASH_LINK_LAST[3]!,
  LODASH_LINK_LAST[2]!,
  LODASH_LINK_LAST[1]!,
  LODASH_LINK_LAST[0]!,
];

const MS_PAIR = [
  {
    id: 'OSV-ms',
    aliases: ['GHSA-ms'],
    severity: 'low' as const,
    ranges: [{ introduced: '0' }],
  },
  {
    id: 'GHSA-ms',
    aliases: ['OSV-ms'],
    severity: 'moderate' as const,
    ranges: [{ introduced: '0', fixed: '3.0.0' }],
  },
];

function manifest(lodashVulns: typeof LODASH_LINK_LAST): PackageVersionManifest {
  return {
    npm: {
      lodash: { vulns: lodashVulns },
      ms: { vulns: MS_PAIR },
      'left-pad': {
        vulns: [
          {
            id: 'GHSA-zzzz',
            aliases: ['CVE-2024-2000'],
            severity: 'moderate',
            ranges: [{ introduced: '0' }],
          },
        ],
      },
    },
  };
}

const TARGETS = [
  { ecosystem: 'npm' as const, package: 'lodash', version: '4.17.20' },
  { ecosystem: 'npm' as const, package: 'ms', version: '2.1.3' },
  { ecosystem: 'npm' as const, package: 'left-pad', version: '1.0.0' },
];

function advisory(
  partial: Pick<VulnerabilityAdvisory, 'id' | 'aliases'> & Partial<VulnerabilityAdvisory>,
): VulnerabilityAdvisory {
  return {
    summary: null,
    severity: 'moderate',
    cvss: null,
    cvssVector: null,
    fixedVersions: [],
    published: null,
    withdrawn: null,
    references: [],
    ...partial,
  };
}

function groupedJson(result: VulnerabilityScanResult): string {
  return JSON.stringify(orderScanFindings(generateVulnerabilityFindings(result, { groupAliases: true })));
}

async function scanGrouped(doc: PackageVersionManifest, targets: typeof TARGETS): Promise<string> {
  const scanned = await scanVulnerabilities(targets, {
    sem: new Semaphore(2),
    offline: true,
    manifest: doc,
  });
  return groupedJson(scanned);
}

describe('transitive advisory alias groups', () => {
  it('picks a stable primary id and does not depend on record order', () => {
    const linkedLast = [
      advisory({ id: 'GHSA-aaaa', aliases: ['GHSA-bbbb'], severity: 'critical', cvss: 9.8, fixedVersions: ['4.17.21'] }),
      advisory({ id: 'OSV-1', aliases: ['CVE-2024-1111'], severity: 'moderate' }),
      advisory({ id: 'GHSA-cccc', aliases: [], severity: 'low' }),
      advisory({ id: 'GHSA-bbbb', aliases: ['OSV-1'], severity: 'high', cvss: 7.5, fixedVersions: ['4.17.22'] }),
    ];
    const linkedFirst = [linkedLast[3]!, linkedLast[2]!, linkedLast[1]!, linkedLast[0]!];

    const forward = groupAdvisoriesByAlias(linkedLast);
    const reverse = groupAdvisoriesByAlias(linkedFirst);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    expect(forward.map((item) => item.id)).toEqual(['CVE-2024-1111', 'GHSA-cccc']);
    expect(forward[0]?.aliases).toEqual(['GHSA-aaaa', 'GHSA-bbbb', 'OSV-1']);
    expect(forward[0]).toMatchObject({ severity: 'critical', cvss: 9.8, fixedVersions: ['4.17.21', '4.17.22'] });
    expect(forward[1]).toMatchObject({ id: 'GHSA-cccc', aliases: [], severity: 'low' });

    const noCve = groupAdvisoriesByAlias([
      advisory({ id: 'OSV-2', aliases: ['GHSA-a'], severity: 'high' }),
      advisory({ id: 'GHSA-z', aliases: ['OSV-2'], severity: 'low' }),
    ]);
    expect(noCve).toHaveLength(1);
    expect(noCve[0]?.id).toBe('GHSA-a');
    expect(noCve[0]?.aliases).toEqual(['GHSA-z', 'OSV-2']);
    expect(noCve[0]?.severity).toBe('low');

    const twoCves = groupAdvisoriesByAlias([
      advisory({ id: 'OSV-x', aliases: ['GHSA-x'], severity: 'critical', cvss: 9.1 }),
      advisory({ id: 'GHSA-x', aliases: ['CVE-2024-2', 'CVE-2020-1'], severity: 'low' }),
    ]);
    expect(twoCves).toHaveLength(1);
    expect(twoCves[0]?.id).toBe('CVE-2020-1');
    expect(twoCves[0]?.aliases).toEqual(['CVE-2024-2', 'GHSA-x', 'OSV-x']);
    expect(twoCves[0]?.severity).toBe('low');

    const alone = groupAdvisoriesByAlias([
      advisory({ id: 'GHSA-zzzz', aliases: ['CVE-2024-2000'] }),
    ]);
    expect(alone[0]?.id).toBe('GHSA-zzzz');
    expect(alone[0]?.aliases).toEqual(['CVE-2024-2000']);
  });

  it('keeps the same JSON when the linking record is last, and does not merge across packages', async () => {
    const first = await scanGrouped(manifest(LODASH_LINK_LAST), TARGETS);
    const second = await scanGrouped(manifest(LODASH_LINK_FIRST), [...TARGETS].reverse());
    expect(second).toBe(first);

    const findings = JSON.parse(first) as Finding[];
    expect(findings.map((finding) => `${finding.location}:${finding.details?.advisoryId}`)).toEqual([
      'left-pad:GHSA-zzzz',
      'lodash:CVE-2024-1111',
      'lodash:GHSA-cccc',
      'ms:GHSA-ms',
    ]);
    expect(findings[1]?.details?.aliases).toEqual(['GHSA-aaaa', 'GHSA-bbbb', 'OSV-1']);
    expect(findings[1]?.message).toBe(
      'lodash@4.17.20: CVE-2024-1111 (critical 9.8) — fix available (4.17.21, 4.17.22)',
    );
    expect(findings[1]?.level).toBe('error');
    expect(findings[2]?.details?.aliases).toEqual([]);
    expect(findings[2]?.message).toBe('lodash@4.17.20: GHSA-cccc (low)');
    expect(findings[0]?.message).toBe('left-pad@1.0.0: GHSA-zzzz (CVE-2024-2000) (moderate)');
    expect(findings[0]?.details?.aliases).toEqual(['CVE-2024-2000']);
    expect(findings[3]?.details?.aliases).toEqual(['OSV-ms']);
    expect(findings[3]?.message).toBe('ms@2.1.3: GHSA-ms (moderate) — fix available (3.0.0)');

    const again = await scanGrouped(manifest(LODASH_LINK_LAST), TARGETS);
    expect(again).toBe(first);

    const split = await scanVulnerabilities(TARGETS, {
      sem: new Semaphore(2),
      offline: true,
      manifest: manifest(LODASH_LINK_LAST),
    });
    const ungrouped = generateVulnerabilityFindings(split);
    expect(ungrouped.filter((finding) => finding.location === 'lodash')).toHaveLength(4);

    const sharedCve: VulnerabilityScanResult = {
      source: 'manifest',
      totalAdvisories: 4,
      severityCounts: { low: 0, moderate: 4, high: 0, critical: 0, unknown: 0 },
      packages: [
        {
          ecosystem: 'npm',
          package: 'other',
          version: '1.0.0',
          advisories: [
            advisory({ id: 'GHSA-b', aliases: ['CVE-1'] }),
            advisory({ id: 'OSV-b', aliases: ['CVE-1'] }),
          ],
        },
        {
          ecosystem: 'npm',
          package: 'lodash',
          version: '1.0.0',
          advisories: [
            advisory({ id: 'GHSA-a', aliases: ['CVE-1'] }),
            advisory({ id: 'OSV-a', aliases: ['GHSA-a'] }),
          ],
        },
      ],
    };
    const perPackage = orderScanFindings(generateVulnerabilityFindings(sharedCve, { groupAliases: true }));
    expect(perPackage.map((finding) => `${finding.location}:${finding.details?.advisoryId}`)).toEqual([
      'lodash:CVE-1',
      'other:CVE-1',
    ]);
    expect(perPackage[0]?.details?.aliases).toEqual(['GHSA-a', 'OSV-a']);
    expect(perPackage[1]?.details?.aliases).toEqual(['GHSA-b', 'OSV-b']);
  });
});

describe('vg scan --vulns JSON alias groups', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-alias-groups-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'alias-groups',
        version: '1.0.0',
        dependencies: { 'left-pad': '1.0.0', lodash: '4.17.20', ms: '2.1.3' },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'alias-groups',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'alias-groups',
            version: '1.0.0',
            dependencies: { 'left-pad': '1.0.0', lodash: '4.17.20', ms: '2.1.3' },
          },
          'node_modules/left-pad': { version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.20' },
          'node_modules/ms': { version: '2.1.3' },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'package-versions.json'),
      JSON.stringify(manifest(LODASH_LINK_LAST)),
    );
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function jsonDocs(logs: readonly string[]): string[] {
    return logs.filter((line) => line.startsWith('{'));
  }

  it('emits one stable group from two offline --package-manifest scans', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const opts = {
      format: 'json' as const,
      concurrency: 2,
      offline: true,
      vulns: true,
      quiet: true,
      noLocalArtifacts: true,
      packageManifest: path.join(root, 'package-versions.json'),
      vibgrateVersion: 'test',
    };
    try {
      const first = await runCoreScan(root, opts);
      const second = await runCoreScan(root, opts);
      const emitted = jsonDocs(logs);
      expect(emitted).toHaveLength(2);

      const vulnJson = (artifact: Awaited<ReturnType<typeof runCoreScan>>): string =>
        JSON.stringify(artifact.findings.filter((finding) => finding.ruleId === 'vibgrate/vulnerability'));
      expect(vulnJson(second)).toBe(vulnJson(first));

      const withoutClock = (line: string): string => {
        const doc = JSON.parse(line) as { timestamp?: string; durationMs?: number; findings?: Finding[] };
        delete doc.timestamp;
        delete doc.durationMs;
        return JSON.stringify(doc);
      };
      expect(withoutClock(emitted[1]!)).toBe(withoutClock(emitted[0]!));

      const vulns = first.findings.filter((finding) => finding.ruleId === 'vibgrate/vulnerability');
      expect(vulns.map((finding) => finding.details?.advisoryId)).toEqual([
        'GHSA-zzzz',
        'CVE-2024-1111',
        'GHSA-cccc',
        'GHSA-ms',
      ]);
      expect(vulns[1]?.details?.aliases).toEqual(['GHSA-aaaa', 'GHSA-bbbb', 'OSV-1']);
      const lodash = first.extended?.vulnerabilities?.packages.find((pkg) => pkg.package === 'lodash');
      expect(lodash?.advisories.map((item) => item.id)).toEqual([
        'GHSA-aaaa',
        'GHSA-bbbb',
        'OSV-1',
        'GHSA-cccc',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps one SARIF result per advisory id', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      await runCoreScan(root, {
        format: 'sarif',
        concurrency: 2,
        offline: true,
        vulns: true,
        quiet: true,
        noLocalArtifacts: true,
        packageManifest: path.join(root, 'package-versions.json'),
        vibgrateVersion: 'test',
      });
      const doc = JSON.parse(jsonDocs(logs)[0] ?? '{}') as {
        runs: Array<{ results: Array<{ ruleId: string; properties?: { advisoryId?: string } }> }>;
      };
      const ids = doc.runs[0]!.results
        .filter((result) => result.ruleId === 'vibgrate/vulnerability')
        .map((result) => result.properties?.advisoryId);
      expect(ids).toEqual([
        'GHSA-zzzz',
        'GHSA-aaaa',
        'GHSA-bbbb',
        'OSV-1',
        'GHSA-cccc',
        'GHSA-ms',
        'OSV-ms',
      ]);
      expect(ids).not.toContain('CVE-2024-1111');
      expect(ids).not.toContain('CVE-2024-2000');
    } finally {
      spy.mockRestore();
    }
  });
});
