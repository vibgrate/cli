// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Shared credential redaction (GUARDRAILS §1.1): applied at INGEST, before
 * anything is stored or uploaded. One detector, reused by the VCS capture, the
 * graph builder (signatures/docs), and the push envelope — so every surface
 * scrubs the same shapes and a new token prefix is added in exactly one place.
 */

const SECRET_PATTERNS: RegExp[] = [
  // Vendor token prefixes (GitHub, GitLab, Slack, OpenAI/Stripe-style, npm, AWS).
  /\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{8,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g,
  // JWTs.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+\b/g,
  // Authorization material.
  /\b(?:Bearer|Basic|VibgrateDSN)\s+[A-Za-z0-9+/._:=-]{8,}/g,
  /\b(?:authorization|api[_-]?key|apikey|access[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*['"]?[^'"\s]{6,}/gi,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Long base64/hex blobs (AWS secret keys and friends).
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

export const REDACTED = '[REDACTED]';

/** Replace every credential-shaped substring with [REDACTED]. Deterministic. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** True when the text contains at least one credential-shaped substring. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    return hit;
  });
}

const CREDENTIAL_QUERY_KEYS =
  /^(?:access[_-]?token|private[_-]?token|api[_-]?key|apikey|token|secret|password|passwd|auth|authorization|x-token|sig|signature|key)$/i;

/**
 * Strip credentials from a URL: userinfo (`//user:token@host`) AND
 * credential-bearing query parameters (`?access_token=…`, `?private_token=…`).
 * Non-URL strings pass through with just the userinfo strip applied.
 */
export function redactUrlCredentials(url: string): string {
  const noUser = url.replace(/\/\/[^@/]+@/, '//');
  const q = noUser.indexOf('?');
  if (q === -1) return noUser;
  const base = noUser.slice(0, q);
  const kept = noUser
    .slice(q + 1)
    .split('&')
    .filter((pair) => !CREDENTIAL_QUERY_KEYS.test(pair.split('=')[0] ?? ''));
  return kept.length ? `${base}?${kept.join('&')}` : base;
}
