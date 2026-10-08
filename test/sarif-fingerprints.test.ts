import { describe, expect, it } from 'vitest';
import { baselineSuppressionId } from '../src/core-open/baseline-suppressions.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { generateVulnerabilityFindings, scanVulnerabilities } from '../src/core-open/index.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import type { Finding, ScanArtifact } from '../src/core-open/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

interface SarifResult {
  ruleId: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

interface SarifDoc {
  runs: Array<{
    invocations?: Array<{ startTimeUtc?: string }>;
    results: SarifResult[];
  }>;
}

const MANIFEST: PackageVersionManifest = {
  npm: {
    lodash: {
      vulns: [
        {
          id: 'GHSA-bbbb',
          aliases: ['CVE-2024-1111'],
          severity: 'critical',
          cvss: 9.1,
          ranges: [{ introduced: '0', fixed: '4.17.21' }],
        },
        {
          id: 'CVE-2024-1111',
          aliases: ['GHSA-bbbb'],
          severity: 'high',
          cvss: 7.5,
          ranges: [{ introduced: '0', fixed: '4.17.21' }],
        },
      ],
    },
    chalk: {
      vulns: [
        {
          id: 'GHSA-chalk',
          aliases: [],
          severity: 'moderate',
          ranges: [{ introduced: '0' }],
        },
      ],
    },
  },
};

const TARGETS = [
  { ecosystem: 'npm' as const, package: 'lodash', version: '4.17.20' },
  { ecosystem: 'npm' as const, package: 'chalk', version: '4.1.2' },
];

const DRIFT: Finding[] = [
  {
    ruleId: 'vibgrate/runtime-lag',
    level: 'warning',
    message: 'Node.js runtime ">=20.0.0" is 2 major versions behind.',
    location: 'app',
  },
  {
    ruleId: 'vibgrate/dependency-rot',
    level: 'error',
    message: '20% of dependencies are 2+ major versions behind.',
    location: 'app',
  },
  {
    ruleId: 'vibgrate/dependency-major-lag',
    level: 'error',
    message: 'left-pad is 3 major versions behind (spec: ^1.0.0, latest: 5.0.0).',
    location: 'app',
  },
  {
    ruleId: 'vibgrate/dependency-major-lag',
    level: 'error',
    message: 'moment is 4 major versions behind (spec: ^2.0.0, latest: 2.30.1).',
    location: 'app',
  },
];

function artifact(findings: Finding[], timestamp: string): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp,
    vibgrateVersion: '0.0.0-test',
    rootPath: '.',
    projects: [],
    drift: {
      score: 40,
      riskLevel: 'moderate',
      components: { runtimeScore: 40, frameworkScore: 40, dependencyScore: 40, eolScore: 40 },
    },
    findings,
  };
}

function resultKey(result: SarifResult): string {
  return [
    result.ruleId,
    result.locations[0]?.physicalLocation.artifactLocation.uri ?? '',
    result.message.text,
    String(result.properties?.advisoryId ?? ''),
  ].join('\n');
}

function fingerprintsByKey(doc: SarifDoc): Map<string, string> {
  const map = new Map<string, string>();
  for (const result of doc.runs[0]?.results ?? []) {
    const value = result.partialFingerprints?.['vg/finding-id/v1'];
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    map.set(resultKey(result), value!);
  }
  return map;
}

