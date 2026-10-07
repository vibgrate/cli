import type { Finding, ScanArtifact } from '../types.js';
import type { SecuritySeverity, VulnSeverity } from '../../core-open/types.js';
import { fixAvailableHint, humanFindingText } from '../../core-open/formatters/fix-hint.js';
import { redactForDisplay } from '../../core-open/utils/redact.js';

/**
 * `vg report --format html`.
 *
 * One self-contained page, in this order:
 *   1. summary — severity counts, optional fix-available rollup, anchors
 *   2. vulnerability, security, and other finding sections (the summary
 *      navigates to these; it does not replace them)
 *   3. footer (`#report-footer`) — empty, so provenance can be appended
 *      later without moving the summary
 *
 * A vulnerability row whose `details.fixedVersions` names a version sets
 * `data-fix-available="yes"`. The default page still lists every row.
 *
 * Pure: no clock, no randomness, no network, no external assets. The same
 * artifact always produces the same string. A missing score is `n/a`. A
 * score that was computed as 0 stays `0`.
 */

/** Rule id written by `generateVulnerabilityFindings` (`VULN_RULE_ID`). */
const VULN_RULE_ID = 'vibgrate/vulnerability';

export const HTML_SUMMARY_ID = 'summary';
export const HTML_VULNERABILITIES_ID = 'vulnerabilities';
export const HTML_SECURITY_ID = 'security';
export const HTML_FINDINGS_ID = 'findings';
export const HTML_FOOTER_ID = 'report-footer';

const VULN_SEVERITIES = ['critical', 'high', 'moderate', 'low', 'unknown'] as const satisfies readonly VulnSeverity[];
const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly SecuritySeverity[];

const VULN_ORDER = [...VULN_SEVERITIES, 'absent'] as const;
const SECURITY_ORDER = [...SECURITY_SEVERITIES, 'absent'] as const;

type VulnBucket = (typeof VULN_ORDER)[number];
type SecurityBucket = (typeof SECURITY_ORDER)[number];

interface AdvisoryHit {
  severity?: unknown;
  cvss?: unknown;
}

interface VulnBlock {
  source: string;
  advisories: Map<string, AdvisoryHit>;
}

interface VulnRow {
  severity: VulnBucket;
  packageName: string;
  advisory: string;
  location: string;
  cvssText: string;
  fixText: string;
  message: string;
}

interface SecurityRow {
  severity: SecurityBucket;
  pack: string;
  rule: string;
  path: string;
  line: number | null;
  address: string;
  message: string;
  id: string;
}

interface SecurityBlock {
  packsLabel: string;
  findings: SecurityRow[];
}

interface OtherRow {
  level: 'error' | 'warning' | 'note';
  ruleId: string;
  location: string;
  message: string;
}

type VulnState =
  | { kind: 'not-scanned' }
  | { kind: 'not-checked' }
  | { kind: 'no-packages' }
  | { kind: 'measured'; counts: Record<VulnSeverity, number>; absent: number };

