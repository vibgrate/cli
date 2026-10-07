// Owned by the public CLI. Lives here (not under src/core-open, which a vendor
// sync replaces) so a refresh that drops partialFingerprints fails this test.
import { describe, expect, it } from 'vitest';
import { baselineSuppressionId } from '../src/core-open/baseline-suppressions.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { generateVulnerabilityFindings, scanVulnerabilities } from '../src/core-open/index.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import type { Finding, ScanArtifact, SecurityFinding, SecuritySection } from '../src/core-open/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const FINGERPRINT_KEY = 'vg/finding-id/v1';

interface SarifResult {
  ruleId: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
  suppressions?: Array<{ properties?: { id?: string } }>;
}

interface SarifDoc {
  runs: Array<{
    results: SarifResult[];
    invocations?: Array<{ startTimeUtc?: string }>;
  }>;
}

/** Manifest order is deliberately not the documented SARIF order. */
const MANIFEST: PackageVersionManifest = {
  npm: {
    lodash: {
      vulns: [
        {
          id: 'CVE-2024-1111',
          aliases: ['GHSA-bbbb'],
          severity: 'high',
          cvss: 7.5,
          ranges: [{ introduced: '0', fixed: '4.17.21' }],
        },
        {
          id: 'GHSA-bbbb',
          aliases: ['CVE-2024-1111', 'OSV-1'],
          severity: 'critical',
          cvss: 9.1,
          ranges: [{ introduced: '0', fixed: '4.17.21' }],
        },
      ],
    },
  },
};

const DRIFT: Finding[] = [
  {
    ruleId: 'vibgrate/runtime-lag',
    level: 'warning',
    message: 'Node.js runtime ">=20.0.0" is 2 major versions behind (latest: 22.0.0).',
    location: 'app',
  },
  {
    ruleId: 'vibgrate/dependency-major-lag',
    level: 'error',
    message: 'chalk is 3 major versions behind (spec: ^4.0.0, latest: 5.4.0).',
    location: 'app',
  },
  {
    ruleId: 'vibgrate/dependency-major-lag',
    level: 'error',
    message: 'left-pad is 4 major versions behind (spec: ^0.0.1, latest: 1.3.0).',
    location: 'app',
  },
  {
    ruleId: 'vibgrate/license-parse-failed',
    level: 'warning',
    message: 'License "Also-Not-SPDX" on left-pad could not be resolved as SPDX.',
    location: 'package.json',
    details: { sourcePath: 'package.json', raw: 'Also-Not-SPDX' },
  },
];

const SECURITY: SecurityFinding[] = [
  {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pack: 'iac-cis-v1',
    packVersion: '1',
    rule: 'aws-s3-public',
    severity: 'high',
    message: 'S3 bucket logs allows public access.',
    path: 'infra/s3.tf',
    line: 1,
    address: 'aws_s3_bucket.logs',
  },
  {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    pack: 'iac-cis-v1',
    packVersion: '1',
    rule: 'aws-s3-public',
    severity: 'high',
    message: 'S3 bucket uploads allows public access.',
    path: 'infra/s3.tf',
    line: 8,
    address: 'aws_s3_bucket.uploads',
  },
];

function securitySection(findings: SecurityFinding[]): SecuritySection {
  return {
    schema: 'vg.security.v1',
    engine: 'test-engine',
    packs: { 'iac-cis-v1': '1' },
    facts: { received: findings.length, evaluated: findings.length, rejected: 0 },
    findings,
  };
}

function artifact(options: {
  timestamp: string;
  findings: Finding[];
  security?: SecurityFinding[];
  baselineId?: { ruleId: string; location: string; id: string };
}): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: options.timestamp,
    vibgrateVersion: '0.0.0-test',
    rootPath: '.',
    projects: [],
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: options.findings,
    ...(options.baselineId
      ? {
          baselineComparison: {
            compared: true,
            suppressedCount: 1,
            suppressed: [options.baselineId],
          },
        }
      : {}),
    ...(options.security
      ? { extended: { security: securitySection(options.security) } }
      : {}),
  };
}

