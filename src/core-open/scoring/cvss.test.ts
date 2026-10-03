import { describe, expect, it } from 'vitest';
import {
  CVSS_VECTOR_RULE_ID,
  generateVulnerabilityFindings,
  parseOsvAdvisory,
  type VulnerabilityScanResult,
} from '../index.js';
import { manifestAdvisoryToAdvisory } from '../scanners/vulnerability-scanner.js';
import { cvssV3BaseScore, parseCvssV3 } from './cvss.js';

const VALID = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const NONE_IMPACT = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';
const BAD = 'CVSS:3.1/AV:NOPE';
const FILE_MARKER = 'UNRELATED_FILE_MARKER';
const FILE_SECRET = 'ghp_shouldNotAppear';
const FILE_BLOB = ['# advisory dump', FILE_MARKER, `token=${FILE_SECRET}`, 'more unrelated text'].join('\n');

function scanOf(advisory: ReturnType<typeof parseOsvAdvisory>): VulnerabilityScanResult {
  return {
    source: 'osv',
    packages: [{ ecosystem: 'npm', package: 'left-pad', version: '1.0.0', advisories: [advisory] }],
    totalAdvisories: 1,
    severityCounts: { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 },
  };
}

describe('parseCvssV3', () => {
  it('reports an unparseable vector as a diagnostic, not a missing or zero score', () => {
    const parsed = parseCvssV3(BAD);
    expect(parsed.score).toBeNull();
    expect(parsed.score).not.toBe(0);
    expect(parsed.diagnostic).toBe(parseCvssV3(BAD).diagnostic);
    expect(parsed.diagnostic).toMatch(/could not be parsed/);
    expect(parsed.diagnostic).toMatch(/No base score was derived/);
    expect(parsed.diagnostic).toMatch(/Replace the vector/);
    expect(parsed.diagnostic).toMatch(/qualitative severity/);
    expect(parsed.diagnostic).not.toContain('NOPE');
    expect(parsed.diagnostic).not.toContain(FILE_MARKER);

    const fromFile = parseCvssV3(FILE_BLOB);
    expect(fromFile.score).toBeNull();
    expect(fromFile.score).not.toBe(0);
    expect(fromFile.diagnostic).toMatch(/could not be parsed/);
    expect(fromFile.diagnostic).not.toContain(FILE_MARKER);
    expect(fromFile.diagnostic).not.toContain(FILE_SECRET);
    expect(fromFile.diagnostic).not.toContain('advisory dump');
  });

  it('leaves a genuinely absent score absent', () => {
    for (const absent of [null, undefined, '', '   ']) {
      expect(parseCvssV3(absent)).toEqual({ score: null });
      expect(cvssV3BaseScore(absent)).toBeNull();
    }
  });

  it('parses a valid vector to the same base score as before', () => {
    expect(parseCvssV3(VALID)).toEqual({ score: 9.8 });
    expect(cvssV3BaseScore(VALID)).toBe(9.8);
    expect(parseCvssV3(`  ${VALID}  `)).toEqual({ score: 9.8 });
    expect(parseCvssV3(VALID.toLowerCase())).toEqual({ score: 9.8 });
    expect(parseCvssV3(`${VALID}/E:P`)).toEqual({ score: 9.8 });
    expect(parseCvssV3('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N')).toEqual({ score: 7.5 });
    // A real zero (every impact metric None) is a score, not a parse failure.
    expect(parseCvssV3(NONE_IMPACT)).toEqual({ score: 0 });
    expect(cvssV3BaseScore(NONE_IMPACT)).toBe(0);
  });
});

