import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { loadVulnerabilities, filterBySeverity } from '../src/mcp/vuln-data.js';
import { TOOLS } from '../src/mcp/tools.js';
import type { VgGraph } from '../src/schema.js';
import type { VulnerabilityScanResult } from '../src/core-open/index.js';

const VULNS: VulnerabilityScanResult = {
  source: 'osv',
  totalAdvisories: 2,
  severityCounts: { low: 0, moderate: 1, high: 0, critical: 1, unknown: 0 },
  packages: [
    {
      ecosystem: 'npm',
      package: 'lodash',
      version: '4.17.20',
      advisories: [
        { id: 'GHSA-crit', aliases: ['CVE-2021-1'], summary: 'bad', severity: 'critical', cvss: 9.8, cvssVector: null, fixedVersions: ['4.17.21'], published: null, withdrawn: null, references: [], epss: 0.42, epssPercentile: 0.91, kev: true },
      ],
    },
    {
      ecosystem: 'npm',
      package: 'minimist',
      version: '1.2.0',
      advisories: [
        { id: 'GHSA-mod', aliases: [], summary: null, severity: 'moderate', cvss: 5.3, cvssVector: null, fixedVersions: ['1.2.6'], published: null, withdrawn: null, references: [] },
      ],
    },
  ],
};

function writeArtifact(root: string, vulnerabilities?: VulnerabilityScanResult): void {
  fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.vibgrate', 'scan_result.json'),
    JSON.stringify({ schemaVersion: '1.0', extended: vulnerabilities ? { vulnerabilities } : {} }),
  );
}

const listVulns = TOOLS.find((t) => t.name === 'list_vulnerabilities')!;
const vulnAttribution = TOOLS.find((t) => t.name === 'vuln_attribution')!;
const stubGraph = {} as VgGraph;

const PARSE_FAILED = {
  code: 'cvss-vector-parse-failed' as const,
  warnCode: 'VG_WARN_CVSS_UNPARSEABLE' as const,
  message:
    'CVSS vector failed to parse (cvss-vector-parse-failed): "not-a-vector" is not a CVSS:3.0 or CVSS:3.1 base vector. Replace it with a CVSS:3.0 or CVSS:3.1 base vector, or omit the vector and supply a numeric base score.',
};

describe('vuln-data + list_vulnerabilities MCP tool', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-vulns-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns not_scanned when no artifact exists', () => {
    expect(loadVulnerabilities(dir)).toBeNull();
    const res = listVulns.handler(stubGraph, {}, { root: dir }) as { status: string };
    expect(res.status).toBe('not_scanned');
  });

  it('reads vulnerabilities from the local scan artifact', () => {
    writeArtifact(dir, VULNS);
    const res = listVulns.handler(stubGraph, {}, { root: dir }) as {
      status: string;
      totalAdvisories: number;
      affectedPackages: number;
      packages: Array<{ package: string; advisories: Array<{ cve: string | null }> }>;
    };
    expect(res.status).toBe('ok');
    expect(res.totalAdvisories).toBe(2);
    expect(res.affectedPackages).toBe(2);
    expect(res.packages.find((p) => p.package === 'lodash')?.advisories[0].cve).toBe('CVE-2021-1');
    const lodash = res.packages.find((p) => p.package === 'lodash')?.advisories[0] as Record<string, unknown>;
    expect(lodash).toMatchObject({ epss: 0.42, epssPercentile: 0.91, kev: true });
    const minimist = res.packages.find((p) => p.package === 'minimist')?.advisories[0] as Record<string, unknown>;
    expect(minimist).not.toHaveProperty('epss');
    expect(minimist).not.toHaveProperty('kev');
  });

  it('filters by minimum severity', () => {
    const onlyCritical = filterBySeverity(VULNS, 'high');
    expect(onlyCritical.packages).toHaveLength(1);
    expect(onlyCritical.packages[0].package).toBe('lodash');
    expect(onlyCritical.totalAdvisories).toBe(1);
  });

  it('keeps a parsed score, a missing score, and a failed vector distinct', () => {
    const mixed: VulnerabilityScanResult = {
      source: 'osv',
      totalAdvisories: 3,
      severityCounts: { low: 0, moderate: 0, high: 0, critical: 1, unknown: 2 },
      packages: [
        {
          ecosystem: 'npm',
          package: 'left-pad',
          version: '1.0.0',
          advisories: [
            {
              id: 'GHSA-ok',
              aliases: [],
              summary: null,
              severity: 'critical',
              cvss: 9.8,
              cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
              fixedVersions: [],
              published: null,
              withdrawn: null,
              references: [],
            },
            {
              id: 'GHSA-none',
              aliases: [],
              summary: null,
              severity: 'unknown',
              cvss: null,
              cvssVector: null,
              fixedVersions: [],
              published: null,
              withdrawn: null,
              references: [],
            },
            {
              id: 'GHSA-bad',
              aliases: [],
              summary: null,
              severity: 'unknown',
              cvss: null,
              cvssVector: 'not-a-vector',
              cvssDiagnostic: PARSE_FAILED,
              fixedVersions: [],
              published: null,
              withdrawn: null,
              references: [],
            },
          ],
        },
      ],
    };
    writeArtifact(dir, mixed);
    const listed = listVulns.handler(stubGraph, {}, { root: dir }) as {
      packages: Array<{ advisories: Array<{ id: string; cvss: number | null; cvssDiagnostic?: { code: string; message: string } }> }>;
    };
    const advisories = listed.packages[0].advisories;
    const ok = advisories.find((a) => a.id === 'GHSA-ok')!;
    const none = advisories.find((a) => a.id === 'GHSA-none')!;
    const bad = advisories.find((a) => a.id === 'GHSA-bad')!;
    expect(ok.cvss).toBe(9.8);
    expect(ok.cvssDiagnostic).toBeUndefined();
    expect(none.cvss).toBeNull();
    expect(none.cvssDiagnostic).toBeUndefined();
    expect(bad.cvss).toBeNull();
    expect(bad.cvssDiagnostic).toEqual(PARSE_FAILED);

    const attributed = vulnAttribution.handler(stubGraph, {}, { root: dir }) as {
      packages: Array<{ advisories: Array<{ id: string; cvss: number | null; cvssDiagnostic?: { code: string } }> }>;
    };
    const attrBad = attributed.packages[0].advisories.find((a) => a.id === 'GHSA-bad')!;
    const attrNone = attributed.packages[0].advisories.find((a) => a.id === 'GHSA-none')!;
    expect(attrBad.cvssDiagnostic?.code).toBe('cvss-vector-parse-failed');
    expect(attrNone.cvssDiagnostic).toBeUndefined();
    expect(attrNone.cvss).toBeNull();
  });
});
