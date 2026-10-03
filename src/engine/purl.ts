import type { Ecosystem } from './drift.js';

/**
 * Sentinel for "we know the package but not a concrete installed version".
 * A purl's `@version` is a claim about what is installed, so this value omits
 * the version instead of encoding a range or protocol spec as one.
 */
export const UNKNOWN_VERSION = 'unknown';

/** CycloneDX property / SPDX marker when a component cannot be encoded as a purl. */
export const PURL_STATUS_UNAVAILABLE = 'unavailable';

/**
 * True for something that names one real, installed version — false for a
 * semver range (`^1.2.3`, `>=1.0.0`), a wildcard/dist-tag (`*`, `latest`), or
 * a package-manager protocol spec (`workspace:*`, `npm:real-name@1.2.3`,
 * `patch:pkg@…`, `file:../local`, a git/http(s) URL).
 */
export function isConcreteVersion(spec: string): boolean {
  if (!spec || spec === '*' || spec === 'latest') return false;
  if (/[\^~*<>|]/.test(spec)) return false;
  if (/^(npm|workspace|patch|file|link|git|github|https?):/i.test(spec)) return false;
  return true;
}

/** purl type for each ecosystem this CLI can encode. There is no npm fallback. */
const PURL_TYPE: { [K in Ecosystem]: string } = {
  npm: 'npm',
  pypi: 'pypi',
  rust: 'cargo',
  go: 'golang',
  java: 'maven',
  ruby: 'gem',
  php: 'composer',
  dotnet: 'nuget',
  swift: 'swift',
  dart: 'pub',
};

const KNOWN_PURL_TYPES = new Set(Object.values(PURL_TYPE));

/** Decoded purl segment: ASCII letters, digits, and the unreserved extras we emit. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~+-]+$/;
/** npm scope segment, after percent-decoding `%40`. */
const NPM_SCOPE_SEGMENT = /^@[A-Za-z0-9._~+-]+$/;

/** PyPI purl names are normalized per PEP 503: lowercased, runs of `-_.` collapsed to one `-`. */
function pypiPurlName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * The purl type/namespace/name portion, without a version.
 * Returns null when this ecosystem has no purl type — callers must not
 * substitute an npm purl.
 */
function purlPath(ecosystem: Ecosystem, name: string): string | null {
  const type = PURL_TYPE[ecosystem];
  if (!type) return null;
  switch (ecosystem) {
    case 'npm': {
      const scopeSlash = name.startsWith('@') ? name.indexOf('/') : -1;
      if (scopeSlash > 0) {
        return `pkg:npm/${encodeURIComponent(name.slice(0, scopeSlash))}/${encodeURIComponent(name.slice(scopeSlash + 1))}`;
      }
      return `pkg:npm/${encodeURIComponent(name)}`;
    }
    case 'pypi':
      return `pkg:pypi/${encodeURIComponent(pypiPurlName(name))}`;
    case 'rust':
      return `pkg:cargo/${encodeURIComponent(name)}`;
    case 'go':
      return `pkg:golang/${name.split('/').map(encodeURIComponent).join('/')}`;
    case 'java': {
      const [group, artifact] = name.includes(':') ? name.split(':') : [undefined, name];
      return group
        ? `pkg:maven/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}`
        : `pkg:maven/${encodeURIComponent(artifact)}`;
    }
    case 'ruby':
      return `pkg:gem/${encodeURIComponent(name)}`;
    case 'php':
      return `pkg:composer/${name.split('/').map(encodeURIComponent).join('/')}`;
    case 'dotnet':
      return `pkg:nuget/${encodeURIComponent(name)}`;
    case 'swift':
      return `pkg:swift/${name.split('/').map(encodeURIComponent).join('/')}`;
    case 'dart':
      return `pkg:pub/${encodeURIComponent(name)}`;
    default:
      return null;
  }
}