function fingerprint(result: SarifResult): string {
  const value = result.partialFingerprints?.[FINGERPRINT_KEY];
  if (!value) throw new Error(`missing ${FINGERPRINT_KEY} on ${result.ruleId}`);
  return value;
}

/** Identity that ignores result order, message wording, and detail key order. */
function advisoryIdentity(result: SarifResult): string | undefined {
  const advisoryId = result.properties?.advisoryId;
  if (typeof advisoryId !== 'string' || advisoryId.length === 0) return undefined;
  return [
    'advisory',
    result.ruleId,
    result.locations[0]?.physicalLocation.artifactLocation.uri ?? '',
    String(result.properties?.ecosystem ?? ''),
    String(result.properties?.package ?? ''),
    String(result.properties?.installedVersion ?? ''),
    advisoryId,
  ].join('\n');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function driftIdentity(result: SarifResult): string {
  return [
    'drift',
    result.ruleId,
    result.locations[0]?.physicalLocation.artifactLocation.uri ?? '',
    result.message.text,
    JSON.stringify(sortKeys(result.properties ?? null)),
  ].join('\n');
}

function indexFingerprints(doc: SarifDoc): Map<string, string> {
  const index = new Map<string, string>();
  for (const result of doc.runs[0]?.results ?? []) {
    const key = advisoryIdentity(result) ?? driftIdentity(result);
    index.set(key, fingerprint(result));
  }
  return index;
}

function reverseKeys(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(details).reverse()) out[key] = details[key];
  return out;
}

function withUnstableSurface(finding: Finding): Finding {
  if (typeof finding.details?.advisoryId !== 'string') {
    if (!finding.details) return finding;
    return { ...finding, details: reverseKeys(finding.details) };
  }
  const aliases = finding.details.aliases;
  return {
    ...finding,
    message: `${finding.message} — introduced by Ada in abcdef (9d exposed)`,
    details: reverseKeys({
      ...finding.details,
      aliases: Array.isArray(aliases) ? [...aliases].reverse() : aliases,
      exposureDays: 9,
      introducedDate: '2020-01-02',
    }),
  };
}

