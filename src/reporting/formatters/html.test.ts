import { describe, expect, it } from 'vitest';
import type { SecurityFinding } from '../../core-open/types.js';
import type { ScanArtifact } from '../types.js';
import { ADVISORY_CORPUS_FOOTER_ID, FIX_AVAILABLE_ATTR, formatHtmlReport } from './html.js';

const TOKEN = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyzA'].join('_');

function artifact(overrides: Partial<ScanArtifact> = {}): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-16T00:00:00.000Z',
    vibgrateVersion: '0.0.0',
    rootPath: '/work',
    projects: [],
    findings: [],
    drift: {
      score: null,
      riskLevel: null,
      components: {
        runtimeScore: null,
        frameworkScore: null,
        dependencyScore: null,
        eolScore: null,
      },
    },
    ...overrides,
  };
}

function security(overrides: Partial<SecurityFinding> & Pick<SecurityFinding, 'id' | 'path' | 'severity' | 'message'>): SecurityFinding {
  return {
    pack: 'iac-cis-v1',
    packVersion: '1',
    rule: 'rule',
    ...overrides,
  };
}

function block(html: string, id: string): string {
  const match = new RegExp(`<(p|ul|dd) id="${id}"[\\s\\S]*?</\\1>`).exec(html);
  if (!match) throw new Error(`missing #${id}`);
  return match[0];
}

function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}">`);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

function sample(): ScanArtifact {
  return artifact({
    drift: {
      score: null,
      riskLevel: null,
      components: {
        runtimeScore: 0,
        frameworkScore: null,
        dependencyScore: null,
        eolScore: null,
      },
    },
    findings: [
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'note',
        message: `low row token ${TOKEN}`,
        location: 'left-pad',
        details: {
          severity: 'low',
          package: 'left-pad',
          advisoryId: 'GHSA-low',
          cvss: 0,
        },
      },
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'error',
        message: `<script>alert("x") & 'y'</script>`,
        location: 'left-pad',
        details: { package: 'left-pad', advisoryId: 'GHSA-miss' },
      },
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'error',
        message: 'critical row',
        location: 'left-pad',
        details: { severity: 'CRITICAL', package: 'left-pad', advisoryId: 'GHSA-crit', cvss: null },
      },
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'warning',
        message: 'moderate row',
        location: 'left-pad',
        details: {
          severity: 'moderate',
          package: 'left-pad',
          advisoryId: 'GHSA-mod',
          fixedVersions: ['4.17.21'],
        },
      },
      {
        ruleId: 'vibgrate/vulnerability',
        level: 'error',
        message: 'high row',
        location: 'left-pad',
        details: { severity: 'high', package: 'left-pad', advisoryId: 'GHSA-high', cvss: null, fixedVersions: [] },
      },
      {
        ruleId: 'vibgrate/runtime-lag',
        level: 'warning',
        message: 'runtime is behind',
        location: 'package.json',
        details: { fixedVersions: ['9.9.9'] },
      },
    ],
    extended: {
      security: {
        schema: 'vg.security.v1',
        engine: 'engine/1',
        packs: { 'iac-cis-v1': '1' },
        facts: { received: 2, evaluated: 2, rejected: 0 },
        findings: [
          security({
            id: 'b'.repeat(32),
            path: 'b.tf',
            line: 2,
            severity: 'low',
            rule: 'second',
            message: 'later path',
          }),
          security({
            id: 'a'.repeat(32),
            path: 'a.tf',
            line: 1,
            severity: 'critical',
            rule: 'first',
            message: `says <b> & "quoted"`,
          }),
        ],
      },
    },
  });
}

