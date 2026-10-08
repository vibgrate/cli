// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Diagnostic for a declared license that failed SPDX resolution.
 *
 * `normalizeLicense` stays tolerant: a bad string still finishes as
 * `matchStatus: 'unknown'` / `NOASSERTION`, and a partially resolved
 * expression stays `expression`. Callers that print only `spdxId` then skip
 * `unknown`, which drops the failure with no trace. This module is the
 * trace: one stable code, the truncated declared string, and the
 * manifest-relative path.
 *
 * An explicit unknown (`NOASSERTION`, `unknown`, `none`, `n/a`, or empty)
 * is not a failure. A fuzzy family match is not a failure either. A valid
 * custom LicenseRef (`LicenseRef-` plus letters, digits, `.`, and `-`) is
 * an exact id, not a failure. An invalid reference still is.
 */

import { isExplicitUnknownLicense, normalizeLicense } from './normalize.js';
import { parseLicenseExpression } from './spdx-expression.js';
import { WARNING_CODES, type WarningCode } from '../warnings.js';

/** Stable code for scan, report, SARIF, and SBOM. Identical for every failure. */
export const LICENSE_PARSE_FAILED = 'vibgrate/license-parse-failed';

/** How much of the declared license string a diagnostic may repeat. */
export const LICENSE_RAW_LIMIT = 120;

export interface LicenseParseDiagnostic {
  code: typeof LICENSE_PARSE_FAILED;
  /** Degrade-and-continue warning code. `code` stays the finding rule id. */
  warnCode: WarningCode;
  /** Actionable, deterministic text. No file body and no credential. */
  message: string;
  /** Manifest-relative path the declaration was read from. */
  location: string;
  /** Truncated, credential-redacted declared license string. */
  raw: string;
}

const REDACTED = '[REDACTED]';

/**
 * Credential shapes only. The shared ingest redactor also blanks long
 * base64-like runs, which would hide a long license string; this pass does
 * not. Deterministic.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{8,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._:=-]{8,}/g,
  /\/\/[^/\s@]+@/g,
];

function redactLicenseText(value: string): string {
  let out = value;
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

function truncateLicense(value: string): string {
  if (value.length <= LICENSE_RAW_LIMIT) return value;
  return `${value.slice(0, LICENSE_RAW_LIMIT - 1)}…`;
}

/**
 * Declared license text safe to repeat in a warning: trimmed, credential-redacted,
 * and truncated. Same rules as a parse diagnostic.
 */
export function declaredLicenseSnippet(raw: string): string {
  return truncateLicense(redactLicenseText(raw.trim()));
}

function expressionHasUnresolvedId(input: string): boolean {
  const parsed = parseLicenseExpression(input);
  return parsed.licenseIds.some((id) => normalizeLicense(id).matchStatus === 'unknown');
}

/**
 * One diagnostic when `raw` is a non-empty license that does not resolve, or
 * an expression that contains a constituent id that does not resolve.
 * Returns null for an explicit unknown, a fuzzy match, and a fully resolved
 * id or expression. Same inputs always return the same object.
 */
export function licenseParseDiagnostic(
  raw: string | null | undefined,
  manifestPath: string,
  packageName?: string,
): LicenseParseDiagnostic | null {
  if (isExplicitUnknownLicense(raw)) return null;
  const input = (raw ?? '').trim();
  const verdict = normalizeLicense(input);
  const unresolvedExpression =
    verdict.matchStatus === 'expression' && expressionHasUnresolvedId(input);
  if (verdict.matchStatus !== 'unknown' && !unresolvedExpression) return null;

  const shown = truncateLicense(redactLicenseText(input));
  const pkg = packageName?.trim();
  const where = pkg ? `for ${pkg} at ${manifestPath}` : `at ${manifestPath}`;
  const message =
    `Could not resolve SPDX license "${shown}" ${where}. ` +
    'Replace it with a canonical SPDX id or expression, or NOASSERTION if the license is intentionally unknown.';
  return {
    code: LICENSE_PARSE_FAILED,
    warnCode: WARNING_CODES.LICENSE_UNPARSEABLE,
    message,
    location: manifestPath,
    raw: shown,
  };
}
