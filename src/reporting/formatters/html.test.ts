import { describe, expect, it, vi } from 'vitest';
import { formatHtml } from './html.js';
import { VULN_RULE_ID } from '../../core-open/scanners/vulnerability-scanner.js';
import { SECURITY_FINDING_SEVERITIES } from '../../security/types.js';
import type { ScanArtifact } from '../types.js';

const VULN_RULE = 'vibgrate/vulnerability';

function artifact(overrides: Record<string, unknown> = {}): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-16T00:00:00.000Z',
    vibgrateVersion: '0.0.0-fixture',
    rootPath: '/home/secret-user/proj',
    vcs: { type: 'git', remoteUrl: 'https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/private.git' },
    projects: [],
    drift: {
      score: null,
      riskLevel: null,
      components: { runtimeScore: null, frameworkScore: null, dependencyScore: null, eolScore: null },
    },
    findings: [],
    ...overrides,
  } as ScanArtifact;
}

function summaryOf(html: string): string {
  const start = html.indexOf('<section id="summary"');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + '</section>'.length);
}

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

describe('formatHtml', () => {
  const scanned = artifact({
    findings: [
      {
        ruleId: VULN_RULE,
        level: 'note',
        message: 'gamma issue',
        location: 'gamma',
        details: { package: 'gamma', advisoryId: 'GHSA-g' },
      },
      {
        ruleId: VULN_RULE,
        level: 'error',
        message: 'alpha issue',
        location: 'alpha',
        details: {
          package: 'alpha',
          advisoryId: 'GHSA-1',
          severity: 'critical',
          cvss: 9.8,
          fixedVersions: ['1.2.3'],
        },
      },
      {
        ruleId: VULN_RULE,
        level: 'warning',
        message: 'beta issue — no fix available',
        location: 'beta',
        details: {
          package: 'beta',
          advisoryId: 'GHSA-2',
          severity: 'high',
          cvss: null,
          fixedVersions: [],
        },
      },
      {
        ruleId: VULN_RULE,
        level: 'note',
        message: 'delta issue',
        location: 'delta',
        details: {
          package: 'delta',
          advisoryId: 'GHSA-d',
          severity: 'unknown',
          cvss: 0,
          fixedVersions: ['9.9.9'],
        },
      },
      {
        ruleId: 'vibgrate/runtime-lag',
        level: 'note',
        message: 'runtime is current',
        location: 'app',
      },
    ],
    extended: {
      security: {
        schema: 'vg.security.v1',
        engine: 'test',
        packs: { zeta: '1', alpha: '2' },
        facts: { received: 1, evaluated: 1, rejected: 0 },
        findings: [
          {
            id: 'b'.repeat(32),
            pack: 'iac-cis-v1',
            packVersion: '1',
            rule: 'disk-unencrypted',
            severity: 'medium',
            message: 'disk is open',
            path: 'infra/disk.tf',
            line: 4,
            address: 'aws_ebs_volume.data',
          },
        ],
      },
    },
  });

  const summary = `<section id="summary" class="summary">
<h2>Summary</h2>
<p>DriftScore: n/a</p>
<ul>
<li><a href="#vulnerabilities">Vulnerabilities</a>: <a href="#vuln-critical">critical 1</a> · <a href="#vuln-high">high 1</a> · moderate 0 · low 0 · <a href="#vuln-unknown">unknown 1</a> · <a href="#vuln-absent">absent 1</a></li>
<li><a href="#security">Security</a>: critical 0 · high 0 · <a href="#security-medium">medium 1</a> · low 0 · info 0</li>
</ul>
<p class="fix-available"><a href="#vulnerabilities">2 with a fix available</a></p>
<nav>
<a href="#vulnerabilities">Vulnerabilities</a>
<a href="#security">Security</a>
<a href="#findings">Findings</a>
</nav>
</section>`;

  it('locks the vulnerability rule id to the scanner', () => {
    expect(VULN_RULE_ID).toBe(VULN_RULE);
  });

  it('opens with the summary block, severity counts, and anchors', () => {
    const html = formatHtml(scanned);
    expect(summaryOf(html)).toBe(summary);
    expect(html.indexOf('id="summary"')).toBeLessThan(html.indexOf('id="vulnerabilities"'));
    expect(html.indexOf('id="vulnerabilities"')).toBeLessThan(html.indexOf('id="security"'));
    expect(html.indexOf('id="security"')).toBeLessThan(html.indexOf('id="findings"'));
    expect(html.indexOf('id="findings"')).toBeLessThan(html.indexOf('id="report-footer"'));
    expect(html).toContain('id="vuln-critical"');
    expect(html).toContain('id="vuln-high"');
    expect(html).toContain('id="vuln-unknown"');
    expect(html).toContain('id="vuln-absent"');
    expect(html).toContain('id="security-medium"');
    expect(html).toContain('<footer id="report-footer"></footer>');

    const vulns = sectionOf(html, 'vulnerabilities');
    expect(vulns).toContain('alpha issue');
    expect(vulns).toContain('<td class="cvss">9.8</td>');
    expect(vulns).toContain('<td class="cvss">n/a</td>');
    expect(vulns).toContain('<td class="cvss">0</td>');
    expect(vulns).toContain('fix available (1.2.3)');
    expect(vulns).toContain('fix available (9.9.9)');
    expect(vulns).not.toMatch(/no fix/i);
    expect(vulns.match(/data-fix-available="yes"/g)).toHaveLength(2);

    const findings = sectionOf(html, 'findings');
    expect(findings).toContain('runtime is current');
    expect(findings).not.toContain('alpha issue');

    const security = sectionOf(html, 'security');
    expect(security).toContain('alpha@2, zeta@1');
    expect(security).toContain('iac-cis-v1/disk-unencrypted');
    expect(security).toContain('infra/disk.tf:4');
    expect(security.indexOf('medium')).toBeGreaterThan(-1);
    expect(summaryOf(html)).not.toContain('moderate 1');
    for (const severity of SECURITY_FINDING_SEVERITIES) {
      expect(summaryOf(html)).toContain(severity);
    }
  });

  it('keeps an absent DriftScore and an absent CVSS off the zero mark', () => {
    const html = formatHtml(scanned);
    expect(html).toContain('DriftScore: n/a');
    expect(html).not.toContain('DriftScore: 0');
    expect(html).not.toContain('0/100');
    expect(sectionOf(html, 'vulnerabilities')).toContain('<td class="cvss">n/a</td>');
  });

  it('renders a measured zero DriftScore as 0', () => {
    const html = formatHtml(artifact({
      drift: {
        score: 0,
        riskLevel: 'low',
        components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
      },
    }));
    expect(summaryOf(html)).toContain('DriftScore: 0/100');
    expect(summaryOf(html)).not.toContain('DriftScore: n/a');
  });

  it('does not show zero severity counts when a scan did not run', () => {
    const html = formatHtml(artifact());
    const summary = summaryOf(html);
    expect(summary).toContain('Vulnerabilities</a>: not scanned');
    expect(summary).toContain('Security</a>: not evaluated');
    expect(summary).not.toContain('critical 0');
    expect(summary).not.toContain('absent');
    expect(summary).not.toContain('fix-available');
    expect(html).not.toMatch(/no fix/i);
    expect(sectionOf(html, 'vulnerabilities')).toContain('Not scanned.');
    expect(sectionOf(html, 'security')).toContain('Not evaluated.');
  });

  it('shows measured zeros after a clean vulnerability scan', () => {
    const html = formatHtml(artifact({
      extended: {
        vulnerabilities: {
          source: 'osv',
          packages: [],
          totalAdvisories: 0,
          severityCounts: { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 },
        },
      },
    }));
    expect(summaryOf(html)).toContain(
      'Vulnerabilities</a>: critical 0 · high 0 · moderate 0 · low 0 · unknown 0',
    );
    expect(summaryOf(html)).not.toContain('absent');
    expect(sectionOf(html, 'vulnerabilities')).toContain('No vulnerability findings.');
  });

  it('does not treat an unreachable vulnerability scan as a clean zero', () => {
    const html = formatHtml(artifact({
      extended: {
        vulnerabilities: {
          source: 'unreachable',
          packages: [],
          totalAdvisories: 0,
          severityCounts: { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 },
        },
      },
    }));
    expect(summaryOf(html)).toContain('Vulnerabilities</a>: not checked');
    expect(summaryOf(html)).not.toContain('critical 0');
  });

  it('does not treat a scan with no packages as a clean zero', () => {
    const html = formatHtml(artifact({
      extended: {
        vulnerabilities: {
          source: 'none',
          packages: [],
          totalAdvisories: 0,
          severityCounts: { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 },
        },
      },
    }));
    expect(summaryOf(html)).toContain('Vulnerabilities</a>: no packages to check');
    expect(summaryOf(html)).not.toContain('critical 0');
  });

  it('uses advisory severity when the finding does not record one', () => {
    const html = formatHtml(artifact({
      findings: [
        {
          ruleId: VULN_RULE,
          level: 'error',
          message: 'lodash issue',
          location: 'lodash',
          details: { package: 'lodash', advisoryId: 'GHSA-a', fixedVersions: ['4.17.21'] },
        },
      ],
      extended: {
        vulnerabilities: {
          source: 'manifest',
          packages: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              version: '4.17.20',
              advisories: [{ id: 'GHSA-a', severity: 'high', cvss: 7.5 }],
            },
          ],
          totalAdvisories: 1,
          severityCounts: { low: 0, moderate: 0, high: 1, critical: 0, unknown: 0 },
        },
      },
    }));
    expect(summaryOf(html)).toContain('high 1');
    expect(summaryOf(html)).not.toContain('absent');
    expect(sectionOf(html, 'vulnerabilities')).toContain('<td class="cvss">7.5</td>');
    expect(summaryOf(html)).toContain('1 with a fix available');
  });

  it('counts an unrecognized severity as absent, not as unknown or zero', () => {
    const html = formatHtml(artifact({
      findings: [
        {
          ruleId: VULN_RULE,
          level: 'note',
          message: 'odd',
          location: 'odd',
          details: { package: 'odd', severity: 'severe', cvss: null },
        },
      ],
    }));
    expect(summaryOf(html)).toContain('unknown 0');
    expect(summaryOf(html)).toContain('absent 1');
    expect(summaryOf(html)).not.toContain('unknown 1');
  });

  it('escapes markup and redacts credential-shaped text', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz';
    const html = formatHtml(artifact({
      findings: [
        {
          ruleId: VULN_RULE,
          level: 'error',
          message: `</td><script>alert(1)</script> ${token}`,
          location: 'p&q',
          details: {
            package: 'a<b>',
            advisoryId: 'x"y',
            severity: 'low',
            cvss: 1,
            fixedVersions: ['1<2'],
          },
        },
      ],
    }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain(token);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('[REDACTED]');
    expect(html).toContain('a&lt;b&gt;');
    expect(html).toContain('x&quot;y');
    expect(html).toContain('p&amp;q');
    expect(html).toContain('1&lt;2');
    expect(html).not.toContain('/home/secret-user/proj');
    expect(html).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(html).not.toContain('https://user:');
  });

  it('is byte-identical across renders and input order', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1).mockReturnValueOnce(2);
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    try {
      const first = formatHtml(scanned);
      const second = formatHtml(scanned);
      expect(second).toBe(first);

      const findings = [...(scanned.findings ?? [])].reverse();
      const extended = scanned.extended as { security?: { findings?: unknown[] } };
      const securityFindings = [...(extended.security?.findings ?? [])].reverse();
      const shuffled = artifact({
        findings,
        extended: {
          security: {
            ...(extended.security as object),
            findings: securityFindings,
            packs: { zeta: '1', alpha: '2' },
          },
        },
      });
      expect(formatHtml(shuffled)).toBe(first);
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });

  it('embeds no external assets', () => {
    const html = formatHtml(artifact());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).not.toMatch(/url\s*\(/);
    expect(html).not.toMatch(/https?:/);
  });
});