describe('vg scan SARIF partial fingerprints', () => {
  it('matches fingerprints for the same offline fixture when timestamp and order differ', async () => {
    const sem = new Semaphore(1);
    const scanned = await scanVulnerabilities(TARGETS, { sem, offline: true, manifest: MANIFEST });
    const again = await scanVulnerabilities([...TARGETS].reverse(), { sem, offline: true, manifest: MANIFEST });
    expect(again.packages).toEqual(scanned.packages);

    const vulns = generateVulnerabilityFindings(scanned);
    expect(vulns.length).toBeGreaterThan(1);
    const findings = [...DRIFT, ...vulns];

    const first = formatSarif(artifact(findings, '2026-01-01T00:00:00.000Z')) as SarifDoc;
    const second = formatSarif(artifact([...findings].reverse(), '2026-10-07T15:04:00.000Z')) as SarifDoc;

    expect(first.runs[0]?.invocations?.[0]?.startTimeUtc).toBe('2026-01-01T00:00:00.000Z');
    expect(second.runs[0]?.invocations?.[0]?.startTimeUtc).toBe('2026-10-07T15:04:00.000Z');

    const a = fingerprintsByKey(first);
    const b = fingerprintsByKey(second);
    expect(b).toEqual(a);
    expect(new Set(a.values()).size).toBe(findings.length);

    for (const finding of findings) {
      const result = first.runs[0]?.results.find((r) => r.message.text === finding.message);
      expect(result?.message.text).toBe(finding.message);
    }

    const runtime = first.runs[0]?.results.find((r) => r.ruleId === 'vibgrate/runtime-lag');
    expect(runtime?.partialFingerprints).toEqual({
      'vg/finding-id/v1': baselineSuppressionId('vibgrate/runtime-lag', 'app'),
    });
  });

  it('gives distinct findings distinct fingerprints', async () => {
    const sem = new Semaphore(1);
    const scanned = await scanVulnerabilities(TARGETS, { sem, offline: true, manifest: MANIFEST });
    const findings = [...DRIFT, ...generateVulnerabilityFindings(scanned)];
    const doc = formatSarif(artifact(findings, '2026-10-07T00:00:00.000Z')) as SarifDoc;
    const values = (doc.runs[0]?.results ?? []).map((r) => r.partialFingerprints?.['vg/finding-id/v1']);
    expect(values.every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
    expect(new Set(values).size).toBe(findings.length);

    const lodash = (doc.runs[0]?.results ?? []).filter(
      (r) => r.properties?.package === 'lodash',
    );
    expect(lodash).toHaveLength(2);
    expect(lodash[0]?.partialFingerprints?.['vg/finding-id/v1']).not.toBe(
      lodash[1]?.partialFingerprints?.['vg/finding-id/v1'],
    );

    const lag = (doc.runs[0]?.results ?? []).filter((r) => r.ruleId === 'vibgrate/dependency-major-lag');
    expect(lag).toHaveLength(2);
    expect(lag[0]?.partialFingerprints?.['vg/finding-id/v1']).not.toBe(
      lag[1]?.partialFingerprints?.['vg/finding-id/v1'],
    );
  });

  it('keeps a major-lag fingerprint when the latest version in the message changes', () => {
    const location = 'services/web';
    const before: Finding = {
      ruleId: 'vibgrate/dependency-major-lag',
      level: 'error',
      message: 'chalk is 3 major versions behind (spec: ^4.0.0, latest: 5.4.0).',
      location,
    };
    const after: Finding = {
      ...before,
      message: 'chalk is 4 major versions behind (spec: ^4.0.0, latest: 8.0.0).',
    };
    const other: Finding = {
      ...before,
      message: 'lodash is 3 major versions behind (spec: ^4.17.0, latest: 5.4.0).',
    };
    const fp = (finding: Finding) => {
      const doc = formatSarif(artifact([finding], '2026-02-02T00:00:00.000Z')) as SarifDoc;
      return doc.runs[0]?.results[0]?.partialFingerprints?.['vg/finding-id/v1'];
    };
    expect(fp(before)).toBe(fp(after));
    expect(fp(before)).not.toBe(fp(other));
    const doc = formatSarif(artifact([after], '2026-03-03T00:00:00.000Z')) as SarifDoc;
    expect(doc.runs[0]?.results[0]?.message.text).toBe(after.message);
  });

  it('matches the vulnerability fingerprint shown in DOCS.md', () => {
    const finding: Finding = {
      ruleId: 'vibgrate/vulnerability',
      level: 'error',
      message: 'lodash@4.17.20: GHSA-bbbb (CVE-2024-1111) (critical 9.1) — fix available (4.17.21)',
      location: 'lodash',
      details: {
        ecosystem: 'npm',
        package: 'lodash',
        installedVersion: '4.17.20',
        advisoryId: 'GHSA-bbbb',
        aliases: ['CVE-2024-1111', 'OSV-1'],
        severity: 'critical',
        cvss: 9.1,
        fixedVersions: ['4.17.21'],
      },
    };
    const doc = formatSarif(artifact([finding], '2026-01-01T00:00:00.000Z')) as SarifDoc;
    expect(doc.runs[0]?.results[0]?.partialFingerprints).toEqual({
      'vg/finding-id/v1': '82efba63199c173114225d3195aa15aa',
    });
    expect(doc.runs[0]?.results[0]?.message.text).toBe(finding.message);
  });
});
