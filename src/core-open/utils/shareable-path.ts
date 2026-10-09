/**
 * Rewrite absolute home-directory paths so machine-readable artifacts can be
 * shared. A path under `root` becomes POSIX-relative (`.` for the root
 * itself). A path under `/home/<user>`, `/Users/<user>`, or
 * `<drive>:/Users/<user>` that is outside `root` becomes `~/…`.
 *
 * This does not call `os.homedir()`. Two machines with the same tree under
 * different home prefixes produce the same relative strings. A second pass
 * is a no-op: relative paths and `~/…` contain no home prefix.
 *
 * Strings that are not home paths are left unchanged: relative paths,
 * `/test/…`, package names, URLs, and opaque blobs that only contain the
 * letters `/home/` in the middle of a token.
 */
import * as path from 'node:path';

const HOME_MARK = /\/(?:home|Users)\/|[A-Za-z]:[\\/]Users[\\/]/;

const USER = String.raw`[A-Za-z0-9._-]{1,64}`;
const SEG = String.raw`(?:\/[A-Za-z0-9._@+-]*)*`;
const CLIMB = String.raw`(?:\.\.\/)+`;
const CLIMB_OPT = String.raw`(?:\.\.\/)*`;
/** Absolute `/home/…`, `/Users/…`, or `C:/Users/…`, optional `../` prefix dropped on rewrite. */
const ABS = String.raw`(?:\/(?:home|Users)|[A-Za-z]:\/Users)\/${USER}${SEG}`;
/** `../` climb that `path.relative` emits for a home path outside the scan root. */
const REL_HOME = String.raw`(?:home|Users)\/${USER}${SEG}`;

const WHOLE = new RegExp(`^(?:(${CLIMB})(${REL_HOME})|(${CLIMB_OPT})(${ABS}))$`);
const EMBEDDED = new RegExp(
  `(?:^|(?<=[\\s"'=\`(\\[{/]))(?:(${CLIMB})(${REL_HOME})|(${CLIMB_OPT})(${ABS}))`,
  'g',
);

const HOME_PREFIX = /^(\/(?:home|Users)\/(?!\.{1,2}(?:\/|$))[^/]+|[A-Za-z]:\/Users\/(?!\.{1,2}(?:\/|$))[^/]+)/;

function stripTrail(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.replace(/\/+$/, '');
  return p;
}

/** POSIX form. A drive letter is kept as written; the rest is `path.posix.normalize`. */
function canonicalPosix(p: string): string {
  const drive = /^([A-Za-z]:)(\/.*)$/.exec(p);
  if (drive) {
    let rest = path.posix.normalize(drive[2]);
    if (!rest.startsWith('/')) rest = `/${rest}`;
    return `${drive[1]}${rest}`;
  }
  return path.posix.normalize(p);
}

function canonicalRoot(root: string): string {
  const posix = root.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) return stripTrail(canonicalPosix(posix));
  return stripTrail(canonicalPosix(path.resolve(root).replace(/\\/g, '/')));
}

function rewriteHomePath(abs: string, root?: string): string {
  const canon = stripTrail(canonicalPosix(abs));
  const home = HOME_PREFIX.exec(canon);
  if (!home) return canon;
  if (root) {
    const canonRoot = canonicalRoot(root);
    if (canon === canonRoot) return '.';
    if (canon.startsWith(`${canonRoot}/`)) return canon.slice(canonRoot.length + 1);
  }
  if (canon === home[1]) return '~';
  return `~${canon.slice(home[1].length)}`;
}

function rewriteMatch(relHome: string | undefined, abs: string | undefined, root?: string): string {
  if (relHome) return rewriteHomePath(`/${relHome}`, root);
  return rewriteHomePath(abs ?? '', root);
}

/**
 * Rewrite one string. `root`, when set, is the scan or build directory:
 * home paths inside it become relative to that directory.
 */
export function shareablePath(input: string, root?: string): string {
  if (!HOME_MARK.test(input)) return input;
  const slash = input.replace(/\\/g, '/');
  let rewritten: string;
  if (!/\s/.test(slash)) {
    const whole = WHOLE.exec(slash);
    if (whole) {
      rewritten = rewriteMatch(whole[2], whole[4], root);
      return rewritten;
    }
  }
  EMBEDDED.lastIndex = 0;
  rewritten = slash.replace(EMBEDDED, (_m, _climb: string, relHome: string, _climbAbs: string, abs: string) =>
    rewriteMatch(relHome, abs, root),
  );
  return rewritten === slash ? input : rewritten;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, root?: string): unknown {
  if (typeof value === 'string') return shareablePath(value, root);
  if (Array.isArray(value)) return value.map((item) => walk(item, root));
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[shareablePath(key, root)] = walk((value as Record<string, unknown>)[key], root);
    }
    return out;
  }
  return value;
}

/**
 * Deep-copy `value`, rewriting home-directory paths in strings and object keys.
 * Key order is preserved. The input is not mutated.
 */
export function redactHomePaths<T>(value: T, root?: string): T {
  return walk(value, root) as T;
}

/**
 * Scan root for an artifact file that lives in a `.vibgrate` directory
 * (the parent of that directory). Other files have no inferred root, so a
 * fixture whose `rootPath` is already a logical path is left unchanged.
 */
export function scanRootFromArtifactFile(artifactPath: string): string | undefined {
  const dir = path.dirname(path.resolve(artifactPath));
  if (path.basename(dir) === '.vibgrate') return path.dirname(dir);
  return undefined;
}
