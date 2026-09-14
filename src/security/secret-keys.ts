/**
 * Secret-shaped keys — the definition shared with the Architecture module
 * (`packages/vibgrate-haile/docs/facts.md` §2.3).
 *
 * The host uses it at ingest to redact Terraform literals under such keys
 * (`{ redacted: true }` — presence kept, value dropped, GUARDRAILS §1.1); the
 * module uses the same list for its plaintext-secret rule. Both sides pin the
 * same twelve examples in their tests, so a change here is a change to both.
 */

const SECRET_MARKERS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'access_key',
  'client_secret',
  'credential',
] as const;

/** Suffixes that name something *about* a secret (its file, its id) rather than the secret. */
const BENIGN_SUFFIXES = [
  '_file',
  '_path',
  '_url',
  '_uri',
  '_name',
  '_id',
  '_enabled',
  '_ttl',
  '_expiry',
  '_header',
  '_length',
  '_count',
] as const;

/**
 * Is this attribute / variable key secret-shaped?
 *
 * True when the lowercase key contains one of the secret markers and does not
 * end with one of the benign suffixes. Pure and deterministic.
 */
export function isSecretShapedKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (!SECRET_MARKERS.some((marker) => lower.includes(marker))) return false;
  return !BENIGN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