describe('formatHtmlReport', () => {
  it('renders a summary with severity counts, an absent score, a fix rollup, and section anchors', () => {
    const html = formatHtmlReport(sample());

    expect(block(html, 'drift-score')).toBe('<dd id="drift-score">n/a</dd>');
    expect(block(html, 'risk-level')).toBe('<dd id="risk-level">n/a</dd>');
    expect(block(html, 'score-runtime')).toBe('<dd id="score-runtime">0</dd>');
    expect(block(html, 'score-framework')).toBe('<dd id="score-framework">n/a</dd>');
    expect(html).not.toContain('id="drift-score">0');

    const vulns = block(html, 'vuln-counts');
    expect(vulns).toContain('data-evaluated="yes"');
    expect(vulns).toContain('data-severity="critical">critical 1');
    expect(vulns).toContain('data-severity="high">high 1');
    expect(vulns).toContain('data-severity="moderate">moderate 1');
    expect(vulns).toContain('data-severity="low">low 1');
    expect(vulns).toContain('data-severity="unknown">unknown 0');
    expect(vulns).toContain('data-severity="unspecified">unspecified 1');

    const securityCounts = block(html, 'security-counts');
    expect(securityCounts).toContain('data-severity="critical">critical 1');
    expect(securityCounts).toContain('data-severity="high">high 0');
    expect(securityCounts).toContain('data-severity="medium">medium 0');
    expect(securityCounts).toContain('data-severity="low">low 1');
    expect(securityCounts).toContain('data-severity="info">info 0');

    expect(block(html, 'fix-available')).toBe('<p id="fix-available">Fix available: 2</p>');

    expect(html).toContain('href="#vulnerabilities"');
    expect(html).toContain('href="#security"');
    expect(html).toContain('href="#findings"');
    expect(html).toContain('id="summary"');
    expect(html).toContain('id="vulnerabilities"');
    expect(html).toContain('id="security"');
    expect(html).toContain('id="findings"');
  });

  it('keeps the full finding tables, in stable order, under the summary', () => {
    const html = formatHtmlReport(sample());
    const vulns = section(html, 'vulnerabilities');
    const securitySection = section(html, 'security');
    const findings = section(html, 'findings');

    const crit = vulns.indexOf('GHSA-crit');
    const high = vulns.indexOf('GHSA-high');
    const mod = vulns.indexOf('GHSA-mod');
    const low = vulns.indexOf('GHSA-low');
    const miss = vulns.indexOf('GHSA-miss');
    expect(crit).toBeGreaterThan(-1);
    expect(crit).toBeLessThan(high);
    expect(high).toBeLessThan(mod);
    expect(mod).toBeLessThan(low);
    expect(low).toBeLessThan(miss);

    expect(vulns).toContain('<td>critical</td><td>GHSA-crit</td><td>left-pad</td><td>n/a</td>');
    expect(vulns).toContain('<td>low</td><td>GHSA-low</td><td>left-pad</td><td>0</td>');
    expect(vulns).toContain('fix available (4.17.21)');
    expect(vulns).toContain(`${FIX_AVAILABLE_ATTR}="yes"`);
    expect(vulns).toContain(`${FIX_AVAILABLE_ATTR}="no"`);

    expect(securitySection.indexOf('a.tf:1')).toBeLessThan(securitySection.indexOf('b.tf:2'));
    expect(securitySection).toContain('iac-cis-v1/first');
    expect(findings).toContain('vibgrate/runtime-lag');
    expect(html).not.toContain('engine/1');
    expect(findings).not.toContain('GHSA-crit');
    expect(html.indexOf('id="summary"')).toBeLessThan(html.indexOf('id="vulnerabilities"'));
  });

  it('escapes markup and redacts credential-shaped text', () => {
    const html = formatHtmlReport(sample());
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
    expect(html).toContain('says &lt;b&gt; &amp; &quot;quoted&quot;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('[REDACTED]');
  });

  it('does not invent a zero for a score or a check that did not run', () => {
    const html = formatHtmlReport(artifact());
    expect(block(html, 'drift-score')).toBe('<dd id="drift-score">n/a</dd>');
    expect(block(html, 'vuln-counts')).toContain('Not scanned');
    expect(block(html, 'vuln-counts')).not.toContain('critical');
    expect(block(html, 'security-counts')).toContain('Not scanned');
    expect(html).not.toContain('id="fix-available"');
    expect(section(html, 'vulnerabilities')).toContain('Not scanned');
    expect(section(html, 'security')).toContain('Not scanned');
    expect(section(html, 'findings')).toContain('None');
  });

  it('renders real zeros when a vulnerability check finished with nothing to report', () => {
    const html = formatHtmlReport(artifact({
      extended: {
        vulnerabilities: {
          source: 'none',
          packages: [],
          totalAdvisories: 0,
          severityCounts: { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 },
        },
      },
    }));
    expect(block(html, 'vuln-counts')).toContain('data-evaluated="yes"');
    expect(block(html, 'vuln-counts')).toContain('critical 0');
    expect(section(html, 'vulnerabilities')).toContain('None');
  });

  it('leaves an unfinished vulnerability check blank instead of zero', () => {
    const html = formatHtmlReport(artifact({
      extended: {
        vulnerabilities: {
          source: 'unreachable',
          packages: [],
          totalAdvisories: 0,
          severityCounts: { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 },
        },
      },
    }));
    expect(block(html, 'vuln-counts')).toContain('Not scanned');
    expect(html).not.toContain('critical 0');
  });

  it('shows a zero fix rollup when the field is present and no version is listed', () => {
    const html = formatHtmlReport(artifact({
      findings: [
        {
          ruleId: 'vibgrate/runtime-lag',
          level: 'warning',
          message: 'behind',
          location: 'package.json',
          details: { fixedVersions: [] },
        },
      ],
    }));
    expect(block(html, 'fix-available')).toBe('<p id="fix-available">Fix available: 0</p>');
  });

  it('is deterministic and does not embed a timestamp, a script, or external assets', () => {
    const first = sample();
    const again = formatHtmlReport(first);
    expect(formatHtmlReport(first)).toBe(again);

    const shuffled = structuredClone(first);
    shuffled.findings = [...first.findings].reverse();
    shuffled.extended!.security!.findings = [...first.extended!.security!.findings].reverse();
    expect(formatHtmlReport(shuffled)).toBe(again);

    expect(again).not.toContain('2026-02-16T00:00:00.000Z');
    expect(again).not.toMatch(/<script/i);
    expect(again).not.toMatch(/<link[\s>]/i);
    expect(again).not.toMatch(/\ssrc\s*=/i);
    expect(again).not.toMatch(/<details/i);
    expect(again).not.toMatch(/fix available only/i);
    expect(again).toContain(`<div id="${ADVISORY_CORPUS_FOOTER_ID}" hidden></div>`);
    expect(again.startsWith('<!doctype html>')).toBe(true);
  });
});