describe('vg scan SARIF partialFingerprints', () => {
  it('matches fingerprints when only the timestamp and finding order change', async () => {
    const scanned = await scanVulnerabilities(
      [{ ecosystem: 'npm', package: 'lodash', version: '4.17.20' }],
      { sem: new Semaphore(1), offline: true, manifest: MANIFEST },
    );
    const vulns = generateVulnerabilityFindings(scanned);
    const findings = [...DRIFT, ...vulns];
    const first = artifact({
      timestamp: '2026-01-01T00:00:00.000Z',
      findings,
      security: SECURITY,
    });
    const second = artifact({
      timestamp: '2026-06-15T12:34:56.000Z',
      findings: [...findings].reverse().map(withUnstableSurface),
      security: [...SECURITY].reverse(),
    });

    const sarifA = formatSarif(first) as SarifDoc;
    const sarifB = formatSarif(second) as SarifDoc;
    expect(formatSarif(first)).toEqual(sarifA);

    expect(sarifA.runs[0]?.invocations?.[0]?.startTimeUtc).toBe('2026-01-01T00:00:00.000Z');
    expect(sarifB.runs[0]?.invocations?.[0]?.startTimeUtc).toBe('2026-06-15T12:34:56.000Z');
    expect(sarifA.runs[0]?.results.map((result) => result.ruleId)).not.toEqual(
      sarifB.runs[0]?.results.map((result) => result.ruleId),
    );

    const indexA = indexFingerprints(sarifA);
    const indexB = indexFingerprints(sarifB);
    expect(indexB).toEqual(indexA);

    for (const doc of [sarifA, sarifB]) {
      const results = doc.runs.flatMap((run) => run.results);
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(fingerprint(result)).toMatch(/^[0-9a-f]{32}$/);
      }
    }

    // The day count stays in the message. It does not move the fingerprint.
    const exposed = sarifB.runs[0]?.results.find((result) => result.properties?.advisoryId === 'GHSA-bbbb');
    const original = sarifA.runs[0]?.results.find((result) => result.properties?.advisoryId === 'GHSA-bbbb');
    expect(exposed?.message.text).toContain('(9d exposed)');
    expect(original?.message.text).not.toContain('exposed');
    expect(fingerprint(exposed!)).toBe(fingerprint(original!));

    const securityA = sarifA.runs[1]?.results.map(fingerprint).sort();
    const securityB = sarifB.runs[1]?.results.map(fingerprint).sort();
    expect(securityA).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(securityB).toEqual(securityA);
  });

  it('gives distinct fingerprints to distinct findings', async () => {
    const scanned = await scanVulnerabilities(
      [{ ecosystem: 'npm', package: 'lodash', version: '4.17.20' }],
      { sem: new Semaphore(1), offline: true, manifest: MANIFEST },
    );
    const findings = [...DRIFT, ...generateVulnerabilityFindings(scanned)];
    const sarif = formatSarif(artifact({
      timestamp: '2026-01-01T00:00:00.000Z',
      findings,
      security: SECURITY,
    })) as SarifDoc;

    const drift = sarif.runs[0]?.results ?? [];
    const byMessage = new Map(drift.map((result) => [result.message.text, fingerprint(result)]));
    const chalk = byMessage.get(DRIFT[1]!.message);
    const leftPad = byMessage.get(DRIFT[2]!.message);
    expect(chalk).toBeDefined();
    expect(leftPad).toBeDefined();
    expect(chalk).not.toBe(leftPad);
    expect(byMessage.get(DRIFT[0]!.message)).not.toBe(chalk);

    const ghsa = drift.find((result) => result.properties?.advisoryId === 'GHSA-bbbb');
    const cve = drift.find((result) => result.properties?.advisoryId === 'CVE-2024-1111');
    expect(ghsa?.message.text).toBe(
      'lodash@4.17.20: GHSA-bbbb (CVE-2024-1111) (critical 9.1) — fix available (4.17.21)',
    );
    // Documented in DOCS.md under SARIF result identity.
    expect(fingerprint(ghsa!)).toBe('dd5a118102af5cbdee3ada40cbaf3021');
    expect(fingerprint(ghsa!)).not.toBe(fingerprint(cve!));

    const all = sarif.runs.flatMap((run) => run.results.map(fingerprint));
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps the baseline suppression id on vg/finding-id/v1', () => {
    const finding = DRIFT[0]!;
    const id = baselineSuppressionId(finding.ruleId, finding.location);
    const suppressed = formatSarif(artifact({
      timestamp: '2026-01-01T00:00:00.000Z',
      findings: [finding, DRIFT[1]!],
      baselineId: { ruleId: finding.ruleId, location: finding.location, id },
    })) as SarifDoc;
    const again = formatSarif(artifact({
      timestamp: '2026-08-01T00:00:00.000Z',
      findings: [DRIFT[1]!, finding],
      baselineId: { ruleId: finding.ruleId, location: finding.location, id },
    })) as SarifDoc;

    const match = (doc: SarifDoc) => doc.runs[0]?.results.find((result) => result.ruleId === finding.ruleId);
    expect(match(suppressed)?.message.text).toBe(finding.message);
    expect(fingerprint(match(suppressed)!)).toBe(id);
    expect(match(suppressed)?.suppressions?.[0]?.properties?.id).toBe(id);
    expect(fingerprint(match(again)!)).toBe(id);

    const open = formatSarif(artifact({
      timestamp: '2026-01-01T00:00:00.000Z',
      findings: [finding],
    })) as SarifDoc;
    expect(fingerprint(open.runs[0]!.results[0]!)).not.toBe(id);
    expect(open.runs[0]!.results[0]?.suppressions).toBeUndefined();
  });
});
