/**
 * Stable codes for degrade-and-continue warnings in build, scan, and report.
 *
 * A published code string does not change. A new site adds a constant in this
 * module — for example an unknown optional lockfile field — and does not reuse
 * a code that already means something else. Codes are fixed tokens: they never
 * include a path, file contents, or a secret. Those details stay in the
 * message, which the caller keeps free of credentials.
 *
 * When several warnings fire, {@link stableWarningRecords} orders them by code
 * then message so the same inputs always emit the same sequence.
 */

export const WarningCodes = {
  /** A source file threw during parse. The build keeps the other files. */
  PARSE_DEGRADE: 'VG_WARN_PARSE_DEGRADE',
  /** A file was over the size cap and was not read. */
  SKIPPED_FILE: 'VG_WARN_SKIPPED_FILE',
  /** A directory or scan path was skipped and the rest of the tree continued. */
  SKIPPED_SUBTREE: 'VG_WARN_SKIPPED_SUBTREE',
  /** The TypeScript resolver was skipped; the heuristic resolver still ran. */
  TSC_SKIPPED: 'VG_WARN_TSC_SKIPPED',
  /** Infrastructure or CI extraction degraded for one file. */
  TOOLCHAIN_DEGRADE: 'VG_WARN_TOOLCHAIN_DEGRADE',
  /** A component stayed in the SBOM and its Package URL was omitted. */
  PURL_UNAVAILABLE: 'VG_WARN_PURL_UNAVAILABLE',
  /** A declared license did not resolve, or could not be written on an SBOM. */
  LICENSE_UNPARSEABLE: 'VG_WARN_LICENSE_UNPARSEABLE',
  /** A CVSS vector was present and did not parse. The advisory is kept. */
  CVSS_UNPARSEABLE: 'VG_WARN_CVSS_UNPARSEABLE',
  /** An SBOM merge dropped or guessed a fact and still wrote the component. */
  SBOM_MERGE: 'VG_WARN_SBOM_MERGE',
  /** A baseline file could not be read. The scan continued without a delta. */
  BASELINE_UNREADABLE: 'VG_WARN_BASELINE_UNREADABLE',
  /** One project scanner failed and that project was skipped. */
  SCAN_DEGRADE: 'VG_WARN_SCAN_DEGRADE',
} as const;

export type WarningCode = (typeof WarningCodes)[keyof typeof WarningCodes];

const CODE_SET: ReadonlySet<string> = new Set(Object.values(WarningCodes));

export function isWarningCode(value: string): value is WarningCode {
  return CODE_SET.has(value);
}

/** Every published code, in sorted order. This module is the only definition. */
export function publishedWarningCodes(): WarningCode[] {
  return (Object.values(WarningCodes) as WarningCode[]).slice().sort();
}

export interface WarningRecord {
  code: WarningCode;
  /** Actionable prose. The code is not repeated in this field. */
  message: string;
}

/** `VG_WARN_…: message` — stderr lines and string warning channels. */
export function renderWarning(record: WarningRecord): string {
  return `${record.code}: ${record.message}`;
}

/** Same as {@link renderWarning}, for call sites that have the two parts. */
export function degradeLine(code: WarningCode, message: string): string {
  return renderWarning({ code, message });
}

/** Parse-pool / worker warning. The code is on the string; the message stays `parse failed:`. */
export function parseDegradeWarning(errMessage: string): string {
  return renderWarning({
    code: WarningCodes.PARSE_DEGRADE,
    message: `parse failed: ${errMessage}`,
  });
}

/**
 * Split a rendered warning. A legacy line that is not `CODE: message`
 * returns null so the caller can classify it.
 */
export function parseRenderedWarning(line: string): WarningRecord | null {
  const sep = line.indexOf(': ');
  if (sep <= 0) return null;
  const code = line.slice(0, sep);
  if (!isWarningCode(code)) return null;
  return { code, message: line.slice(sep + 2) };
}

/** True for a failed parse, including a warning already prefixed with its code. */
export function isParseFailureWarning(warning: string): boolean {
  const parsed = parseRenderedWarning(warning);
  const message = parsed?.code === WarningCodes.PARSE_DEGRADE ? parsed.message : warning;
  return message.startsWith('parse failed:');
}

/** Stable order: code, then message. Identical pairs collapse to one. */
export function stableWarningRecords(records: readonly WarningRecord[]): WarningRecord[] {
  const sorted = records.slice().sort((a, b) => {
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    if (a.message < b.message) return -1;
    if (a.message > b.message) return 1;
    return 0;
  });
  const out: WarningRecord[] = [];
  for (const record of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.code === record.code && prev.message === record.message) continue;
    out.push(record);
  }
  return out;
}

/** Unique codes that fired, sorted. Empty when nothing fired. */
export function warningCodeSummary(records: readonly WarningRecord[]): string {
  const codes: WarningCode[] = [];
  for (const record of records) {
    if (!codes.includes(record.code)) codes.push(record.code);
  }
  codes.sort();
  return codes.join(', ');
}

/** Warn code stored on a finding, or on a nested CVSS diagnostic. */
export function findingWarnCode(details: Record<string, unknown> | null | undefined): WarningCode | null {
  if (!details) return null;
  const direct = details.warnCode;
  if (typeof direct === 'string' && isWarningCode(direct)) return direct;
  const diag = details.cvssDiagnostic;
  if (diag && typeof diag === 'object') {
    const nested = (diag as { warnCode?: unknown }).warnCode;
    if (typeof nested === 'string' && isWarningCode(nested)) return nested;
  }
  return null;
}

/** Rule id for a human line, with the warn code when the finding carries one. */
export function ruleWithWarnCode(ruleId: string, details?: Record<string, unknown> | null): string {
  const code = findingWarnCode(details);
  return code ? `${ruleId} ${code}` : ruleId;
}

/**
 * Plain lines for a report. Already-stable input stays in that order; this
 * sorts again so a hand-written artifact cannot reshuffle the block.
 */
export function degradeWarningBlock(
  records: ReadonlyArray<{ code: string; message: string }> | undefined,
): string[] {
  if (!records?.length) return [];
  const sorted = records.slice().sort((a, b) => {
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    if (a.message < b.message) return -1;
    if (a.message > b.message) return 1;
    return 0;
  });
  const lines = ['Degrade warnings'];
  const seen = new Set<string>();
  for (const record of sorted) {
    const line = `  ${record.code}: ${record.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}
