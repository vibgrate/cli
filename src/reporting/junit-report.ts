/**
 * Deterministic JUnit XML for `vg scan --junit <file>`.
 *
 * The report summarizes drift findings and the gates `vg scan` actually
 * judges (drift `--fail-on`, architecture, security packs, drift budget).
 * It is a pure function of that input: no clock, no host name, no DSN, no
 * repository URL. Home-directory paths are rewritten the same way as the
 * JSON artifact (relative to the scan root, or `~/…`). The optional JUnit
 * `timestamp` attribute is omitted;
 * `time` is always `0` because wall-clock duration is not part of the result.
 *
 * Suites, in order:
 *   1. `findings` — one testcase per drift finding (`classname` `vg.findings`)
 *   2. `architecture` — only when that gate was requested
 *   3. `security` — only when a security / iac gate was requested
 *   4. `gates` — drift-budget and drift-worsening cases that were judged
 *
 * Finding names are `{ruleId} {location}`, sorted by rule id, location,
 * level (`error`, `warning`, `note`), then message. A ` #2` suffix breaks
 * ties. A finding is a `<failure>` only when its level would fail the active
 * drift gate; otherwise it is `<skipped>`. Notes never fail a gate.
 */
import * as path from 'node:path';
import { shareablePath } from '../core-open/utils/shareable-path.js';
import { compareDriftBudget, type DriftBudgetGateResult } from './drift-budget-gate.js';
import { writeTextFile } from './utils/fs.js';

export const JUNIT_FINDINGS_CLASS = 'vg.findings';
export const JUNIT_GATES_CLASS = 'vg.gates';
export const JUNIT_ARCHITECTURE_CLASS = 'vg.architecture';
export const JUNIT_SECURITY_CLASS = 'vg.security';

export const FINDING_SKIP_NO_GATE = 'drift gate not set';
export const FINDING_SKIP_NOTE = 'notes do not fail a gate';
export const FINDING_SKIP_BELOW_ERROR = 'below the --fail-on error gate';
export const SECURITY_SKIP_BELOW = 'below the security gate';

export const ARCHITECTURE_NEEDS_GRAPH =
  '--fail-on architecture-finding needs the code map: remove --no-graph / --max-privacy / --no-local-artifacts.';

export const ARCHITECTURE_NOT_CLASSIFIED =
  '--fail-on architecture-finding: the architecture module did not classify this map (install it with `vg module install arch`; a rejected .vibgrate/architecture.toml is reported above).';

export const IAC_NEEDS_GRAPH =
  '--iac needs the code map: remove --no-graph / --max-privacy / --no-local-artifacts.';

const DRIFT_BUDGET_ABSENT = 'DriftScore is absent; the project drift budget was not compared.';

export type JUnitStatus = 'pass' | 'failure' | 'skipped';

export type JUnitTestCase =
  | { status: 'pass'; classname: string; name: string }
  | { status: 'skipped'; classname: string; name: string; message: string }
  | { status: 'failure'; classname: string; name: string; message: string; type: string; body?: string };

export interface JUnitSuite {
  name: string;
  cases: JUnitTestCase[];
}

export interface JUnitReport {
  name: string;
  suites: JUnitSuite[];
}

export interface JUnitFinding {
  ruleId: string;
  level: 'warning' | 'error' | 'note';
  message: string;
  location: string;
}

export interface ScanJUnitInput {
  findings: readonly JUnitFinding[];
  /** Set only for `--fail-on warn` or `--fail-on error`. */
  driftGate?: 'warn' | 'error';
  /** Appended after the findings suite, in the order given. Empty suites are dropped. */
  extraSuites?: readonly JUnitSuite[];
  /** Scan directory. Home paths inside it are written relative to this directory. */
  root?: string;
}

export interface ArchitectureJUnitRow {
  file: string;
  line?: number;
  symbol: string;
  severity: string;
  message: string;
  rule: string;
  policy: string;
}

export interface SecurityJUnitFinding {
  id: string;
  pack: string;
  rule: string;
  path: string;
  line?: number;
  severity: string;
  message: string;
}

/** Code-unit order. Locale-independent, unlike `localeCompare`. */
function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const LEVEL_RANK: Record<JUnitFinding['level'], number> = { error: 0, warning: 1, note: 2 };

