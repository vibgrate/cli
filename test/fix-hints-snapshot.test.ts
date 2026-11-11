import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatText as formatScanText } from '../src/core-open/formatters/text.js';
import { formatText as formatReportText } from '../src/reporting/formatters/text.js';
import { fixAvailableHint } from '../src/core-open/formatters/fix-hint.js';
import type { ScanArtifact as CoreArtifact } from '../src/core-open/types.js';
import type { ScanArtifact as ReportArtifact } from '../src/reporting/types.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const artifact = JSON.parse(
  readFileSync(path.join(fixtureDir, 'fix-hints-snapshot-scan.json'), 'utf8'),
) as CoreArtifact & ReportArtifact;
const golden = readFileSync(path.join(fixtureDir, 'fix-hints-snapshot-scan.txt'), 'utf8').replace(
  /\n$/,
  '',
);

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

describe('fix available hints: golden text snapshots (vg scan / vg report)', () => {
  it('locks the Findings block for both formatters against the golden fixture', () => {
    const scan = findingsBlock(formatScanText(artifact));
    const report = findingsBlock(formatReportText(artifact));
    expect(scan).toBe(golden);
    expect(report).toBe(golden);
  });

  it('renders deterministically: two consecutive runs produce identical output', () => {
    const scanA = findingsBlock(formatScanText(artifact));
    const reportA = findingsBlock(formatReportText(artifact));
    const scanB = findingsBlock(formatScanText(artifact));
    const reportB = findingsBlock(formatReportText(artifact));
    expect(scanA).toBe(scanB);
    expect(reportA).toBe(reportB);
  });

  it('covers a finding with exactly one fix version', () => {
    const scan = findingsBlock(formatScanText(artifact));
    expect(scan).toContain('fix available (4.17.21)');
  });

  it('covers a finding with several fix versions that all fit', () => {
    const scan = findingsBlock(formatScanText(artifact));
    expect(scan).toContain('fix available (1.2.6, 1.2.7, 1.3.0)');
  });

  it('lists many fix versions in stable input order with no stray ellipsis', () => {
    const scan = findingsBlock(formatScanText(artifact));
    expect(scan).toContain(
      'fix available (0.21.2, 0.21.3, 0.21.4, 0.22.0, 0.23.0, 0.24.0, 0.25.0, 0.26.0, 0.27.0, 0.27.1, 0.27.2, 0.28.0)',
    );
    // Every version was shown, so no cut marker may appear.
    expect(scan).not.toMatch(/, \.\.\.\)/);
    expect(scan).not.toMatch(/\.\.\. and \d+ more/);
  });

  it('never prints a hint or a no-fix claim when fix metadata is absent or blank', () => {
    const scan = findingsBlock(formatScanText(artifact));
    const report = findingsBlock(formatReportText(artifact));
    // left-pad ([]) and debug (["", "  "]) must not get a hint line or a claim.
    expect(scan).not.toContain('left-pad@1.0.0: GHSA-none (low 3.1) — no fix');
    expect(scan).not.toContain('debug@4.3.0: GHSA-blank (low 2.1) — no fix');
    expect(scan).not.toMatch(/no fix available/i);
    expect(report).not.toMatch(/no fix available/i);
  });

  it('does not duplicate a hint already present in the finding message', () => {
    const scan = findingsBlock(formatScanText(artifact));
    // qs already carries "fix available (6.5.3)" in its message; the formatter
    // must not append a second hint line for it.
    expect(scan.match(/qs@6\.5\.0/g)).toHaveLength(1);
    expect(scan.match(/fix available \(6\.5\.3\)/g)).toHaveLength(1);
  });

  it('fixAvailableHint keeps version order stable and drops duplicates and blanks', () => {
    expect(fixAvailableHint(['2.0.0', '1.0.0', '2.0.0', '', '1.1.0'])).toBe(
      'fix available (2.0.0, 1.0.0, 1.1.0)',
    );
    expect(fixAvailableHint([])).toBe('');
    expect(fixAvailableHint(['', '  '])).toBe('');
    expect(fixAvailableHint(undefined)).toBe('');
    expect(fixAvailableHint('not-an-array')).toBe('');
  });
});
