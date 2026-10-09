import { fixAvailableHint } from '../../core-open/formatters/fix-hint.js';
import { redactForDisplay } from '../../core-open/utils/redact.js';
import { redactHomePaths } from '../../core-open/utils/shareable-path.js';
import type { SecurityFinding } from '../../core-open/types.js';
import type { Finding, ScanArtifact } from '../types.js';

/**
 * Self-contained HTML for `vg report --format html`.
 *
 * Pure function of the artifact: stable sorts, no clock, no randomness, no
 * network, no external assets. Home-directory paths are rewritten to a
 * repo-relative or `~/` form, then artifact strings are secret-redacted and escaped.
 *
 * Stable ids: `#summary`, `#vulnerabilities`, `#security`, `#findings`.
 *
 * Two extension points, unused today:
 * - Rows carry {@link FIX_AVAILABLE_ATTR} so a client-side "fix available
 *   only" filter can be added without changing the row model.
 * - {@link advisoryCorpusFooter} emits an empty `#advisory-corpus` mount for
 *   a later collapsible advisory-corpus metadata footer.
 */

/** Row attribute a later "fix available only" filter can select on. */
export const FIX_AVAILABLE_ATTR = 'data-fix-available';

/** Element id reserved for a later advisory-corpus metadata footer. */
export const ADVISORY_CORPUS_FOOTER_ID = 'advisory-corpus';

const VULN_RULE_ID = 'vibgrate/vulnerability';

const VULN_SEVERITIES = ['critical', 'high', 'moderate', 'low', 'unknown'] as const;
type VulnSeverityName = (typeof VULN_SEVERITIES)[number];

const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type SecuritySeverityName = (typeof SECURITY_SEVERITIES)[number];

const VULN_RANK: Record<VulnSeverityName, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  unknown: 4,
};

const LEVEL_RANK: Record<string, number> = { error: 0, warning: 1, note: 2 };

export function formatHtmlReport(artifact: ScanArtifact, root?: string): string {
  artifact = redactHomePaths(artifact, root);
  const findings = Array.isArray(artifact.findings) ? artifact.findings : [];
  const vulnFindings = findings.filter((f) => f.ruleId === VULN_RULE_ID);
  const otherFindings = findings.filter((f) => f.ruleId !== VULN_RULE_ID);
  const security = securityFindings(artifact);
  const vulnEvaluated = vulnerabilityEvaluated(artifact, vulnFindings);
  const securityEvaluated = security !== null;

  const vulnCounts = vulnEvaluated ? countVuln(vulnFindings) : null;
  const securityCounts = securityEvaluated ? countSecurity(security) : null;
  const fix = fixRollup(findings);

  const vulnRows = sortWithIndex(vulnFindings, compareVuln);
  const securityRows = sortWithIndex(security ?? [], compareSecurity);
  const otherRows = sortWithIndex(otherFindings, compareOther);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vg report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 2rem; } h3 { font-size: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8884; vertical-align: top; }
  dl { display: grid; grid-template-columns: 10rem 1fr; gap: 0.15rem 1rem; margin: 0; }
  dt { font-weight: 600; } dd { margin: 0; }
  nav a { margin-right: 1rem; }
  a { color: inherit; }
  .absent { font-style: italic; }