interface ReportModel {
  version: string;
  drift: string;
  vulnState: VulnState;
  vulnRows: VulnRow[];
  fixAvailable: number;
  security: SecurityBlock | undefined;
  securityCounts: Record<SecuritySeverity, number>;
  securityAbsent: number;
  otherRows: OtherRow[];
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function plain(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function shown(value: string): string {
  return esc(redactForDisplay(value));
}

function rank(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function asScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** A missing score is `n/a`. A computed 0 stays `0` — never the other way around. */
function formatScore(score: number | null): string {
  return score === null ? 'n/a' : String(score);
}

function asVulnSeverity(value: unknown): VulnSeverity | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().toLowerCase();
  return (VULN_SEVERITIES as readonly string[]).includes(label) ? (label as VulnSeverity) : null;
}

function securitySeverity(value: unknown): SecurityBucket {
  if (typeof value !== 'string') return 'absent';
  const label = value.trim().toLowerCase();
  return (SECURITY_SEVERITIES as readonly string[]).includes(label) ? (label as SecuritySeverity) : 'absent';
}

function detailString(details: Record<string, unknown> | undefined, key: string): string {
  const value = details?.[key];
  return typeof value === 'string' ? value : '';
}

function readVulns(artifact: ScanArtifact): VulnBlock | undefined {
  const raw = artifact.extended && (artifact.extended as { vulnerabilities?: unknown }).vulnerabilities;
  if (!isRecord(raw) || typeof raw.source !== 'string' || !Array.isArray(raw.packages)) return undefined;
  const advisories = new Map<string, AdvisoryHit>();
  for (const item of raw.packages) {
    if (!isRecord(item) || typeof item.package !== 'string' || !Array.isArray(item.advisories)) continue;
    for (const advisory of item.advisories) {
      if (!isRecord(advisory) || typeof advisory.id !== 'string') continue;
      const key = `${item.package}\0${advisory.id}`;
      if (!advisories.has(key)) advisories.set(key, advisory);
    }
  }
  return { source: raw.source, advisories };
}

function readSecurity(artifact: ScanArtifact): SecurityBlock | undefined {
  const raw = artifact.extended && (artifact.extended as { security?: unknown }).security;
  if (!isRecord(raw) || !Array.isArray(raw.findings)) return undefined;
  const findings: SecurityRow[] = [];
  for (const item of raw.findings) {
    if (!isRecord(item)) continue;
    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null;
    findings.push({
      severity: securitySeverity(item.severity),
      pack: plain(item.pack),
      rule: plain(item.rule),
      path: plain(item.path),
      line,
      address: plain(item.address),
      message: plain(item.message),
      id: plain(item.id),
    });
  }
  return { packsLabel: packsLabel(raw.packs), findings };
}

function packsLabel(packs: unknown): string {
  if (!isRecord(packs)) return '';
  return Object.keys(packs)
    .filter((key) => typeof packs[key] === 'string')
    .sort(cmp)
    .map((key) => `${key}@${packs[key] as string}`)
    .join(', ');
}

function readFindings(artifact: ScanArtifact): Finding[] {
  if (!Array.isArray(artifact.findings)) return [];
  const out: Finding[] = [];
  for (const item of artifact.findings) {
    if (!isRecord(item) || typeof item.ruleId !== 'string' || typeof item.message !== 'string') continue;
    const level = item.level === 'error' || item.level === 'warning' || item.level === 'note' ? item.level : 'note';
    const location = plain(item.location);
    const details = isRecord(item.details) ? item.details : undefined;
    out.push({ ruleId: item.ruleId, level, message: item.message, location, ...(details ? { details } : {}) });
  }
  return out;
}

function advisoryHit(block: VulnBlock | undefined, details: Record<string, unknown> | undefined, location: string): AdvisoryHit | undefined {
  if (!block) return undefined;
  const id = detailString(details, 'advisoryId');
  if (!id) return undefined;
  const packageName = detailString(details, 'package') || location;
  return block.advisories.get(`${packageName}\0${id}`);
}

function vulnSeverityOf(details: Record<string, unknown> | undefined, hit: AdvisoryHit | undefined): VulnBucket {
  if (details && Object.prototype.hasOwnProperty.call(details, 'severity')) {
    return asVulnSeverity(details.severity) ?? 'absent';
  }
  return asVulnSeverity(hit?.severity) ?? 'absent';
}

function cvssOf(details: Record<string, unknown> | undefined, hit: AdvisoryHit | undefined): number | null {
  if (details && Object.prototype.hasOwnProperty.call(details, 'cvss')) return asScore(details.cvss);
  if (hit && Object.prototype.hasOwnProperty.call(hit, 'cvss')) return asScore(hit.cvss);
  return null;
}

function emptyVulnCounts(): Record<VulnSeverity, number> {
  return { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
}

function emptySecurityCounts(): Record<SecuritySeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function vulnState(rows: VulnRow[], block: VulnBlock | undefined): VulnState {
  const measured = rows.length > 0 || block?.source === 'osv' || block?.source === 'manifest';
  if (measured) {
    const counts = emptyVulnCounts();
    let absent = 0;
    for (const row of rows) {
      if (row.severity === 'absent') absent += 1;
      else counts[row.severity] += 1;
    }
    return { kind: 'measured', counts, absent };
  }
  if (block?.source === 'unreachable') return { kind: 'not-checked' };
  if (block?.source === 'none') return { kind: 'no-packages' };
  return { kind: 'not-scanned' };
}

function driftLabel(artifact: ScanArtifact): string {
  const score = artifact.drift?.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'n/a';
  return `${score}/100`;
}

function buildModel(artifact: ScanArtifact): ReportModel {
  const block = readVulns(artifact);
  const findings = readFindings(artifact);
  const vulnRows: VulnRow[] = [];
  const otherRows: OtherRow[] = [];
  let fixAvailable = 0;

  for (const finding of findings) {
    const human = humanFindingText(finding);
    const message = redactForDisplay(human.message);
    if (finding.ruleId !== VULN_RULE_ID) {
      otherRows.push({ level: finding.level, ruleId: finding.ruleId, location: finding.location, message });
      continue;
    }
    const hit = advisoryHit(block, finding.details, finding.location);
    const fixText = redactForDisplay(fixAvailableHint(finding.details?.fixedVersions));
    if (fixText) fixAvailable += 1;
    const packageName = detailString(finding.details, 'package') || finding.location;
    vulnRows.push({
      severity: vulnSeverityOf(finding.details, hit),
      packageName,
      advisory: detailString(finding.details, 'advisoryId'),
      location: finding.location,
      cvssText: formatScore(cvssOf(finding.details, hit)),
      fixText,
      message,
    });
  }

  vulnRows.sort((a, b) =>
    rank(VULN_ORDER, a.severity) - rank(VULN_ORDER, b.severity)
    || cmp(a.packageName, b.packageName)
    || cmp(a.advisory, b.advisory)
    || cmp(a.location, b.location)
    || cmp(a.cvssText, b.cvssText)
    || cmp(a.fixText, b.fixText)
    || cmp(a.message, b.message),
  );
  otherRows.sort((a, b) =>
    levelRank(a.level) - levelRank(b.level)
    || cmp(a.ruleId, b.ruleId)
    || cmp(a.location, b.location)
    || cmp(a.message, b.message),
  );

  const security = readSecurity(artifact);
  if (security) {
    security.findings.sort((a, b) =>
      rank(SECURITY_ORDER, a.severity) - rank(SECURITY_ORDER, b.severity)
      || cmp(a.path, b.path)
      || (a.line ?? -1) - (b.line ?? -1)
      || cmp(a.address, b.address)
      || cmp(a.pack, b.pack)
      || cmp(a.rule, b.rule)
      || cmp(a.id, b.id)
      || cmp(a.message, b.message),
    );
  }
  const securityCounts = emptySecurityCounts();
  let securityAbsent = 0;
  for (const row of security?.findings ?? []) {
    if (row.severity === 'absent') securityAbsent += 1;
    else securityCounts[row.severity] += 1;
  }

  const version = typeof artifact.vibgrateVersion === 'string' ? artifact.vibgrateVersion : '';
  return {
    version,
    drift: driftLabel(artifact),
    vulnState: vulnState(vulnRows, block),
    vulnRows,
    fixAvailable,
    security,
    securityCounts,
    securityAbsent,
    otherRows,
  };
}

function levelRank(level: OtherRow['level']): number {
  if (level === 'error') return 0;
  if (level === 'warning') return 1;
  return 2;
}

function countText(prefix: string, order: readonly string[], counts: Record<string, number>, absent: number): string {
  const parts = order.filter((severity) => severity !== 'absent').map((severity) => {
    const count = counts[severity] ?? 0;
    const label = `${severity} ${count}`;
    return count > 0 ? `<a href="#${prefix}-${severity}">${label}</a>` : label;
  });
  if (absent > 0) parts.push(`<a href="#${prefix}-absent">absent ${absent}</a>`);
  return parts.join(' · ');
}

function vulnSummary(state: VulnState): string {
  const label = `<a href="#${HTML_VULNERABILITIES_ID}">Vulnerabilities</a>`;
  if (state.kind === 'not-scanned') return `${label}: not scanned`;
  if (state.kind === 'not-checked') return `${label}: not checked`;
  if (state.kind === 'no-packages') return `${label}: no packages to check`;
  return `${label}: ${countText('vuln', VULN_ORDER, state.counts, state.absent)}`;
}

function securitySummary(model: ReportModel): string {
  const label = `<a href="#${HTML_SECURITY_ID}">Security</a>`;
  if (!model.security) return `${label}: not evaluated`;
  return `${label}: ${countText('security', SECURITY_ORDER, model.securityCounts, model.securityAbsent)}`;
}

function renderSummary(model: ReportModel): string {
  const lines = [
    `<section id="${HTML_SUMMARY_ID}" class="summary">`,
    '<h2>Summary</h2>',
    `<p>DriftScore: ${model.drift}</p>`,
    '<ul>',
    `<li>${vulnSummary(model.vulnState)}</li>`,
    `<li>${securitySummary(model)}</li>`,
    '</ul>',
  ];
  if (model.fixAvailable > 0) {
    lines.push(
      `<p class="fix-available"><a href="#${HTML_VULNERABILITIES_ID}">${model.fixAvailable} with a fix available</a></p>`,
    );
  }
  lines.push(
    '<nav>',
    `<a href="#${HTML_VULNERABILITIES_ID}">Vulnerabilities</a>`,
    `<a href="#${HTML_SECURITY_ID}">Security</a>`,
    `<a href="#${HTML_FINDINGS_ID}">Findings</a>`,
    '</nav>',
    '</section>',
  );
  return lines.join('\n');
}

function openRow(id: string | undefined, fix: boolean): string {
  const attrs: string[] = [];
  if (id) attrs.push(`id="${id}"`);
  if (fix) attrs.push('data-fix-available="yes"');
  return attrs.length > 0 ? `<tr ${attrs.join(' ')}>` : '<tr>';
}

function cells(values: string[], classes: readonly (string | undefined)[]): string {
  return values.map((value, index) => {
    const cls = classes[index];
    return cls ? `<td class="${cls}">${value}</td>` : `<td>${value}</td>`;
  }).join('');
}

function table(headers: readonly string[], rows: readonly string[]): string {
  const head = `<tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr>`;
  return ['<table>', '<thead>', head, '</thead>', '<tbody>', ...rows, '</tbody>', '</table>'].join('\n');
}

function renderVulnSection(model: ReportModel): string {
  const body: string[] = [`<section id="${HTML_VULNERABILITIES_ID}">`, '<h2>Vulnerabilities</h2>'];
  if (model.vulnState.kind === 'not-scanned') body.push('<p class="empty">Not scanned.</p>');
  else if (model.vulnState.kind === 'not-checked') body.push('<p class="empty">Not checked.</p>');
  else if (model.vulnState.kind === 'no-packages') body.push('<p class="empty">No packages to check.</p>');
  else if (model.vulnRows.length === 0) body.push('<p class="empty">No vulnerability findings.</p>');
  else {
    const seen = new Set<string>();
    const rows = model.vulnRows.map((row) => {
      const id = seen.has(row.severity) ? undefined : `vuln-${row.severity}`;
      seen.add(row.severity);
      return `${openRow(id, row.fixText !== '')}${cells(
        [
          shown(row.severity),
          shown(row.packageName),
          shown(row.advisory),
          shown(row.cvssText),
          shown(row.fixText),
          shown(row.location),
          shown(row.message),
        ],
        [undefined, undefined, undefined, 'cvss', 'fix', undefined, undefined],
      )}</tr>`;
    });
    body.push(table(['Severity', 'Package', 'Advisory', 'CVSS', 'Fix', 'Location', 'Message'], rows));
  }
  body.push('</section>');
  return body.join('\n');
}

function securityWhere(row: SecurityRow): string {
  return row.line === null ? row.path : `${row.path}:${row.line}`;
}

function renderSecuritySection(model: ReportModel): string {
  const body: string[] = [`<section id="${HTML_SECURITY_ID}">`, '<h2>Security</h2>'];
  if (!model.security) {
    body.push('<p class="empty">Not evaluated.</p>');
  } else {
    if (model.security.packsLabel) body.push(`<p class="meta">${shown(model.security.packsLabel)}</p>`);
    if (model.security.findings.length === 0) body.push('<p class="empty">No security findings.</p>');
    else {
      const seen = new Set<string>();
      const rows = model.security.findings.map((row) => {
        const id = seen.has(row.severity) ? undefined : `security-${row.severity}`;
        seen.add(row.severity);
        const rule = row.pack && row.rule ? `${row.pack}/${row.rule}` : row.rule || row.pack;
        return `${openRow(id, false)}${cells(
          [shown(row.severity), shown(rule), shown(securityWhere(row)), shown(row.address), shown(row.message)],
          [],
        )}</tr>`;
      });
      body.push(table(['Severity', 'Rule', 'Location', 'Address', 'Message'], rows));
    }
  }
  body.push('</section>');
  return body.join('\n');
}

function renderFindingsSection(model: ReportModel): string {
  const body: string[] = [`<section id="${HTML_FINDINGS_ID}">`, '<h2>Findings</h2>'];
  if (model.otherRows.length === 0) body.push('<p class="empty">No other findings.</p>');
  else {
    const rows = model.otherRows.map((row) =>
      `${openRow(undefined, false)}${cells(
        [shown(row.level), shown(row.ruleId), shown(row.location), shown(row.message)],
        [],
      )}</tr>`,
    );
    body.push(table(['Level', 'Rule', 'Location', 'Message'], rows));
  }
  body.push('</section>');
  return body.join('\n');
}

function renderDocument(model: ReportModel): string {
  const version = model.version ? ` ${shown(model.version)}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vg · drift report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8884; vertical-align: top; }
  .meta, .empty { color: #888; }
  .summary { background: #8882; padding: 0.6rem 0.8rem; border-radius: 6px; }
  .summary h2 { margin-top: 0; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>vg · drift report</h1>
<p class="meta">vg${version}</p>
${renderSummary(model)}
${renderVulnSection(model)}
${renderSecuritySection(model)}
${renderFindingsSection(model)}
<footer id="${HTML_FOOTER_ID}"></footer>
</body>
</html>
`;
}

/** Self-contained HTML report for a scan artifact. Deterministic and local. */
export function formatHtml(artifact: ScanArtifact): string {
  return renderDocument(buildModel(artifact));
}