describe('advisory CVSS vectors', () => {
  it('surfaces a bad vector on the advisory and as a warning finding', () => {
    const advisory = parseOsvAdvisory(
      {
        id: 'GHSA-bad',
        summary: 'broken vector',
        severity: [{ type: 'CVSS_V3', score: BAD }],
        affected: [{ package: { ecosystem: 'npm', name: 'left-pad' } }],
      },
      'left-pad',
    );
    expect(advisory.cvss).toBeNull();
    expect(advisory.cvss).not.toBe(0);
    expect(advisory.cvssVector).toBe(BAD);
    expect(advisory.cvssDiagnostic).toMatch(/could not be parsed/);
    expect(advisory.cvssDiagnostic).not.toContain('NOPE');

    const findings = generateVulnerabilityFindings(scanOf(advisory));
    const warning = findings.find((f) => f.ruleId === CVSS_VECTOR_RULE_ID);
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toMatch(/GHSA-bad/);
    expect(warning?.message).toMatch(/could not be parsed/);
    expect(warning?.message).toMatch(/Replace the vector/);
    expect(warning?.message).not.toContain('NOPE');
    expect(warning?.details?.cvss).toBeUndefined();
    expect(findings.find((f) => f.ruleId !== CVSS_VECTOR_RULE_ID)?.details?.cvss).toBeNull();

    const dumped = parseOsvAdvisory(
      {
        id: 'GHSA-dump',
        severity: [{ type: 'CVSS_V3', score: FILE_BLOB }],
        affected: [{ package: { name: 'left-pad' } }],
      },
      'left-pad',
    );
    expect(dumped.cvss).toBeNull();
    expect(dumped.cvssVector).toBeNull();
    expect(dumped.cvssDiagnostic).not.toContain(FILE_MARKER);
    expect(dumped.cvssDiagnostic).not.toContain(FILE_SECRET);
    const dumpFindings = generateVulnerabilityFindings(scanOf(dumped));
    expect(dumpFindings.map((f) => f.message).join('\n')).not.toContain(FILE_MARKER);
    expect(dumpFindings.map((f) => f.message).join('\n')).not.toContain(FILE_SECRET);
    expect(JSON.stringify(dumpFindings)).not.toContain(FILE_MARKER);
  });

  it('keeps an advisory with no vector unscored and unwarned', () => {
    const advisory = parseOsvAdvisory(
      {
        id: 'GHSA-none',
        affected: [{ package: { name: 'left-pad' }, database_specific: { severity: 'HIGH' } }],
      },
      'left-pad',
    );
    expect(advisory.cvss).toBeNull();
    expect(advisory.cvssDiagnostic).toBeUndefined();
    expect(advisory.cvssVector).toBeNull();
    expect(advisory.severity).toBe('high');
    const findings = generateVulnerabilityFindings(scanOf(advisory));
    expect(findings.map((f) => f.ruleId)).toEqual(['vibgrate/vulnerability']);
    expect(findings[0]?.message).not.toMatch(/could not be parsed/);
    expect(findings[0]?.details?.cvss).toBeNull();
  });

  it('keeps a valid vector on the advisory and does not warn', () => {
    const advisory = parseOsvAdvisory(
      {
        id: 'GHSA-ok',
        severity: [{ type: 'CVSS_V3', score: VALID }],
        database_specific: { severity: 'LOW' },
        affected: [{ package: { name: 'left-pad' } }],
      },
      'left-pad',
    );
    expect(advisory.cvss).toBe(9.8);
    expect(advisory.cvssVector).toBe(VALID);
    expect(advisory.cvssDiagnostic).toBeUndefined();
    expect(advisory.severity).toBe('critical');
    const findings = generateVulnerabilityFindings(scanOf(advisory));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('critical 9.8');
    expect(findings[0]?.details?.cvss).toBe(9.8);
  });

  it('warns for a non-v3 severity vector instead of dropping it', () => {
    const advisory = parseOsvAdvisory(
      {
        id: 'GHSA-v4',
        severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }],
        affected: [{ package: { name: 'left-pad' } }],
      },
      'left-pad',
    );
    expect(advisory.cvss).toBeNull();
    expect(advisory.cvss).not.toBe(0);
    expect(advisory.cvssDiagnostic).toMatch(/does not start with CVSS:3.0 or CVSS:3.1/);
    expect(advisory.cvssDiagnostic).not.toContain('CVSS:4.0');
  });

  it('reads the same three cases from a package manifest', () => {
    const bad = manifestAdvisoryToAdvisory({ id: 'M-bad', cvssVector: BAD });
    expect(bad.cvss).toBeNull();
    expect(bad.cvssDiagnostic).toMatch(/could not be parsed/);
    expect(bad.severity).toBe('unknown');

    const missing = manifestAdvisoryToAdvisory({ id: 'M-none' });
    expect(missing.cvss).toBeNull();
    expect(missing.cvssDiagnostic).toBeUndefined();

    const valid = manifestAdvisoryToAdvisory({ id: 'M-ok', cvssVector: VALID });
    expect(valid.cvss).toBe(9.8);
    expect(valid.cvssDiagnostic).toBeUndefined();
    expect(valid.severity).toBe('critical');

    const zero = manifestAdvisoryToAdvisory({ id: 'M-zero', cvssVector: NONE_IMPACT });
    expect(zero.cvss).toBe(0);
    expect(zero.cvssDiagnostic).toBeUndefined();
  });
});