</style>
</head>
<body>
<h1>vg report</h1>
<section id="summary">
<h2>Summary</h2>
<dl>
<dt>DriftScore</dt><dd id="drift-score">${scoreText(artifact.drift?.score)}</dd>
<dt>Risk level</dt><dd id="risk-level">${labelText(artifact.drift?.riskLevel)}</dd>
<dt>Runtime</dt><dd id="score-runtime">${scoreText(artifact.drift?.components?.runtimeScore)}</dd>
<dt>Frameworks</dt><dd id="score-framework">${scoreText(artifact.drift?.components?.frameworkScore)}</dd>
<dt>Dependencies</dt><dd id="score-dependency">${scoreText(artifact.drift?.components?.dependencyScore)}</dd>
<dt>EOL risk</dt><dd id="score-eol">${scoreText(artifact.drift?.components?.eolScore)}</dd>
</dl>
<h3><a href="#vulnerabilities">Vulnerabilities</a></h3>
${renderCounts('vuln-counts', VULN_SEVERITIES, vulnCounts)}
<h3><a href="#security">Security</a></h3>
${renderCounts('security-counts', SECURITY_SEVERITIES, securityCounts)}
${fix === null ? '' : `<p id="fix-available">Fix available: ${fix}</p>\n`}
<nav aria-label="Report sections">
<a href="#vulnerabilities">Vulnerabilities</a>
<a href="#security">Security</a>
<a href="#findings">Findings</a>
</nav>
</section>
<section id="vulnerabilities">
<h2>Vulnerabilities</h2>
${vulnEvaluated ? renderVulnTable(vulnRows) : '<p class="absent">Not scanned</p>'}
</section>
<section id="security">
<h2>Security</h2>
${securityEvaluated ? renderSecurityTable(securityRows) : '<p class="absent">Not scanned</p>'}
</section>
<section id="findings">
<h2>Findings</h2>
${renderFindingTable(otherRows)}
</section>
${advisoryCorpusFooter()}
</body>
</html>
`;
}

/** Empty mount. A later change can fill this with a collapsible footer. */
function advisoryCorpusFooter(): string {
  return `<div id="${ADVISORY_CORPUS_FOOTER_ID}" hidden></div>`;
}

function vulnerabilityEvaluated(artifact: ScanArtifact, vulnFindings: Finding[]): boolean {
  if (vulnFindings.length > 0) return true;
  const source = artifact.extended?.vulnerabilities?.source;
  return source !== undefined && source !== 'unreachable';
}

function securityFindings(artifact: ScanArtifact): SecurityFinding[] | null {
  const section = artifact.extended?.security;
  if (!section || !Array.isArray(section.findings)) return null;
  return section.findings;
}

function countVuln(findings: Finding[]): Record<VulnSeverityName | 'unspecified', number> {
  const counts: Record<VulnSeverityName | 'unspecified', number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    unknown: 0,
    unspecified: 0,
  };
  for (const finding of findings) {
    const severity = vulnSeverity(finding.details?.severity);
    if (severity) counts[severity] += 1;
    else counts.unspecified += 1;
  }
  return counts;
}

function countSecurity(findings: SecurityFinding[]): Record<SecuritySeverityName | 'unspecified', number> {
  const counts: Record<SecuritySeverityName | 'unspecified', number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    unspecified: 0,
  };
  for (const finding of findings) {
    const severity = securitySeverity(finding.severity);
    if (severity) counts[severity] += 1;
    else counts.unspecified += 1;
  }
  return counts;
}

function renderCounts<T extends string>(
  id: string,
  order: readonly T[],
  counts: (Record<T | 'unspecified', number>) | null,
): string {
  if (!counts) return `<p id="${id}" class="absent" data-evaluated="no">Not scanned</p>`;
  const items = order.map(
    (severity) => `<li data-severity="${severity}">${severity} ${counts[severity]}</li>`,
  );
  if (counts.unspecified > 0) {
    items.push(`<li data-severity="unspecified">unspecified ${counts.unspecified}</li>`);
  }
  return `<ul id="${id}" data-evaluated="yes">\n${items.join('\n')}\n</ul>`;
}

function renderVulnTable(findings: Finding[]): string {
  if (findings.length === 0) return '<p>None</p>';
  const rows = findings.map((finding) => {
    const fix = fixAvailableHint(finding.details?.fixedVersions);
    return `<tr ${FIX_AVAILABLE_ATTR}="${fix ? 'yes' : 'no'}"><td>${severityCell(finding.details?.severity, vulnSeverity)}</td><td>${cellText(detailString(finding, 'advisoryId'))}</td><td>${cellText(detailString(finding, 'package'))}</td><td>${cvssText(finding)}</td><td>${fix ? text(fix) : 'n/a'}</td><td>${text(finding.location)}</td><td>${text(finding.message)}</td></tr>`;
  });
  return `<table>
<thead><tr><th>Severity</th><th>Advisory</th><th>Package</th><th>CVSS</th><th>Fix</th><th>Location</th><th>Message</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}

