/**
 * Secret-safe file access for the VG Code agent (VG-CLI-CODE §13, GUARDRAILS §1.1).
 *
 * The agent reads files and hands them to a model — which, for a hosted model,
 * means they leave the machine. So a coding agent that will happily open `.env`
 * or a private key and paste it into a prompt is a credential-egress bug. Two
 * defenses, applied at the boundary (before anything reaches the model):
 *
 *  1. **Refuse** to read files that exist only to hold secrets (`.env`, key
 *     material, `.npmrc`, `.netrc`, cloud credentials…).
 *  2. **Redact** credential shapes from the content of any file we *do* read —
 *     token prefixes, `Authorization` headers, and `NAME_KEY=value` style
 *     assignments — so a stray secret in an otherwise-normal file is masked.
 *
 * Pure and unit-tested; no I/O here.
 */

/** Files whose whole purpose is secrets — never read them into a prompt. */
const SECRET_FILE = new RegExp(
  [
    String.raw`(^|/)\.env(\.[\w.-]+)?$`, // .env, .env.local, .env.production
    String.raw`(^|/)\.npmrc$`,
    String.raw`(^|/)\.netrc$`,
    String.raw`(^|/)\.pgpass$`,
    String.raw`(^|/)\.git-credentials$`,
    String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)$`,
    String.raw`\.pem$`,
    String.raw`\.key$`,
    String.raw`\.p12$`,
    String.raw`\.pfx$`,
    String.raw`(^|/)credentials(\.json)?$`, // aws credentials, gcloud
    String.raw`(^|/)\.aws/credentials$`,
    String.raw`(^|/)secrets?\.(ya?ml|json|toml|env)$`,
  ].join('|'),
  'i',
);

/** Whether a path should never be read into a model prompt. */
export function isSecretPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return SECRET_FILE.test(normalized);
}

/** A one-line, actionable refusal message for a blocked read. */
export function secretRefusal(file: string): string {
  return `refusing to read ${file} — it looks like a secrets/credentials file, and this content would be sent to the model. Reference the values by name instead, or read a non-secret file.`;
}

// Known credential token prefixes (same family the ingest redaction guards).
const TOKEN_SHAPES = /\b(sk|pk|rk|xoxb|xoxp|ghp|gho|ghs|ghu|glpat|AKIA|ASIA|AIza|ya29|hf|nvapi|sk-ant|sk-or)[-_][A-Za-z0-9\-_./+]{8,}/g;
const BEARER = /\b(Authorization|Bearer|token|api[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9\-_./+]{12,}['"]?/gi;
// `NAME_KEY=secret`, `PASSWORD: "…"`, connection strings — mask the value only.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|ACCESS|SESSION)[A-Za-z0-9_]*)\s*([:=])\s*['"]?([^\s'";,]{6,})/gi;
const URL_AUTH = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]+):([^@/\s]+)@/gi;

/**
 * Redact credential shapes from text before it reaches the model. Masks the
 * secret value, never the surrounding structure, so the model still sees that a
 * key exists (and its name) without seeing the value.
 */
export function redactText(text: string): string {
  return text
    .replace(URL_AUTH, '$1$2:***redacted***@')
    .replace(TOKEN_SHAPES, (_m, prefix) => `${prefix}-***redacted***`)
    .replace(BEARER, (_m, k) => `${k}: ***redacted***`)
    .replace(ASSIGNMENT, (_m, name, op) => `${name}${op}***redacted***`);
}