function compareFindings(a: JUnitFinding, b: JUnitFinding): number {
  return cmp(a.ruleId, b.ruleId)
    || cmp(a.location, b.location)
    || (LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    || cmp(a.message, b.message);
}

/** First occurrence keeps `base`; later copies become `base #2`, `base #3`, … */
function uniqueNames(bases: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const names: string[] = [];
  for (const base of bases) {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    names.push(n === 1 ? base : `${base} #${n}`);
  }
  return names;
}

function pass(classname: string, name: string): JUnitTestCase {
  return { status: 'pass', classname, name };
}

function skipped(classname: string, name: string, message: string): JUnitTestCase {
  return { status: 'skipped', classname, name, message };
}

function failure(classname: string, name: string, type: string, message: string, body?: string): JUnitTestCase {
  return { status: 'failure', classname, name, type, message, ...(body !== undefined ? { body } : {}) };
}

function findingSkip(level: JUnitFinding['level'], driftGate: 'warn' | 'error' | undefined): string | null {
  if (level === 'note') return FINDING_SKIP_NOTE;
  if (!driftGate) return FINDING_SKIP_NO_GATE;
  if (driftGate === 'error' && level === 'warning') return FINDING_SKIP_BELOW_ERROR;
  return null;
}

function findingBody(f: JUnitFinding): string {
  return `${f.message}\nrule: ${f.ruleId}\nlocation: ${f.location}\nlevel: ${f.level}`;
}

export function findingsSuite(
  findings: readonly JUnitFinding[],
  driftGate?: 'warn' | 'error',
  root?: string,
): JUnitSuite {
  const sorted = findings.map((f) => ({
    ...f,
    location: shareablePath(f.location, root),
    message: shareablePath(f.message, root),
  })).sort(compareFindings);
  if (sorted.length === 0) {
    return { name: 'findings', cases: [pass(JUNIT_FINDINGS_CLASS, 'no findings')] };
  }
  const names = uniqueNames(sorted.map((f) => `${f.ruleId} ${f.location}`));
  const cases = sorted.map((f, i): JUnitTestCase => {
    const name = names[i] ?? `${f.ruleId} ${f.location}`;
    const skip = findingSkip(f.level, driftGate);
    if (skip) return skipped(JUNIT_FINDINGS_CLASS, name, skip);
    return failure(JUNIT_FINDINGS_CLASS, name, f.level, f.message, findingBody(f));
  });
  return { name: 'findings', cases };
}

function where(file: string, line: number | undefined): string {
  return typeof line === 'number' ? `${file}:${line}` : file;
}

export function architectureGateSuite(
  input:
    | { status: 'blocked'; message: string }
    | { status: 'clean' }
    | { status: 'failed'; rows: readonly ArchitectureJUnitRow[] },
  root?: string,
): JUnitSuite {
  if (input.status === 'blocked') {
    return {
      name: 'architecture',
      cases: [failure(JUNIT_ARCHITECTURE_CLASS, 'architecture', 'gate', shareablePath(input.message, root))],
    };
  }
  if (input.status === 'clean') {
    return { name: 'architecture', cases: [pass(JUNIT_ARCHITECTURE_CLASS, 'architecture')] };
  }
  const rows = input.rows.map((r) => ({
    ...r,
    file: shareablePath(r.file, root),
    message: shareablePath(r.message, root),
  })).sort((a, b) =>
    cmp(a.file, b.file)
    || (a.line ?? 0) - (b.line ?? 0)
    || cmp(a.symbol, b.symbol)
    || cmp(a.rule, b.rule)
    || cmp(a.message, b.message),
  );
  const bases = rows.map((r) => `${r.rule} ${where(r.file, r.line)} ${r.symbol}`);
  const names = uniqueNames(bases);
  const cases = rows.map((r, i): JUnitTestCase => {
    const kind = r.severity === 'hard' ? 'violation' : 'warning';
    const line = `${where(r.file, r.line)}  ${r.symbol}  ${kind}: ${r.message} (${r.rule})`;
    const body = `${line}\npolicy: ${r.policy}`;
    return failure(JUNIT_ARCHITECTURE_CLASS, names[i] ?? bases[i] ?? r.rule, 'architecture', line, body);
  });
  return { name: 'architecture', cases };
}

export function securityNotEvaluatedMessage(gateName: string): string {
  return `${gateName}: no infrastructure findings were evaluated (module missing or --iac not requested)`;
}

export function securityUnavailableMessage(gateName: string, packs: readonly string[]): string {
  return `${gateName}: pack ${packs.join(', ')} is not available in the installed Architecture module (run \`vg module install arch\` to update it); no infrastructure findings were evaluated.`;
}

export function securityGateSuite(
  input:
    | { status: 'blocked'; message: string }
    | { status: 'evaluated'; findings: readonly SecurityJUnitFinding[]; failingIds: readonly string[] },
  root?: string,
): JUnitSuite {
  if (input.status === 'blocked') {
    return {
      name: 'security',
      cases: [failure(JUNIT_SECURITY_CLASS, 'security', 'gate', shareablePath(input.message, root))],
    };
  }
  const failing = new Set(input.failingIds);
  const findings = input.findings.map((f) => ({
    ...f,
    path: shareablePath(f.path, root),
    message: shareablePath(f.message, root),
  })).sort((a, b) =>
    cmp(a.path, b.path)
    || (a.line ?? 0) - (b.line ?? 0)
    || cmp(a.rule, b.rule)
    || cmp(a.id, b.id),
  );
  if (findings.length === 0) {
    return { name: 'security', cases: [pass(JUNIT_SECURITY_CLASS, 'security')] };
  }
  const bases = findings.map((f) => `${f.pack}/${f.rule} ${f.path}`);
  const names = uniqueNames(bases);
  const cases = findings.map((f, i): JUnitTestCase => {
    const name = names[i] ?? bases[i] ?? f.id;
    if (!failing.has(f.id)) return skipped(JUNIT_SECURITY_CLASS, name, SECURITY_SKIP_BELOW);
    const body = `${f.message}\nid: ${f.id}\nrule: ${f.pack}/${f.rule}\nlocation: ${where(f.path, f.line)}\nseverity: ${f.severity}`;
    return failure(JUNIT_SECURITY_CLASS, name, f.severity, f.message, body);
  });
  return { name: 'security', cases };
}

export function driftBudgetFlagCase(score: number | null, budget: number): JUnitTestCase {
  const result = compareDriftBudget(score, budget);
  if (result.exitCode === 2 && result.message) return failure(JUNIT_GATES_CLASS, 'drift-budget', 'gate', result.message);
  if (result.message) return skipped(JUNIT_GATES_CLASS, 'drift-budget', result.message);
  return pass(JUNIT_GATES_CLASS, 'drift-budget');
}

export function driftWorseningFlagCase(
  score: number | null,
  delta: number | undefined,
  limit: number,
): JUnitTestCase {
  if (score === null) {
    return skipped(JUNIT_GATES_CLASS, 'drift-worsening', 'DriftScore is absent; --drift-worsening was not compared.');
  }
  if (delta === undefined) {
    return failure(
      JUNIT_GATES_CLASS,
      'drift-worsening',
      'gate',
      'Failing fitness function: --drift-worsening requires --baseline to compare against previous drift.',
    );
  }
  if (delta > 0) {
    const baselineScore = score - delta;
    const denominator = Math.max(Math.abs(baselineScore), 0.0001);
    const worseningPercent = (delta / denominator) * 100;
    if (worseningPercent > limit) {
      return failure(
        JUNIT_GATES_CLASS,
        'drift-worsening',
        'gate',
        `Failing fitness function: drift worsened by ${worseningPercent.toFixed(2)}% (threshold ${limit}%).`,
      );
    }
  }
  return pass(JUNIT_GATES_CLASS, 'drift-worsening');
}

export function configDriftBudgetAbsentCase(): JUnitTestCase {
  return skipped(JUNIT_GATES_CLASS, 'drift-budget', DRIFT_BUDGET_ABSENT);
}

/**
 * One gate case per budget rule the local scan judges. Agent limits are left
 * out (the CLI does not evaluate them). A warn or shadow breach is skipped:
 * it is reported, and it does not fail the gate.
 */
export function configDriftBudgetCases(gate: DriftBudgetGateResult): JUnitTestCase[] {
  if (!gate.verdict) {
    if (gate.lines.length === 0) return [];
    return [skipped(JUNIT_GATES_CLASS, 'drift-budget', gate.lines.map((l) => l.text).join('\n'))];
  }
  const mode = gate.verdict.mode;
  const cases: JUnitTestCase[] = [];
  for (const rule of gate.verdict.rules) {
    if (rule.id === 'agents.maxWorseningPercent') continue;
    const name = `drift-budget ${rule.id}`;
    if (rule.status === 'pass') {
      cases.push(pass(JUNIT_GATES_CLASS, name));
    } else if (rule.status === 'not_evaluated') {
      const hint = rule.id === 'maxWorseningPercent' ? ' Run with --baseline to compare.' : '';
      cases.push(skipped(JUNIT_GATES_CLASS, name, `drift budget: ${rule.message}${hint}`));
    } else if (mode === 'enforce') {
      cases.push(failure(JUNIT_GATES_CLASS, name, 'gate', `drift budget (${mode}): ${rule.message}`));
    } else {
      cases.push(skipped(JUNIT_GATES_CLASS, name, `drift budget (${mode}): ${rule.message}`));
    }
  }
  return cases;
}

export function buildScanJUnitReport(input: ScanJUnitInput): JUnitReport {
  const suites: JUnitSuite[] = [findingsSuite(input.findings, input.driftGate, input.root)];
  for (const suite of input.extraSuites ?? []) {
    if (suite.cases.length > 0) suites.push(suite);
  }
  return { name: 'vg scan', suites };
}

const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function sanitize(value: string): string {
  return value.replace(ILLEGAL_XML, '');
}

function escapeXml(value: string): string {
  return sanitize(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function oneLine(value: string): string {
  return sanitize(value).replaceAll(/\r\n|\n|\r/g, ' ');
}

function count(cases: readonly JUnitTestCase[], status: JUnitStatus): number {
  let n = 0;
  for (const c of cases) if (c.status === status) n += 1;
  return n;
}

function renderCase(tc: JUnitTestCase): string {
  const open = `    <testcase classname="${escapeXml(tc.classname)}" name="${escapeXml(tc.name)}" time="0"`;
  if (tc.status === 'pass') return `${open}/>`;
  if (tc.status === 'skipped') {
    const message = escapeXml(oneLine(tc.message));
    if (tc.message.includes('\n')) {
      return `${open}>\n      <skipped message="${message}">${escapeXml(tc.message)}</skipped>\n    </testcase>`;
    }
    return `${open}>\n      <skipped message="${message}"/>\n    </testcase>`;
  }
  const body = tc.body ?? tc.message;
  return `${open}>\n      <failure message="${escapeXml(oneLine(tc.message))}" type="${escapeXml(tc.type)}">${escapeXml(body)}</failure>\n    </testcase>`;
}

function renderSuite(suite: JUnitSuite): string {
  const tests = suite.cases.length;
  const failures = count(suite.cases, 'failure');
  const skippedCount = count(suite.cases, 'skipped');
  const head = `  <testsuite name="${escapeXml(suite.name)}" tests="${tests}" failures="${failures}" errors="0" skipped="${skippedCount}" time="0">`;
  const body = suite.cases.map(renderCase).join('\n');
  return `${head}\n${body}\n  </testsuite>`;
}

/** Serialize a report. Identical input returns identical bytes. */
export function renderJUnitReport(report: JUnitReport): string {
  const cases = report.suites.flatMap((s) => s.cases);
  const tests = cases.length;
  const failures = count(cases, 'failure');
  const skippedCount = count(cases, 'skipped');
  const head = `<testsuites name="${escapeXml(report.name)}" tests="${tests}" failures="${failures}" errors="0" skipped="${skippedCount}" time="0">`;
  const body = report.suites.map(renderSuite).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${head}\n${body}\n</testsuites>\n`;
}

export function renderScanJUnit(input: ScanJUnitInput): string {
  return renderJUnitReport(buildScanJUnitReport(input));
}

export async function writeScanJUnit(filePath: string, input: ScanJUnitInput): Promise<void> {
  await writeTextFile(path.resolve(filePath), renderScanJUnit(input));
}
