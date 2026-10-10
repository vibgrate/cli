import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { formatText } from '../src/core-open/formatters/text.js';
import {
  compareScanFindings,
  findingsForTerminal,
  orderArtifactFindings,
  sortScanFindings,
} from '../src/core-open/findings-order.js';
import { runCoreScan } from '../src/core-open/index.js';
import type { Finding, ScanArtifact, SecurityFinding } from '../src/core-open/types.js';

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

function artifact(findings: Finding[], extra: Partial<ScanArtifact> = {}): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    vibgrateVersion: 'test',
    rootPath: 'fixture',
    projects: [],
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings,
    ...extra,
  };
}

describe('scan findings order', () => {
  it('sorts drift findings by rule, location, message, then advisory, package, and purl', () => {
    const rows: Finding[] = [
      { ruleId: 'vibgrate/runtime-eol', level: 'error', message: 'runtime', location: 'z-app' },
      { ruleId: 'vibgrate/license-parse-failed', level: 'warning', message: 'lic-z', location: 'z-app/package.json' },
      { ruleId: 'vibgrate/license-parse-failed', level: 'warning', message: 'lic-a', location: 'a-app/package.json' },
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'note',
        message: 'same',
        location: 'left-pad',
        details: { advisoryId: 'GHSA-b', package: 'left-pad', purl: 'pkg:npm/left-pad@1' },
      },
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'error',
        message: 'same',
        location: 'left-pad',
        details: { advisoryId: 'GHSA-a', package: 'left-pad', purl: 'pkg:npm/left-pad@1' },
      },
    ];
    const sorted = sortScanFindings(rows);
    expect(sorted.map((finding) => finding.ruleId)).toEqual([
      'vibgrate/license-parse-failed',
      'vibgrate/license-parse-failed',
      'vibgrate/runtime-eol',
      'vibgrate/vulnerability',
      'vibgrate/vulnerability',
    ]);
    expect(sorted.map((finding) => finding.location)).toEqual([
      'a-app/package.json',
      'z-app/package.json',
      'z-app',
      'left-pad',
      'left-pad',
    ]);
    expect(sorted[3]?.details?.advisoryId).toBe('GHSA-a');
    expect(sorted[4]?.details?.advisoryId).toBe('GHSA-b');
    expect(rows.map((finding) => finding.ruleId)[0]).toBe('vibgrate/runtime-eol');
    for (let i = 1; i < sorted.length; i++) {
      expect(compareScanFindings(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
    }
  });

  it('sorts alias lists without treating fixed versions as a set', () => {
    const [sorted] = sortScanFindings([
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'warning',
        message: 'advisory',
        location: 'left-pad',
        details: { aliases: ['OSV-9', 'CVE-2020-1'], fixedVersions: ['1.10.0', '1.9.0'] },
      },
    ]);
    expect(sorted?.details?.aliases).toEqual(['CVE-2020-1', 'OSV-9']);
    expect(sorted?.details?.fixedVersions).toEqual(['1.10.0', '1.9.0']);
  });

  it('sorts security and reachability findings and their id lists', () => {
    const security: SecurityFinding[] = [
      {
        id: 'b'.repeat(32),
        pack: 'iac-cis-v1',
        packVersion: '1',
        rule: 'aws-s3-public',
        severity: 'high',
        message: 'later path',
        path: 'z.tf',
        owasp: ['A05', 'A01'],
        cwe: ['CWE-732', 'CWE-200'],
      },
      {
        id: 'a'.repeat(32),
        pack: 'iac-cis-v1',
        packVersion: '1',
        rule: 'aws-s3-public',
        severity: 'low',
        message: 'earlier path',
        path: 'a.tf',
        line: 4,
      },
    ];
    const ordered = orderArtifactFindings(artifact([], {
      extended: {
        security: {
          schema: 'vg.security.v1',
          engine: 'test',
          packs: { 'iac-cis-v1': '1' },
          facts: { received: 2, evaluated: 2, rejected: 0 },
          findings: security,
        },
      },
      reachability: {
        analyzerVersion: 'vg-reach-1.0',
        source: 'graph',
        generatedAt: '2026-01-01T00:00:00.000Z',
        manifestAdvisoryCount: 2,
        findings: [
          { advisoryId: 'GHSA-b', ecosystem: 'npm', package: 'ms', version: '2.0.0', tier: 'unknown', graphConfidence: 0 },
          { advisoryId: 'GHSA-a', ecosystem: 'npm', package: 'left-pad', version: '1.0.0', tier: 'not_reached', graphConfidence: 0.5 },
        ],
      },
    }));
    expect(ordered.extended?.security?.findings.map((finding) => finding.path)).toEqual(['a.tf', 'z.tf']);
    expect(ordered.extended?.security?.findings[1]?.owasp).toEqual(['A01', 'A05']);
    expect(ordered.extended?.security?.findings[1]?.cwe).toEqual(['CWE-200', 'CWE-732']);
    expect(ordered.reachability?.findings.map((finding) => finding.package)).toEqual(['left-pad', 'ms']);
  });

  it('prints errors before warnings in the text report', () => {
    const findings: Finding[] = [
      { ruleId: 'vibgrate/aaa-warning', level: 'warning', message: 'warn-row-alpha', location: 'a' },
      { ruleId: 'vibgrate/zzz-error', level: 'error', message: 'error-row-zeta', location: 'z' },
    ];
    expect(findingsForTerminal(findings).map((finding) => finding.level)).toEqual(['error', 'warning']);
    const text = stripAnsi(formatText(artifact(findings)));
    expect(text.indexOf('error-row-zeta')).toBeGreaterThan(-1);
    expect(text.indexOf('error-row-zeta')).toBeLessThan(text.indexOf('warn-row-alpha'));
  });
});

