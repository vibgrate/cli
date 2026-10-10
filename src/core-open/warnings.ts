// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { compareCodeUnit } from './utils/compare.js';

/**
 * Stable codes for degrade-and-continue warnings on `vg build`, `vg scan`,
 * `vg report`, and `vg sbom`.
 *
 * A published code keeps its meaning. Add a new entry here for a new
 * condition, then emit it from the call site. Do not reuse or rewrite a
 * code that has shipped. Codes are identifiers only: they never embed a
 * path, a secret, or file contents.
 *
 * A truncated or invalid lockfile stops the command. It is not a warning.
 * A later warn-and-continue lockfile condition adds one entry to this
 * object and one emit site.
 */

export const WARNING_CODES = {
  /** A source file failed to parse. The build continues without its symbols. */
  PARSE_FAILED: 'VG_WARN_PARSE_FAILED',
  /** A file exceeded the per-file size cap and was left out of the map. */
  BUILD_FILE_OVERSIZE: 'VG_WARN_BUILD_FILE_OVERSIZE',
  /** The TypeScript resolver was skipped because the corpus exceeded its file cap. */
  TSC_RESOLVER_SKIPPED: 'VG_WARN_TSC_RESOLVER_SKIPPED',
  /** YAML for an infrastructure file failed to parse. */
  YAML_PARSE_FAILED: 'VG_WARN_YAML_PARSE_FAILED',
  /** A YAML document in a stream had errors and was skipped. */
  YAML_DOCUMENT_SKIPPED: 'VG_WARN_YAML_DOCUMENT_SKIPPED',
  /** A YAML document could not be materialised. */
  YAML_DOCUMENT_UNMATERIALISED: 'VG_WARN_YAML_DOCUMENT_UNMATERIALISED',
  /** An infrastructure extractor threw. That file contributes no structure. */
  TOOLCHAIN_EXTRACTION_FAILED: 'VG_WARN_TOOLCHAIN_EXTRACTION_FAILED',
  /** An extractor stopped at the per-file node cap. */
  TOOLCHAIN_NODE_CAP: 'VG_WARN_TOOLCHAIN_NODE_CAP',
  /** The HCL grammar was unavailable, so no Terraform structure was extracted. */
  HCL_GRAMMAR_UNAVAILABLE: 'VG_WARN_HCL_GRAMMAR_UNAVAILABLE',
  /** HCL parse produced no tree. */
  HCL_NO_TREE: 'VG_WARN_HCL_NO_TREE',
  /** HCL parse recovered from a syntax error. Extraction may be partial. */
  HCL_PARTIAL: 'VG_WARN_HCL_PARTIAL',
  /** A workflow job listed more steps than the extractor enumerates. */
  WORKFLOW_STEP_CAP: 'VG_WARN_WORKFLOW_STEP_CAP',
  /** A scan path timed out and was skipped. */
  SCAN_PATH_SKIPPED: 'VG_WARN_SCAN_PATH_SKIPPED',
  /** A scan file exceeded the size cap and was skipped. */
  SCAN_FILE_OVERSIZE: 'VG_WARN_SCAN_FILE_OVERSIZE',
  /** A baseline file could not be read. The scan continues without a comparison. */
  BASELINE_UNREADABLE: 'VG_WARN_BASELINE_UNREADABLE',
  /** A declared license string could not be resolved to SPDX. */
  LICENSE_UNPARSEABLE: 'VG_WARN_LICENSE_UNPARSEABLE',
  /** A declared license cannot be represented in an SBOM. */
  LICENSE_UNREPRESENTABLE: 'VG_WARN_LICENSE_UNREPRESENTABLE',
  /** A CVSS vector was present and could not be parsed. */
  CVSS_UNPARSEABLE: 'VG_WARN_CVSS_UNPARSEABLE',
  /** A package URL could not be formed. The component is included without a purl. */
  PURL_UNAVAILABLE: 'VG_WARN_PURL_UNAVAILABLE',
  /** SBOM merge dropped a different dependency list for one package. */
  SBOM_LOSSY_EDGES: 'VG_WARN_SBOM_LOSSY_EDGES',
  /** SBOM merge dropped differing manifest metadata for one package. */
  SBOM_LOSSY_MANIFEST: 'VG_WARN_SBOM_LOSSY_MANIFEST',
  /** SBOM merge recorded an unknown ecosystem as npm. */
  SBOM_UNKNOWN_ECOSYSTEM: 'VG_WARN_SBOM_UNKNOWN_ECOSYSTEM',
  /** A lockfile format does not record dependency edges. */
  SBOM_UNTRACKED_EDGES: 'VG_WARN_SBOM_UNTRACKED_EDGES',
} as const;

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];

