/**
 * DNS-rebinding protection for the local `vg serve --http` endpoint, per the
 * MCP 2025-11-25 transport spec: a browser reaching a localhost server via a
 * rebound hostname still sends the *attacker's* Origin, so policing Origin is
 * the boundary that keeps drive-by pages from reading the local map.
 *
 * Policy: no Origin header (CLI/native MCP clients) passes; a browser-set
 * Origin must be loopback (localhost / 127.0.0.0/8 / [::1]) or on the
 * comma-separated `VIBGRATE_ALLOWED_ORIGINS` allowlist (`*` allows all —
 * an explicit operator escape hatch, never the default).
 */
export function originAllowed(origin: string | undefined, allowlist?: string): boolean {
  if (origin === undefined || origin === '') return true;
  const allowed = (allowlist ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes('*')) return true;
  if (allowed.includes(origin)) return true;
  return isLoopbackOrigin(origin);
}

function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // unparsable Origin ("null", garbage) is never trusted
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
