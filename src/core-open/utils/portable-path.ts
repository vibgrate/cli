// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Paths in machine-readable output.
 *
 * Default JSON, SARIF, and report output must not carry an absolute home
 * directory (`/Users/…` or `/home/…`). A path inside the scan or build root
 * becomes root-relative. The same inputs always produce the same relative
 * path: no clock, no locale, and no dependence on which account ran the tool.
 */
import path from 'node:path';

/** Absolute home prefix, not a URL path segment (`docs/home/…` does not match). */
const HOME_PATH = /(?<![\w:])\/(?:Users|home)\/[^\s"'`<>|]+/g;

const HOME_ROOT = /^\/(?:Users|home)\/[^/]+/;

export function portableValue<T>(value: T, root?: string): T {
  if (!containsHomePath(value)) return value;
  return rewrite(value, normalizeRoot(root)) as T;
}

/** Rewrite one string. Exported for tests of a single path. */
export function portablePath(value: string, root?: string): string {
  return stripHomePrefixes(value, normalizeRoot(root));
}

function mentionsHome(text: string): boolean {
  return text.includes('/Users/') || text.includes('/home/');
}

function containsHomePath(value: unknown): boolean {
  if (typeof value === 'string') return mentionsHome(value);
  if (Array.isArray(value)) return value.some((item) => containsHomePath(item));
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (mentionsHome(key) || containsHomePath(child)) return true;
  }
  return false;
}

function rewrite(value: unknown, root: string | undefined): unknown {
  if (typeof value === 'string') return stripHomePrefixes(value, root);
  if (Array.isArray(value)) return value.map((item) => rewrite(item, root));
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    out[stripHomePrefixes(key, root)] = rewrite(input[key], root);
  }
  return out;
}

function stripHomePrefixes(text: string, root: string | undefined): string {
  if (!mentionsHome(text)) return text;
  HOME_PATH.lastIndex = 0;
  return text.replace(HOME_PATH, (match) => {
    const { core, trail } = splitTrail(match);
    if (!HOME_ROOT.test(core)) return match;
    return toRelative(core, root) + trail;
  });
}

function splitTrail(match: string): { core: string; trail: string } {
  const trimmed = /^(.*?)([.,;:)\]}]+)$/.exec(match);
  if (!trimmed || !HOME_ROOT.test(trimmed[1]!)) return { core: match, trail: '' };
  return { core: trimmed[1]!, trail: trimmed[2]! };
}

function normalizeRoot(root: string | undefined): string | undefined {
  if (!root) return undefined;
  let norm = root.replace(/\\/g, '/');
  if (norm.length > 1) norm = norm.replace(/\/+$/, '');
  return norm.startsWith('/') ? norm : undefined;
}

function homeBase(abs: string): string | undefined {
  return HOME_ROOT.exec(abs)?.[0];
}

function toRelative(absPath: string, root: string | undefined): string {
  const abs = path.posix.normalize(absPath);
  if (root) {
    const base = path.posix.normalize(root);
    if (abs === base) return '.';
    if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
    if (homeBase(abs) && homeBase(abs) === homeBase(base)) {
      const rel = path.posix.relative(base, abs);
      if (rel && !/(^|\/)(?:Users|home)\//.test(rel)) return rel;
    }
  }
  const base = homeBase(abs);
  if (!base) return absPath;
  const rest = abs.slice(base.length).replace(/^\//, '');
  return rest || '.';
}