export interface CodedWarning {
  code: WarningCode;
  /** Human prose. The code lives in {@link CodedWarning.code}, not in this string. */
  message: string;
}

const CODE_LIST: readonly WarningCode[] = Object.values(WARNING_CODES);
const CODE_SET: ReadonlySet<string> = new Set(CODE_LIST);

/** Every published code, in registry order. */
export function warningCodeList(): readonly WarningCode[] {
  return CODE_LIST;
}

export function isWarningCode(value: unknown): value is WarningCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

export function codedWarning(code: WarningCode, message: string): CodedWarning {
  return { code, message };
}

/**
 * Human line. The code is a stable token at the front so a search for
 * `VG_WARN_` does not depend on the prose.
 */
export function formatWarningLine(warning: CodedWarning): string {
  return `warning [${warning.code}]: ${warning.message}`;
}

/**
 * Store a code on a string channel that already carries prose.
 * The prose stays a prefix so existing substring checks still match.
 */
export function stampWarning(code: WarningCode, message: string): string {
  return `${message} [${code}]`;
}

const STAMP_RE = / \[VG_WARN_[A-Z0-9_]+\]$/;

/** Split a stamped string. Returns undefined when the line has no known code. */
export function splitStampedWarning(stored: string): CodedWarning | undefined {
  const match = STAMP_RE.exec(stored);
  if (!match) return undefined;
  const code = match[0].slice(2, -1);
  if (!isWarningCode(code)) return undefined;
  return { code, message: stored.slice(0, match.index) };
}

/**
 * Order by code, then by message, in code-unit order (not the process locale).
 * Equal pairs keep their input order (the runtime sort is stable).
 */
export function sortCodedWarnings(warnings: readonly CodedWarning[]): CodedWarning[] {
  return [...warnings].sort((a, b) => compareCodeUnit(a.code, b.code) || compareCodeUnit(a.message, b.message));
}

/**
 * Path text safe to put in a warning message: a repo-relative path, or the
 * file name when the path would leave the repo or is absolute. Never file
 * contents.
 */
export function warningPathLabel(rel: string): string {
  const posix = rel.split('\\').join('/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || posix.startsWith('..') || posix === '') {
    const base = posix.split('/').pop();
    return base && base.length > 0 ? base : 'path';
  }
  return posix;
}

export function findingWarningCode(details: unknown): WarningCode | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const record = details as { warnCode?: unknown; cvssDiagnostic?: { warnCode?: unknown } | null };
  if (isWarningCode(record.warnCode)) return record.warnCode;
  const nested = record.cvssDiagnostic?.warnCode;
  if (isWarningCode(nested)) return nested;
  return undefined;
}

/** Rule id for a text or markdown row, with the warning code when one is set. */
export function findingRuleLabel(ruleId: string, details: unknown): string {
  const code = findingWarningCode(details);
  return code ? `${ruleId} [${code}]` : ruleId;
}

/** Plain warning lines for a report. Empty when the field is absent. */
export function formatDegradationLines(degradations: readonly CodedWarning[] | undefined): string[] {
  if (!degradations || degradations.length === 0) return [];
  return degradations.map((warning) => formatWarningLine(warning));
}
