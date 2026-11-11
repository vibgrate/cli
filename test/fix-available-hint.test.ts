import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateVulnerabilityFindings } from '../src/core-open/scanners/vulnerability-scanner.js';
import { formatText as formatScanText } from '../src/core-open/formatters/text.js';
import { formatText as formatReportText } from '../src/reporting/formatters/text.js';
import type { ScanArtifact as CoreArtifact, VulnerabilityScanResult } from '../src/core-open/types.js';
import type { ScanArtifact as ReportArtifact } from '../src/reporting/types.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const artifact = JSON.parse(
  readFileSync(path.join(fixtureDir, 'fix-available-scan.json'), 'utf8'),
) as CoreArtifact & ReportArtifact;
const expectedFindings = readFileSync(path.join(fixtureDir, 'fix-available-scan.txt'), 'utf8')
  .replace(/\r/g, '')
  .replace(/\n$/, '');

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function findingsBlock(text: string): string {
  const lines = stripAnsi(text).split('\n');
  const start = lines.findIndex((line) => line.includes('Findings'));
  expect(start).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i] === '') break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('fix available hints in default scan and report text', () => {
  it('matches the deterministic fixture for both formatters', () => {
    const scan = findingsBlock(formatScanText(artifact));
    const report = findingsBlock(formatReportText(artifact));
    expect(scan).toBe(expectedFindings);
    expect(report).toBe(expectedFindings);
    expect(scan).toBe(findingsBlock(formatScanText(artifact)));
    expect(report).toBe(findingsBlock(formatReportText(artifact)));
  });

  it('never prints a no-fix claim when fix metadata is absent', () => {
    const scan = findingsBlock(formatScanText(artifact));
    const report = findingsBlock(formatReportText(artifact));
    expect(scan).not.toMatch(/no fix/i);
    expect(report).not.toMatch(/no fix/i);
    expect(scan).not.toContain('fix available ()');
    expect(report).not.toContain('fix available ()');
  });

  it('writes the hint into new findings only when versions are present', () => {
    const vulns = artifact.extended?.vulnerabilities as VulnerabilityScanResult;
    const once = generateVulnerabilityFindings(vulns);
    const twice = generateVulnerabilityFindings(vulns);
    expect(once).toEqual(twice);
    expect(once.map((f) => f.message)).toEqual([
      'lodash@4.17.20: GHSA-a (CVE-2021-1) (critical 9.8) — fix available (4.17.21)',
      'left-pad@1.0.0: GHSA-b (moderate 5.6)',
      'minimist@1.2.0: GHSA-c (high 7.5) — fix available (1.2.6, 1.2.7)',
      'debug@4.3.0: GHSA-d (low 3.1)',
    ]);
    for (const finding of once) expect(finding.message).not.toMatch(/no fix/i);
  });
});
