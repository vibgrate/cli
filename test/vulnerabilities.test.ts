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
        { id: 'GHSA-crit', aliases: ['CVE-2021-1'], summary: 'bad', severity: 'critical', cvss: 9.8, cvssVector: null, fixedVersions: ['4.17.21'], published: null, withdrawn: null, references: [] },
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
const stubGraph = {} as VgGraph;

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
  });

  it('filters by minimum severity', () => {
    const onlyCritical = filterBySeverity(VULNS, 'high');
    expect(onlyCritical.packages).toHaveLength(1);
    expect(onlyCritical.packages[0].package).toBe('lodash');
    expect(onlyCritical.totalAdvisories).toBe(1);
  });
});
