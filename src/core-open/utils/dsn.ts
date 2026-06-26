// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
export interface ParsedDsn {
  keyId: string;
  secret: string;
  host: string;
  workspaceId: string;
  scheme: 'https' | 'http';
}

/**
 * Parse a Vibgrate DSN string into its constituent parts.
 * Format: vibgrate+https://<key_id>:<secret>@<host>/<workspace_id>
 */
export function parseDsn(dsn: string): ParsedDsn | null {
  // Strip invisible/control characters (CR, LF, BOM, zero-width, etc.) that may
  // sneak in from Windows .env files, clipboard pastes, or editor artifacts
  const cleaned = dsn
    .replace(/[\x00-\x1F\x7F\uFEFF\u200B-\u200D\u2060]/g, '')
    .trim();
  const match = cleaned.match(/^vibgrate\+(https?):?\/\/([^:]+):([^@]+)@([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    scheme: match[1] as 'https' | 'http',
    keyId: match[2]!,
    secret: match[3]!,
    host: match[4]!,
    workspaceId: match[5]!,
  };
}