function renderSecurityTable(findings: SecurityFinding[]): string {
  if (findings.length === 0) return '<p>None</p>';
  const rows = findings.map((finding) => {
    const where = finding.line !== undefined ? `${finding.path}:${finding.line}` : finding.path;
    const rule = `${finding.pack}/${finding.rule}`;
    return `<tr ${FIX_AVAILABLE_ATTR}="no"><td>${severityCell(finding.severity, securitySeverity)}</td><td>${text(rule)}</td><td>${text(where)}</td><td>${finding.address ? text(finding.address) : 'n/a'}</td><td>${text(finding.message)}</td></tr>`;
  });
  return `<table>
<thead><tr><th>Severity</th><th>Rule</th><th>Location</th><th>Address</th><th>Message</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}

function renderFindingTable(findings: Finding[]): string {
  if (findings.length === 0) return '<p>None</p>';
  const rows = findings.map((finding) => {
    const fix = fixAvailableHint(finding.details?.fixedVersions);
    return `<tr ${FIX_AVAILABLE_ATTR}="${fix ? 'yes' : 'no'}"><td>${text(finding.level)}</td><td>${text(finding.ruleId)}</td><td>${text(finding.location)}</td><td>${fix ? text(fix) : 'n/a'}</td><td>${text(finding.message)}</td></tr>`;
  });
  return `<table>
<thead><tr><th>Level</th><th>Rule</th><th>Location</th><th>Fix</th><th>Message</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}

/** Count of findings with a published fix. Null when no finding carries the field. */
function fixRollup(findings: Finding[]): number | null {
  if (!findings.some((finding) => hasFixedVersions(finding))) return null;
  return findings.filter((finding) => fixAvailableHint(finding.details?.fixedVersions) !== '').length;
}

function hasFixedVersions(finding: Finding): boolean {
  return !!finding.details && Object.prototype.hasOwnProperty.call(finding.details, 'fixedVersions');
}

function vulnSeverity(value: unknown): VulnSeverityName | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return (VULN_SEVERITIES as readonly string[]).includes(name) ? (name as VulnSeverityName) : null;
}

function securitySeverity(value: unknown): SecuritySeverityName | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return (SECURITY_SEVERITIES as readonly string[]).includes(name) ? (name as SecuritySeverityName) : null;
}

function severityCell(value: unknown, known: (value: unknown) => string | null): string {
  const canonical = known(value);
  if (canonical) return canonical;
  if (typeof value === 'string' && value.trim() !== '') return text(value.trim());
  return 'n/a';
}

/** A measured number stays, including 0. Anything else is absent. */
function scoreText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return String(value);
}

function labelText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'n/a';
  return text(value.trim());
}

function cvssText(finding: Finding): string {
  const details = finding.details;
  if (!details || !Object.prototype.hasOwnProperty.call(details, 'cvss')) return 'n/a';
  return scoreText(details.cvss);
}

function detailString(finding: Finding, key: string): string {
  const value = finding.details?.[key];
  return typeof value === 'string' ? value : '';
}

function vulnRank(value: unknown): number {
  const name = vulnSeverity(value);
  return name ? VULN_RANK[name] : VULN_SEVERITIES.length;
}

function compareVuln(a: Finding, b: Finding): number {
  return (
    vulnRank(a.details?.severity) - vulnRank(b.details?.severity) ||
    cmpStr(detailString(a, 'package'), detailString(b, 'package')) ||
    cmpStr(detailString(a, 'advisoryId'), detailString(b, 'advisoryId')) ||
    cmpStr(a.location, b.location) ||
    cmpStr(a.message, b.message)
  );
}

function compareSecurity(a: SecurityFinding, b: SecurityFinding): number {
  const addressA = a.address ?? '';
  const addressB = b.address ?? '';
  return (
    cmpStr(a.path, b.path) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    cmpStr(addressA, addressB) ||
    cmpStr(a.rule, b.rule) ||
    cmpStr(a.id, b.id)
  );
}

function compareOther(a: Finding, b: Finding): number {
  return (
    (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) ||
    cmpStr(a.ruleId, b.ruleId) ||
    cmpStr(a.location, b.location) ||
    cmpStr(a.message, b.message)
  );
}

function sortWithIndex<T>(items: T[], cmp: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => cmp(a.item, b.item) || a.index - b.index)
    .map((row) => row.item);
}

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function cellText(value: string): string {
  return value ? text(value) : 'n/a';
}

function text(value: string): string {
  return esc(redactForDisplay(value));
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