describe('offline scan findings order', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-findings-order-'));
    // Created in the reverse of path order so a walk that keeps creation
    // order would emit z-app before a-app.
    for (const name of ['z-app', 'a-app']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          engines: { node: '18.0.0' },
          dependencies: { 'left-pad': '1.0.0' },
        }),
      );
    }
    fs.writeFileSync(
      path.join(root, 'package-versions.json'),
      JSON.stringify({
        npm: {
          'left-pad': {
            latest: '1.0.0',
            versions: ['1.0.0'],
            license: 'Not-A-Real-License',
            vulns: [
              {
                id: 'GHSA-order',
                aliases: ['OSV-9', 'CVE-2020-1'],
                severity: 'low',
                ranges: [{ introduced: '0', fixed: '9.9.9' }],
              },
            ],
          },
        },
        runtimes: {
          generatedAt: '2020-01-01',
          source: 'endoflife.date',
          products: {
            nodejs: {
              product: 'nodejs',
              cycles: [
                { cycle: '18', releaseDate: '2019-01-01', lts: true, eol: '2000-01-01' },
                { cycle: '22', releaseDate: '2019-01-01', lts: true, eol: '2099-01-01' },
              ],
            },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function identity(findings: Finding[]) {
    return findings.map((finding) => ({
      ruleId: finding.ruleId,
      level: finding.level,
      location: finding.location,
      message: finding.message,
      advisoryId: typeof finding.details?.advisoryId === 'string' ? finding.details.advisoryId : undefined,
      aliases: Array.isArray(finding.details?.aliases) ? finding.details.aliases : undefined,
    }));
  }

  it('writes the same findings order on two offline scans of one fixture', async () => {
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
    const firstOut = path.join(root, 'first.json');
    const secondOut = path.join(root, 'second.json');
    const first = await runCoreScan(root, { ...opts, out: firstOut });
    const second = await runCoreScan(root, { ...opts, out: secondOut });

    const firstFindings = identity(first.findings);
    const secondFindings = identity(second.findings);
    expect(secondFindings).toEqual(firstFindings);
    expect(JSON.stringify(first.findings)).toBe(JSON.stringify(second.findings));

    const written = JSON.parse(fs.readFileSync(firstOut, 'utf8')) as { findings: Finding[] };
    expect(identity(written.findings)).toEqual(firstFindings);

    expect(firstFindings.map((finding) => `${finding.ruleId} ${finding.location}`)).toEqual([
      'vibgrate/license-parse-failed a-app/package.json',
      'vibgrate/license-parse-failed z-app/package.json',
      'vibgrate/runtime-eol a-app',
      'vibgrate/runtime-eol z-app',
      'vibgrate/vulnerability left-pad',
    ]);
    const vuln = first.findings.find((finding) => finding.ruleId === 'vibgrate/vulnerability');
    expect(vuln?.details?.aliases).toEqual(['CVE-2020-1', 'OSV-9']);
    expect(vuln?.details?.advisoryId).toBe('GHSA-order');

    const sarif = formatSarif(first) as { runs: Array<{ results: Array<{ ruleId: string }> }> };
    expect(sarif.runs[0]?.results.map((result) => result.ruleId)).toEqual(first.findings.map((finding) => finding.ruleId));

    for (const finding of first.findings) {
      expect(JSON.stringify(finding)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });
});
