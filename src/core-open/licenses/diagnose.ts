/**
 * User-facing diagnostic when a declared license string cannot be parsed as an
 * SPDX id or expression.
 *
 * A recognized id, alias, or fuzzy family match stays quiet — fuzzy is a
 * successful family guess, not a parse failure. Explicit no-assertion tokens
 * (`NOASSERTION`, `NONE`, `unknown`, `n/a`) are recognized and stay quiet too.
 *
 * The message names the failed string and the manifest path. It is one line,
 * length-capped, and scrubbed of credential-shaped text. It never includes a
 * file body.
 */
import { redactSecrets } from '../utils/redact.js';
import { normalizeLicense, unresolvedConstituentIds } from './normalize.js';

/** Stable code for an unparseable license id. Same text on every run. */
export const LICENSE_UNPARSEABLE_CODE = 'vibgrate/license-unparseable';

/** How much of the declared string a message may repeat. */
const DISPLAY_LIMIT = 80;

const RECOGNIZED_UNKNOWN = /^(unknown|noassertion|none|n\/a)$/i;

export interface LicenseParseDiagnostic {
  code: typeof LICENSE_UNPARSEABLE_CODE;
  /** Truncated, secret-redacted declared string. */
  raw: string;
  /** Repo-relative manifest path supplied by the caller. */
  path: string;
  message: string;
}

/**
 * Repo-relative path of the manifest that declared the license.
 * Node projects point at `package.json`; other ecosystems keep the project
 * directory, which is the evidence path the scanner recorded.
 */
export function manifestRelativePath(projectPath: string, projectType: string): string {
  const dir = (projectPath || '.').replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  if (projectType !== 'node' && projectType !== 'typescript') return dir;
  return dir === '.' ? 'package.json' : `${dir}/package.json`;
}

/** First line only, credentials removed, capped so a file body cannot spill out. */
export function displayLicenseText(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const single = redactSecrets(firstLine).replace(/[ \t]+/g, ' ').trim();
  if (single.length <= DISPLAY_LIMIT) return single;
  return `${single.slice(0, DISPLAY_LIMIT - 3)}...`;
}

/**
 * One diagnostic when `raw` is non-empty and does not resolve, or when a
 * constituent id inside an expression does not resolve. `null` for empty
 * input, recognized no-assertion tokens, exact ids, aliases, and fuzzy matches.
 */
export function diagnoseLicenseParse(
  raw: string | null | undefined,
  manifestPath: string,
  subject?: string,
): LicenseParseDiagnostic | null {
  const input = (raw ?? '').trim();
  if (!input || RECOGNIZED_UNKNOWN.test(input)) return null;

  const verdict = normalizeLicense(input);
  if (verdict.matchStatus === 'fuzzy') return null;

  const unresolved = unresolvedConstituentIds(input);
  if (verdict.matchStatus !== 'unknown' && unresolved.length === 0) return null;

  const shown = displayLicenseText(input);
  const path = manifestPath.trim() || '.';
  const who = subject ? ` for ${displayLicenseText(subject)}` : '';
  const next = 'Use an SPDX identifier or expression such as MIT or Apache-2.0.';
  const message =
    unresolved.length > 0
      ? `Unparseable license ${unresolved.length === 1 ? 'id' : 'ids'} ${unresolved
          .map((id) => `"${displayLicenseText(id)}"`)
          .join(', ')} in "${shown}"${who} at ${path}. ${next}`
      : `Unparseable license "${shown}"${who} at ${path}. ${next}`;

  return {
    code: LICENSE_UNPARSEABLE_CODE,
    raw: shown,
    path,
    message,
  };
}
