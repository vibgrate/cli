// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Stable order for findings arrays in `vg scan` JSON and SARIF.
 *
 * Discovery walks the tree with concurrent `readdir` calls, so project order
 * (and therefore the order `generateFindings` appends rows) can follow
 * filesystem iteration. Map and Set iteration must not leak into the document
 * either. `orderArtifactFindings` runs after paths are made portable and
 * before JSON or SARIF is written, so both formats share one order.
 *
 * Drift and vulnerability findings (`ScanArtifact.findings`) sort by:
 *   1. rule id
 *   2. location (repo-relative path, or the package name for a vulnerability)
 *   3. message
 *   4. advisory id, package name, then package URL from `details`, when set
 *   5. level (error, warning, note)
 *
 * Comparison is code-unit order, not `localeCompare`, so the process locale
 * cannot change the result. The sort is stable: rows that tie on every key
 * keep their incoming order. No clock and no random id is added.
 *
 * `details.aliases` is an unordered set of ids. It is sorted the same way.
 * `fixedVersions` stays in the order the scanner recorded ranges.
 *
 * Security-pack findings keep their contract order: path, line, address,
 * rule, id. Absent line sorts with 0. `owasp`, `cwe`, and `cis` are id sets
 * and are sorted. Reachability findings sort by ecosystem, package, advisory
 * id, symbol, then version.
 *
 * The text report does not print this order. It groups errors, then warnings,
 * then notes, and keeps this order inside each group (`findingsForTerminal`).
 */
import type {
  Finding,
  ScanArtifact,
  ScanReachabilityFinding,
  SecurityFinding,
} from './types.js';

/** Code-unit order. Independent of the process locale. */
export function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Copy of `values` in code-unit order. */
export function sortCodeUnit(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnit);
}

function detailString(details: Finding['details'], key: string): string {
  const value = details?.[key];
  return typeof value === 'string' ? value : '';
}

const LEVEL_RANK: Record<Finding['level'], number> = { error: 0, warning: 1, note: 2 };

/**
 * Machine order for drift and vulnerability findings.
 * See the module comment for the key.
 */
export function compareScanFindings(a: Finding, b: Finding): number {
  return compareCodeUnit(a.ruleId, b.ruleId)
    || compareCodeUnit(a.location, b.location)
    || compareCodeUnit(a.message, b.message)
    || compareCodeUnit(detailString(a.details, 'advisoryId'), detailString(b.details, 'advisoryId'))
    || compareCodeUnit(detailString(a.details, 'package'), detailString(b.details, 'package'))
    || compareCodeUnit(detailString(a.details, 'purl'), detailString(b.details, 'purl'))
    || (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

/** Contract order for `extended.security.findings`: path, line, address, rule, id. */
export function compareSecurityFindings(a: SecurityFinding, b: SecurityFinding): number {
  const addressA = a.address ?? '';
  const addressB = b.address ?? '';
  return compareCodeUnit(a.path, b.path)
    || ((a.line ?? 0) - (b.line ?? 0))
    || compareCodeUnit(addressA, addressB)
    || compareCodeUnit(a.rule, b.rule)
    || compareCodeUnit(a.id, b.id);
}

/** Reachability order: ecosystem, package, advisory id, symbol, version. */
export function compareReachabilityFindings(a: ScanReachabilityFinding, b: ScanReachabilityFinding): number {
  return compareCodeUnit(a.ecosystem, b.ecosystem)
    || compareCodeUnit(a.package, b.package)
    || compareCodeUnit(a.advisoryId, b.advisoryId)
    || compareCodeUnit(a.symbol ?? '', b.symbol ?? '')
    || compareCodeUnit(a.version, b.version);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sortedAliases(finding: Finding): Finding {
  const aliases = finding.details?.aliases;
  if (!Array.isArray(aliases) || aliases.length < 2) return finding;
  if (!aliases.every((item) => typeof item === 'string')) return finding;
  const sorted = sortCodeUnit(aliases);
  if (sameStrings(sorted, aliases)) return finding;
  return { ...finding, details: { ...finding.details, aliases: sorted } };
}

const SECURITY_ID_LISTS = ['owasp', 'cwe', 'cis'] as const;

function sortedSecurityFinding(finding: SecurityFinding): SecurityFinding {
  let next: SecurityFinding | undefined;
  for (const key of SECURITY_ID_LISTS) {
    const list = finding[key];
    if (!list || list.length < 2) continue;
    const sorted = sortCodeUnit(list);
    if (sameStrings(sorted, list)) continue;
    next ??= { ...finding };
    next[key] = sorted;
  }
  return next ?? finding;
}

/** Drift and vulnerability findings in machine order, with alias lists sorted. */
export function sortScanFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].map(sortedAliases).sort(compareScanFindings);
}

/**
 * Sort every findings array on the artifact, in place.
 * Call this once, after portable paths are applied and before serialize.
 */
export function orderArtifactFindings(artifact: ScanArtifact): ScanArtifact {
  artifact.findings = sortScanFindings(artifact.findings);
  const security = artifact.extended?.security;
  if (security && Array.isArray(security.findings)) {
    security.findings = security.findings.map(sortedSecurityFinding).sort(compareSecurityFindings);
  }
  const reachability = artifact.reachability;
  if (reachability && Array.isArray(reachability.findings)) {
    reachability.findings = [...reachability.findings].sort(compareReachabilityFindings);
  }
  return artifact;
}

const TERMINAL_RANK: Record<string, number> = { error: 0, warning: 1, note: 2 };

/**
 * Order for the human text report: errors, then warnings, then notes.
 * Rows inside one level stay in the artifact's machine order.
 */
export function findingsForTerminal<T extends { level: string }>(findings: readonly T[]): T[] {
  const buckets: T[][] = [[], [], []];
  const rest: T[] = [];
  for (const finding of findings) {
    const rank = TERMINAL_RANK[finding.level];
    if (rank === undefined) rest.push(finding);
    else buckets[rank]!.push(finding);
  }
  return [...buckets[0]!, ...buckets[1]!, ...buckets[2]!, ...rest];
}
