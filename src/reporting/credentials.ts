/**
 * Local credential storage for `vibgrate login`.
 *
 * The DSN minted by the browser login flow is cached in
 * `~/.vibgrate/credentials.json` so subsequent `scan`/`push` runs are
 * authenticated without re-pasting a secret. DSN resolution precedence is:
 *   1. an explicit `--dsn` flag
 *   2. the `VIBGRATE_DSN` environment variable (CI / automation)
 *   3. the stored login credential
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface StoredCredentials {
  dsn: string;
  workspaceId?: string;
  keyId?: string;
  ingestHost?: string;
  savedAt: string;
}

export function credentialsDir(): string {
  return path.join(os.homedir(), '.vibgrate');
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), 'credentials.json');
}

/**
 * The `.gitignore` line that keeps the stored credentials out of version
 * control. When the credentials file lives inside `repoRoot` (e.g. a CI setup
 * where `$HOME` is the checkout), we ignore it by its exact repo-relative path;
 * otherwise we fall back to the conventional `.vibgrate/credentials.json` so a
 * future local copy is still covered. The fallback is intentionally specific —
 * it must NOT shadow `.vibgrate/graph.json`, which `vg share` commits.
 */
export function gitignoreEntryForCredentials(repoRoot: string): string {
  const rel = path.relative(repoRoot, credentialsPath());
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return '.vibgrate/credentials.json';
}

export function readStoredCredentials(): StoredCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredCredentials;
    return parsed && typeof parsed.dsn === 'string' && parsed.dsn ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredCredentials(creds: StoredCredentials): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = credentialsPath();
  // Created 0600 from the first byte — a default-umask write would leave the
  // token world-readable until the later chmod lands.
  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // Best-effort: restrict to the owner (no-op on platforms without POSIX perms).
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export function clearStoredCredentials(): boolean {
  try {
    fs.rmSync(credentialsPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the DSN to use for an authenticated operation, honoring the precedence
 * above. Returns undefined when no credential is available anywhere.
 */
export function resolveDsn(explicitDsn?: string): string | undefined {
  if (explicitDsn) return explicitDsn;
  if (process.env.VIBGRATE_DSN) return process.env.VIBGRATE_DSN;
  return readStoredCredentials()?.dsn ?? undefined;
}