function decodeSegment(segment: string): string | undefined {
  if (!segment || /%(?![0-9A-Fa-f]{2})/.test(segment)) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function segmentAllowed(decoded: string, allowNpmScope: boolean): boolean {
  if (decoded === '.' || decoded === '..') return false;
  if (allowNpmScope && decoded.startsWith('@')) return NPM_SCOPE_SEGMENT.test(decoded);
  return PLAIN_SEGMENT.test(decoded);
}

/**
 * A purl string this CLI is willing to emit: a known type, a non-empty name,
 * no empty path segments, and a version that is either absent or one concrete
 * token. Spaces and other characters outside the purl name alphabet fail here
 * even when percent-encoding would still produce a purl-shaped string.
 */
export function isValidBuiltPurl(purl: string): boolean {
  const match = /^pkg:([a-z0-9.+-]+)\/([^?#]*?)(?:@([^?#]*))?$/.exec(purl);
  if (!match) return false;
  const type = match[1];
  const path = match[2];
  const version = match[3];
  if (!type || !KNOWN_PURL_TYPES.has(type) || !path) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) return false;
  for (let i = 0; i < segments.length; i++) {
    const decoded = decodeSegment(segments[i]!);
    if (decoded === undefined || !segmentAllowed(decoded, type === 'npm' && i === 0)) return false;
  }
  if (version === undefined) return true;
  const decodedVersion = decodeSegment(version);
  if (decodedVersion === undefined || decodedVersion === '.' || decodedVersion === '..') return false;
  if (!PLAIN_SEGMENT.test(decodedVersion)) return false;
  return isConcreteVersion(decodedVersion);
}

/**
 * [purl](https://github.com/package-url/purl-spec) for a dependency.
 * `UNKNOWN_VERSION` omits `@version` (a bare `pkg:npm/axios` is valid purl
 * syntax). Returns undefined when the name or version cannot be encoded —
 * callers keep the component and must not invent a replacement purl.
 */
export function purlFor(ecosystem: Ecosystem, name: string, version: string): string | undefined {
  const path = purlPath(ecosystem, name);
  if (!path) return undefined;
  const purl = version === UNKNOWN_VERSION ? path : `${path}@${encodeURIComponent(version)}`;
  return isValidBuiltPurl(purl) ? purl : undefined;
}

/**
 * [purl](https://github.com/package-url/purl-spec) for an npm package.
 * A scope is its own namespace segment (`pkg:npm/%40scope/name@1.0.0`).
 */
export function npmPurl(name: string, version: string): string | undefined {
  return purlFor('npm', name, version);
}

/** Stable CycloneDX bom-ref for a component that has no purl. Not a purl. */
export function unavailableBomRef(ecosystemLabel: string, packageName: string, version: string): string {
  return `vibgrate:${ecosystemLabel}:${packageName}@${version}`;
}

const MAX_PACKAGE_NAME_IN_WARNING = 200;

/** Package name as it appears in a diagnostic: one line, bounded, no control characters. */
function packageNameForWarning(name: string): string {
  const collapsed = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[ \t\f\v]+/g, ' ').trim();
  if (!collapsed) return '(empty name)';
  if (collapsed.length <= MAX_PACKAGE_NAME_IN_WARNING) return collapsed;
  return `${collapsed.slice(0, MAX_PACKAGE_NAME_IN_WARNING)}...`;
}

/**
 * Actionable diagnostic for a component whose purl could not be encoded.
 * Names the package and ecosystem only — no filesystem path, declared spec,
 * or file contents.
 */
export function purlUnavailableMessage(ecosystemLabel: string, packageName: string): string {
  const shown = packageNameForWarning(packageName);
  return `Package URL unavailable for ${ecosystemLabel} package ${JSON.stringify(shown)}. The component is included without a purl. Use a non-empty package name with no spaces or empty path segments (letters, digits, and ._-~; an npm scope may start with @) and a concrete version when one is known, then regenerate the SBOM.`;
}
