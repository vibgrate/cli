import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { pathExists, readJsonFile, writeTextFile } from '../utils/fs.js';
import type { DependencyRow, Finding, ProjectScan, ScanArtifact } from '../types.js';
import { LICENSE_PARSE_FAILED } from '../../core-open/licenses/diagnostic.js';
import { fullDependencyGraph, type LockfileComponent, type LockfileGraph } from '../../engine/lockfile.js';
import { ECOSYSTEMS, type Ecosystem } from '../../engine/drift.js';
import { componentLicense, extractedLicensingInfos, type ComponentLicense } from './sbom-license.js';
import { vexCommand } from './vex.js';
import {
  codedWarning,
  formatWarningLine,
  sortCodedWarnings,
  WARNING_CODES,
  type CodedWarning,
  type WarningCode,
} from '../../core-open/warnings.js';
import { readRootPackageIdentity, rootPackageIdentityMessage } from '../../core-open/utils/root-package-identity.js';

export { describeUnrepresentableLicense } from './sbom-license.js';

type SbomFormat = 'cyclonedx' | 'spdx';

interface FlattenedDependency {
  /** Project whose metadata was kept (direct row: first in the artifact; lockfile-only: first sorted path). */
  project: string;
  /** Every project that contributed this identity, sorted. Not an error when this lists more than one. */
  projects: string[];
  package: string;
  version: string;
  currentSpec: string;
  drift: DependencyRow['drift'];
  majorsBehind: number | null;
  /** 'direct' comes from a scanned manifest; 'transitive' is lockfile-only. */
  scope: 'direct' | 'transitive';
  /** Which package registry this dependency resolves against — picks the purl scheme. */
  ecosystem: Ecosystem;
  /** Declared license from the kept scan row. Lockfile-only rows have none. */
  license?: DependencyRow['license'];
  /** Facts that were dropped or guessed. Empty when the merge kept everything it was given. */
  mergeWarnings: string[];
}

/**
 * Project types whose package registry is known. `node` and `typescript` are
 * npm. Anything else that falls through is not a registry this exporter can
 * name, and labeling it npm is a guess that must be warned about.
 */
const PROJECT_ECOSYSTEM: Partial<Record<ProjectScan['type'], Ecosystem>> = {
  node: 'npm',
  typescript: 'npm',
  python: 'pypi',
  rust: 'rust',
  go: 'go',
  java: 'java',
  kotlin: 'java',
  scala: 'java',
  ruby: 'ruby',
  php: 'php',
  dotnet: 'dotnet',
  swift: 'swift',
  dart: 'dart',
};

/** `ProjectScan.type` → the purl-scheme ecosystem for its dependencies. */
function projectEcosystem(type: ProjectScan['type']): Ecosystem {
  return PROJECT_ECOSYSTEM[type] ?? 'npm';
}

function projectEcosystemGuessed(type: ProjectScan['type']): boolean {
  return PROJECT_ECOSYSTEM[type] === undefined;
}

/**
 * Deterministic RFC 9562 version-8 UUID derived from `seed`, so an SBOM's
 * serialNumber / documentNamespace is stable for identical content instead of
 * random. A stable id makes `vg sbom export` reproducible for a given scan and
 * format. Uses a salted FNV-1a hash; a collision is only cosmetic — the SBOM
 * content, not this id, is what a consumer verifies.
 *
 * Kept in sync with the identical helper in the API
 * (`packages/vibgrate-api/src/lib/sbom-export.ts`).
 */
export function deterministicUuid(seed: string): string {
  const bytes = new Uint8Array(16);
  for (let block = 0; block < 4; block++) {
    let h = 0x811c9dc5;
    const s = `${block} ${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h >>>= 0;
    bytes[block * 4] = (h >>> 24) & 0xff;
    bytes[block * 4 + 1] = (h >>> 16) & 0xff;
    bytes[block * 4 + 2] = (h >>> 8) & 0xff;
    bytes[block * 4 + 3] = h & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8 (custom)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Sentinel for "we know the package but not a concrete installed version" —
 * same convention as `majorsBehind`'s `'unknown'` elsewhere in this file.
 * Never emitted as a real version: `isConcreteVersion` below is what routes a
 * dependency here instead of its raw declared spec.
 */
const UNKNOWN_VERSION = 'unknown';

/**
 * True for something that names one real, installed version — false for a
 * semver range (`^1.2.3`, `>=1.0.0`), a wildcard/dist-tag (`*`, `latest`), or
 * a package-manager protocol spec (`workspace:*`, `npm:real-name@1.2.3`,
 * `patch:pkg@…`, `file:../local`, a git/http(s) URL). Only `resolvedVersion`
 * or a lockfile hit should ever produce the latter; when neither exists the
 * SBOM must say so honestly (`UNKNOWN_VERSION`) rather than put someone's
 * *intent* ("whatever satisfies ^1.2.3") in the field a vulnerability scanner
 * reads as "this exact version is installed" — that's not a smaller version
 * of the truth, it's a different claim.
 */
function isConcreteVersion(spec: string): boolean {
  if (!spec || spec === '*' || spec === 'latest') return false;
  if (/[\^~*<>|]/.test(spec)) return false;
  if (/^(npm|workspace|patch|file|link|git|github|https?):/i.test(spec)) return false;
  return true;
}

/**
 * purl types this exporter actually emits. `encodeURIComponent` will turn a
 * space or a non-ASCII name into a string that still starts with `pkg:`, so
 * "looks like a purl" is not the check — the type has to be one of these.
 */
const KNOWN_PURL_TYPES = new Set(['npm', 'pypi', 'cargo', 'golang', 'maven', 'gem', 'composer', 'nuget', 'swift', 'pub']);

/**
 * A path segment we are willing to call a purl name. `encodeURIComponent`
 * leaves these characters alone, plus `%40`, which is the encoded `@` of an
 * npm scope (`pkg:npm/%40scope/name`). Anything else — `%20` for a space,
 * `%C3%A9` for non-ASCII, an empty segment — is a purl-shaped string, not a
 * Package URL. `.` and `..` are forbidden segments in the purl spec.
 */
const PURL_SEGMENT = /^(?:[A-Za-z0-9._~!*'()-]|%40)+$/;

const KNOWN_ECOSYSTEMS = new Set<string>(ECOSYSTEMS);

/** CycloneDX property that says why `purl` was left off. Stable across runs. */
const PURL_STATUS_PROPERTY = 'vibgrate:purlStatus';
const PURL_WARNING_PROPERTY = 'vibgrate:purlWarning';
const PURL_STATUS_UNAVAILABLE = 'unavailable';

/** CycloneDX properties that say why a declared license was not copied onto the component. */
const LICENSE_STATUS_PROPERTY = 'vibgrate:licenseStatus';
const LICENSE_WARNING_PROPERTY = 'vibgrate:licenseWarning';
const LICENSE_STATUS_UNREPRESENTABLE = 'unrepresentable';
/** CycloneDX property that carries the stable warning code beside a prose warning. */
const WARNING_CODE_PROPERTY = 'vibgrate:warningCode';

/** The purl type/namespace/name portion, without a version — shared by every ecosystem branch of `purlFor`. */
function purlPath(ecosystem: Ecosystem, name: string): string | null {
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
      return group ? `pkg:maven/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}` : `pkg:maven/${encodeURIComponent(artifact)}`;
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
      // An ecosystem this function does not know is not npm. Falling through
      // to `pkg:npm/...` would report a registry the scan did not detect.
      return null;
  }
}

/**
 * [purl](https://github.com/package-url/purl-spec) for an npm package,
 * scope handled as its own namespace segment per spec (`pkg:npm/%40scope/name@1.0.0`,
 * not a single percent-encoded `%40scope%2Fname`). Used to key components and
 * dependency-graph refs so a vulnerability scanner can match on purl directly.
 */
export function npmPurl(name: string, version: string): string | null {
  return purlFor('npm', name, version);
}

/** PyPI purl names are normalized per PEP 503: lowercased, runs of `-_.` collapsed to one `-`. */
function pypiPurlName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * [purl](https://github.com/package-url/purl-spec) for a dependency, keyed
 * by ecosystem — see `purlPath` for the per-ecosystem type/namespace/name
 * mapping. A purl's `@version` is a claim about what's actually installed,
 * so `UNKNOWN_VERSION` omits it (a bare `pkg:npm/axios` is valid purl syntax)
 * rather than encode a range or protocol spec as if it were one.
 *
 * Returns null when the built string is not a Package URL: unknown type,
 * empty name or path segment, a space or other character that only survives
 * as percent-encoding, or a version that is not one concrete token. Callers
 * keep the component and mark the purl unavailable — they do not drop the
 * row, and they do not emit the rejected string.
 */
export function purlFor(ecosystem: Ecosystem, name: string, version: string): string | null {
  const path = purlPath(ecosystem, name);
  if (!path) return null;
  const purl = version === UNKNOWN_VERSION ? path : `${path}@${encodeURIComponent(version)}`;
  return isValidBuiltPurl(purl) ? purl : null;
}

function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

function isPurlSegment(segment: string): boolean {
  if (segment === '.' || segment === '..') return false;
  return PURL_SEGMENT.test(segment);
}

/**
 * True when `purl` is a Package URL we would hand to a scanner: known type,
 * every path segment a non-empty name, version either absent or one concrete
 * token (`isConcreteVersion` already rejects ranges, wildcards, and protocol
 * specs). Percent-encoding other than an npm scope's `%40` fails — that is
 * how `foo bar` was leaving as `pkg:npm/foo%20bar@1.0.0`.
 */
function isValidBuiltPurl(purl: string): boolean {
  if (!purl.startsWith('pkg:')) return false;
  const rest = purl.slice(4);
  const at = rest.lastIndexOf('@');
  const coords = at === -1 ? rest : rest.slice(0, at);
  const version = at === -1 ? null : rest.slice(at + 1);
  const slash = coords.indexOf('/');
  if (slash <= 0) return false;
  const type = coords.slice(0, slash);
  if (!KNOWN_PURL_TYPES.has(type)) return false;
  const pathPart = coords.slice(slash + 1);
  if (!pathPart || pathPart.split('/').some((segment) => !isPurlSegment(segment))) return false;
  if (version === null) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(version);
  } catch {
    return false;
  }
  if (!decoded || /\s/u.test(decoded)) return false;
  return isConcreteVersion(decoded);
}

/**
 * Why `purlFor` returned null. Names the package and ecosystem and says what
 * to do. No filesystem path — a scan root is not part of the package identity.
 */
export function describeUnavailablePurl(ecosystem: string, name: string, version: string): string {
  let because: string;
  if (!KNOWN_ECOSYSTEMS.has(ecosystem)) {
    because = 'this ecosystem has no Package URL type, so none is guessed';
  } else if (name.length === 0 || name.split('/').some((part) => part.length === 0)) {
    because = 'the name has an empty path segment';
  } else if (/\s/u.test(name) || hasNonAscii(name)) {
    because = 'the name contains whitespace or a non-ASCII character';
  } else if (version !== UNKNOWN_VERSION && !isConcreteVersion(version)) {
    because = 'the version is not one concrete installed version';
  } else {
    because = 'the coordinates cannot be encoded as a Package URL';
  }
  return `Package URL unavailable for ${ecosystem} package "${name}": ${because}. The component is included without a purl. Use the package's registry name, with no spaces or empty path segments.`;
}

export function resolvePurl(ecosystem: Ecosystem, name: string, version: string): { purl: string | null; warning: string | null } {
  const purl = purlFor(ecosystem, name, version);
  if (purl) return { purl, warning: null };
  return { purl: null, warning: describeUnavailablePurl(ecosystem, name, version) };
}

/** Stable CycloneDX bom-ref. A valid purl when we have one; never a rejected purl string. */
function componentBomRef(ecosystem: Ecosystem, name: string, version: string): string {
  return purlFor(ecosystem, name, version) ?? `vibgrate:${ecosystem}:${name}@${version}`;
}

/** Code-unit order, so the result does not depend on the process locale. */
function cmpText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Order for SBOM component and dependency rows. Primary key is the Package URL
 * when one was emitted, otherwise the package name. Version is next. The name
 * is the last key so two rows that share a purl and a version (PyPI `Flask`
 * and `flask`) stay in a fixed order instead of discovery order.
 */
export function compareSbomOrder(
  a: { purl?: string | null; name: string; version?: string | null },
  b: { purl?: string | null; name: string; version?: string | null },
): number {
  const aPrimary = a.purl ? a.purl : a.name;
  const bPrimary = b.purl ? b.purl : b.name;
  return cmpText(aPrimary, bPrimary) || cmpText(a.version ?? '', b.version ?? '') || cmpText(a.name, b.name);
}

function compareFlattenedDependency(a: FlattenedDependency, b: FlattenedDependency): number {
  return (
    compareSbomOrder(
      { purl: purlFor(a.ecosystem, a.package, a.version), name: a.package, version: a.version },
      { purl: purlFor(b.ecosystem, b.package, b.version), name: b.package, version: b.version },
    ) || cmpText(a.ecosystem, b.ecosystem)
  );
}

function splitDependencyKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@');
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function uniqSorted(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

/** Stable, always-present identifier for the SBOM's root/application component. */
const ROOT_BOM_REF = 'vibgrate-root';

/**
 * License-parse findings, in a stable order. Scan stores these on the
 * artifact; SBOM export repeats them so a consumer that only reads the SBOM
 * still sees the failure instead of a bare NOASSERTION.
 */
function licenseParseFindings(artifact: ScanArtifact): Finding[] {
  return artifact.findings
    .filter((f) => f.ruleId === LICENSE_PARSE_FAILED)
    .slice()
    .sort((a, b) => a.location.localeCompare(b.location) || a.message.localeCompare(b.message));
}

/** Identity of one installed package: ecosystem, name, and version. */
function componentIdentity(ecosystem: Ecosystem, name: string, version: string): string {
  return `${ecosystem}\0${name}@${version}`;
}

/**
 * Lockfile edges are `name@version` inside one ecosystem. The merged graph
 * qualifies them so an npm `left-pad@1.3.0` cannot share an edge with a
 * PyPI package of the same name and version. A key that is already qualified
 * is left alone. A legacy single-lockfile graph has no separator; callers
 * pass the graph's ecosystem as the fallback.
 */
function qualifyEdgeKey(ecosystem: Ecosystem, key: string): string {
  return key.includes('\0') ? key : `${ecosystem}\0${key}`;
}

function parseEdgeKey(key: string, fallback: Ecosystem): { ecosystem: Ecosystem; name: string; version: string } {
  const nul = key.indexOf('\0');
  const ecosystem = (nul === -1 ? fallback : key.slice(0, nul)) as Ecosystem;
  const raw = nul === -1 ? key : key.slice(nul + 1);
  const { name, version } = splitDependencyKey(raw);
  return { ecosystem, name, version };
}

function bomRefForEdgeKey(key: string, fallback: Ecosystem): string {
  const { ecosystem, name, version } = parseEdgeKey(key, fallback);
  return componentBomRef(ecosystem, name, version);
}

function edgesOf(graph: LockfileGraph, dep: FlattenedDependency): string[] {
  if (!graph.edges) return [];
  const qualified = componentIdentity(dep.ecosystem, dep.package, dep.version);
  if (graph.edges.has(qualified)) return graph.edges.get(qualified) ?? [];
  return graph.edges.get(`${dep.package}@${dep.version}`) ?? [];
}

function sameEdges(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function projectPhrase(names: string[]): string {
  const unique = [...new Set(names)].filter((name) => name.length > 0).sort((a, b) => a.localeCompare(b));
  const label = unique.length === 1 ? 'project' : 'projects';
  return `${label} ${unique.map((name) => `"${name}"`).join(', ')}`;
}

function describeUnknownEcosystem(projectType: string, projectName: string, packageName: string, version: string): string {
  return `Ecosystem unknown for ${projectType} project "${projectName}"; package "${packageName}@${version}" is recorded as npm.`;
}

function describeLossyEdges(ecosystem: string, packageName: string, version: string, dropped: string[], kept: string[]): string {
  return `Dropped a different dependency list for ${ecosystem} package "${packageName}@${version}" from ${projectPhrase(dropped)}; kept the list from ${projectPhrase(kept)}.`;
}

function describeLossyManifest(ecosystem: string, packageName: string, version: string, dropped: string, kept: string): string {
  return `Dropped differing manifest metadata for ${ecosystem} package "${packageName}@${version}" from project "${dropped}"; kept the row from project "${kept}".`;
}

function describeUntrackedEdges(ecosystem: string, packageName: string, version: string, projects: string[]): string {
  return `Dependency edges are not recorded for ${ecosystem} package "${packageName}@${version}" from ${projectPhrase(projects)}. An empty dependsOn is not a claim that the package has no dependencies.`;
}

/** Map a known SBOM warning sentence to its code. Unknown prose stays uncoded. */
function sbomWarningCode(message: string): WarningCode | undefined {
  if (message.startsWith('Package URL unavailable')) return WARNING_CODES.PURL_UNAVAILABLE;
  if (message.startsWith('Declared license')) return WARNING_CODES.LICENSE_UNREPRESENTABLE;
  if (message.startsWith('Dropped a different dependency list')) return WARNING_CODES.SBOM_LOSSY_EDGES;
  if (message.startsWith('Dropped differing manifest metadata')) return WARNING_CODES.SBOM_LOSSY_MANIFEST;
  if (message.startsWith('Ecosystem unknown')) return WARNING_CODES.SBOM_UNKNOWN_ECOSYSTEM;
  if (message.startsWith('Dependency edges are not recorded')) return WARNING_CODES.SBOM_UNTRACKED_EDGES;
  return undefined;
}

function pushWarningCode(properties: Array<{ name: string; value: string }>, message: string): void {
  const code = sbomWarningCode(message);
  if (code) properties.push({ name: WARNING_CODE_PROPERTY, value: code });
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function addProjects(row: FlattenedDependency, names: Iterable<string>): void {
  row.projects = sortedUnique([...row.projects, ...names]);
}

function addMergeWarnings(row: FlattenedDependency, warnings: Iterable<string>): void {
  for (const warning of warnings) {
    if (warning && !row.mergeWarnings.includes(warning)) row.mergeWarnings.push(warning);
  }
}

function manifestMetadataDiffers(row: FlattenedDependency, dep: DependencyRow): boolean {
  if (row.currentSpec !== dep.currentSpec || row.drift !== dep.drift || row.majorsBehind !== dep.majorsBehind) return true;
  return `${row.license?.raw ?? ''}|${row.license?.spdxId ?? ''}` !== `${dep.license?.raw ?? ''}|${dep.license?.spdxId ?? ''}`;
}

/** Stable seed for the document id: format + root + the ordered dependency set + any dependency graph. */
function sbomSerialSeed(format: string, artifact: ScanArtifact, deps: FlattenedDependency[], graph?: LockfileGraph): string {
  const edgeLines = graph?.edges
    ? [...graph.edges.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([from, to]) => `${from}>${uniqSorted(to).join(',')}`)
    : [];
  return [
    format,
    artifact.rootPath ?? '',
    artifact.timestamp ?? '',
    artifact.vibgrateVersion ?? '',
    ...deps.map(
      (d) =>
        `${d.ecosystem}|${d.package}|${d.version}|${d.currentSpec}|${d.project}|${d.projects.join(',')}|${d.drift}|${d.majorsBehind ?? ''}|${d.scope}|${d.license?.raw ?? ''}|${d.license?.spdxId ?? ''}|${d.mergeWarnings.join(',')}`,
    ),
    ...(graph?.rootDependsOn.length ? [`root>${uniqSorted(graph.rootDependsOn).join(',')}`] : []),
    ...edgeLines,
    ...licenseParseFindings(artifact).map((f) => `license-parse|${f.location}|${f.message}`),
  ].join('\n');
}

/**
 * The resolved dependency graph, keyed by purl, for CycloneDX's top-level
 * `dependencies` array. `undefined` (rather than an all-empty graph) when
 * the lockfile format didn't give us real edges — see `LockfileGraph.edges`.
 * Each edge uses the ecosystem stored on that key, so a sub-project from
 * another registry is not rewritten as npm.
 */
function cycloneDxDependencyGraph(
  dependencies: FlattenedDependency[],
  graph: LockfileGraph | undefined,
): Array<{ ref: string; dependsOn: string[] }> | undefined {
  if (!graph?.edges) return undefined;
  const fallback = graph.ecosystem ?? 'npm';
  const nodes = [{ ref: ROOT_BOM_REF, dependsOn: uniqSorted(graph.rootDependsOn).map((key) => bomRefForEdgeKey(key, fallback)) }];
  for (const dep of dependencies) {
    nodes.push({
      ref: componentBomRef(dep.ecosystem, dep.package, dep.version),
      dependsOn: uniqSorted(edgesOf(graph, dep)).map((key) => bomRefForEdgeKey(key, dep.ecosystem)),
    });
  }
  return nodes;
}

/** Same graph as `cycloneDxDependencyGraph`, expressed as SPDX `DEPENDS_ON` relationships. */
function spdxRelationships(
  dependencies: FlattenedDependency[],
  graph: LockfileGraph | undefined,
): Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }> | undefined {
  if (!graph?.edges) return undefined;
  const fallback = graph.ecosystem ?? 'npm';
  const spdxIdOf = new Map<string, string>();
  dependencies.forEach((dep, i) => spdxIdOf.set(componentIdentity(dep.ecosystem, dep.package, dep.version), `SPDXRef-Package-${i + 1}`));
  const spdxIdFor = (key: string, ecosystem: Ecosystem): string | undefined => {
    const parsed = parseEdgeKey(key, ecosystem);
    return spdxIdOf.get(componentIdentity(parsed.ecosystem, parsed.name, parsed.version));
  };

  const rels: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }> = [];
  for (const key of uniqSorted(graph.rootDependsOn)) {
    const id = spdxIdFor(key, fallback);
    if (id) rels.push({ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: id, relationshipType: 'DEPENDS_ON' });
  }
  for (const dep of dependencies) {
    const fromId = spdxIdOf.get(componentIdentity(dep.ecosystem, dep.package, dep.version));
    if (!fromId) continue;
    for (const childKey of uniqSorted(edgesOf(graph, dep))) {
      const toId = spdxIdFor(childKey, dep.ecosystem);
      if (toId) rels.push({ spdxElementId: fromId, relatedSpdxElementId: toId, relationshipType: 'DEPENDS_ON' });
    }
  }
  return rels;
}

/** A lockfile component plus the merge facts `collectLockfileGraph` records. */
interface MergedLockfileComponent extends LockfileComponent {
  ecosystem: Ecosystem;
  /** Contributing project names, sorted. */
  projects: string[];
  /** Project that supplied the kept component (first sorted path). */
  winningProject: string;
  mergeWarnings: string[];
}

/**
 * Direct, scanned manifest dependencies plus (when `lockfileDeps` is given)
 * every additional package the lockfile resolves that the manifest scan
 * doesn't see — the transitive tree. Manifest scanning intentionally stays
 * lockfile-free for the code graph (see `engine/manifests.ts`), which is
 * right for that use case but wrong for an SBOM: "16 packages I typed into
 * package.json" is not the installed dependency surface a vulnerability or
 * supply-chain review needs.
 *
 * Identity is ecosystem + name + version. Direct manifest rows are applied
 * first and win over a lockfile row. The same identity from another project
 * stays one component; every contributing project is recorded. Differing
 * manifest metadata is dropped with a warning, not silently.
 */
export function flattenDependencies(
  artifact: ScanArtifact,
  lockfileDeps: Array<LockfileComponent & Partial<Pick<MergedLockfileComponent, 'ecosystem' | 'projects' | 'winningProject' | 'mergeWarnings'>>> = [],
  lockfileEcosystem?: Ecosystem,
): FlattenedDependency[] {
  const rows: FlattenedDependency[] = [];
  const index = new Map<string, FlattenedDependency>();
  for (const project of artifact.projects) {
    const ecosystem = projectEcosystem(project.type);
    const guessed = projectEcosystemGuessed(project.type);
    for (const dep of project.dependencies) {
      // Go always pins an exact version in go.mod, but the scanner's
      // `resolvedVersion` runs it through `semver.clean` (for semver math
      // elsewhere) and drops the `v` prefix go.sum's transitive entries keep
      // — matching on `currentSpec` instead is what lets a direct Go
      // dependency dedupe against its own go.sum-derived component instead
      // of appearing as two, differently-versioned components.
      const rawVersion = ecosystem === 'go' ? dep.currentSpec : (dep.resolvedVersion ?? dep.currentSpec);
      // A dependency with no lockfile/installed-tree resolution falls back
      // to its declared spec, which for npm/yarn/pnpm can be a semver range,
      // a `workspace:*`/`npm:alias@…` protocol spec, or a bare `latest` —
      // none of which name an installed version. Reporting that string as
      // the SBOM's "version" (and building a purl from it) states something
      // that isn't true; `UNKNOWN_VERSION` says plainly that it isn't known.
      const version = isConcreteVersion(rawVersion) ? rawVersion : UNKNOWN_VERSION;
      const key = componentIdentity(ecosystem, dep.package, version);
      const existing = index.get(key);
      if (existing) {
        if (manifestMetadataDiffers(existing, dep)) {
          addMergeWarnings(existing, [describeLossyManifest(ecosystem, dep.package, version, project.name, existing.project)]);
        }
        addProjects(existing, [project.name]);
        continue;
      }
      const row: FlattenedDependency = {
        project: project.name,
        projects: [project.name],
        package: dep.package,
        version,
        currentSpec: dep.currentSpec,
        drift: dep.drift,
        majorsBehind: dep.majorsBehind,
        scope: 'direct',
        ecosystem,
        license: dep.license,
        mergeWarnings: [],
      };
      if (guessed) {
        addMergeWarnings(row, [describeUnknownEcosystem(project.type, project.name, dep.package, version)]);
      }
      index.set(key, row);
      rows.push(row);
    }
  }
  const lockfileOnly: FlattenedDependency[] = [];
  for (const dep of lockfileDeps) {
    const ecosystem = dep.ecosystem ?? lockfileEcosystem ?? 'npm';
    const key = componentIdentity(ecosystem, dep.package, dep.version);
    const existing = index.get(key);
    if (existing) {
      if (dep.projects?.length) addProjects(existing, dep.projects);
      if (dep.mergeWarnings?.length) addMergeWarnings(existing, dep.mergeWarnings);
      continue;
    }
    const projects = dep.projects?.length ? sortedUnique(dep.projects) : [artifact.rootPath];
    const row: FlattenedDependency = {
      project: dep.winningProject || projects[0] || artifact.rootPath,
      projects,
      package: dep.package,
      version: dep.version,
      currentSpec: dep.version,
      drift: 'unknown',
      majorsBehind: null,
      scope: 'transitive',
      ecosystem,
      mergeWarnings: [],
    };
    if (dep.mergeWarnings?.length) addMergeWarnings(row, dep.mergeWarnings);
    index.set(key, row);
    lockfileOnly.push(row);
  }
  // Sort before any serializer, warning list, or document-id seed reads this
  // array. Discovery order (project walk, lockfile map) must not leak.
  return [...rows, ...lockfileOnly].sort(compareFlattenedDependency);
}

interface LockfileMergeEntry {
  path: string;
  graph: LockfileGraph;
  projects: ProjectScan[];
}

interface MergedComponentAcc {
  component: LockfileComponent;
  ecosystem: Ecosystem;
  projects: Set<string>;
  winningProject: string;
  /** Undefined when this identity's lockfile does not record edges. */
  edges: string[] | undefined;
  edgeProjects: string[];
  mergeWarnings: string[];
}

/**
 * A monorepo scans as several `artifact.projects`, each potentially with its
 * own lockfile (a `docs/` site, a `tests/` harness, a Cargo/Go/npm workspace
 * member) — not just the one at `root`. Reading only `root`'s lockfile misses
 * every package a sub-project's own lockfile resolves.
 *
 * Components are keyed by ecosystem + name + version. Direct rows are applied
 * later, in `flattenDependencies`; here, lockfiles are visited in sorted
 * project-path order and the first occurrence wins. A later lockfile that
 * repeats the same identity adds its project names. A later lockfile with a
 * different dependency list is not applied — that drop is a warning on the
 * component. Each component keeps the ecosystem of the lockfile that
 * contributed it, so a Python sub-project is not labeled npm because the
 * root lockfile was.
 *
 * `rootDependsOn` is the scan-root lockfile's direct edges (the first project
 * path that has a lockfile, when the root has none). It is not copied onto
 * every other component.
 */
export function collectLockfileGraph(artifact: ScanArtifact, root: string): LockfileGraph | undefined {
  const projectsByPath = new Map<string, ProjectScan[]>();
  for (const project of artifact.projects) {
    const list = projectsByPath.get(project.path) ?? [];
    list.push(project);
    projectsByPath.set(project.path, list);
  }
  const entries: LockfileMergeEntry[] = [];
  for (const projectPath of [...projectsByPath.keys()].sort((a, b) => a.localeCompare(b))) {
    const graph = fullDependencyGraph(path.resolve(root, projectPath));
    if (!graph) continue;
    entries.push({ path: projectPath, graph, projects: projectsByPath.get(projectPath) ?? [] });
  }
  if (!entries.length) return undefined;

  const byIdentity = new Map<string, MergedComponentAcc>();
  let anyEdges = false;
  for (const entry of entries) {
    const { ecosystem, guessedProjects } = resolveLockfileEcosystem(entry);
    const names = sortedUnique(entry.projects.map((project) => project.name));
    if (entry.graph.edges) anyEdges = true;
    for (const component of entry.graph.components) {
      const key = componentIdentity(ecosystem, component.package, component.version);
      const incoming = entry.graph.edges
        ? (entry.graph.edges.get(`${component.package}@${component.version}`) ?? []).map((child) => qualifyEdgeKey(ecosystem, child))
        : undefined;
      const existing = byIdentity.get(key);
      if (!existing) {
        const mergeWarnings: string[] = [];
        for (const project of guessedProjects) {
          mergeWarnings.push(describeUnknownEcosystem(project.type, project.name, component.package, component.version));
        }
        byIdentity.set(key, {
          component,
          ecosystem,
          projects: new Set(names),
          winningProject: names[0] || artifact.rootPath,
          edges: incoming,
          edgeProjects: names,
          mergeWarnings,
        });
        continue;
      }
      for (const name of names) existing.projects.add(name);
      for (const project of guessedProjects) {
        const warning = describeUnknownEcosystem(project.type, project.name, component.package, component.version);
        if (!existing.mergeWarnings.includes(warning)) existing.mergeWarnings.push(warning);
      }
      if (incoming && existing.edges) {
        if (!sameEdges(existing.edges, incoming)) {
          existing.mergeWarnings.push(describeLossyEdges(ecosystem, component.package, component.version, names, existing.edgeProjects));
        }
      } else if (incoming && !existing.edges) {
        existing.edges = incoming;
        existing.edgeProjects = names;
      }
    }
  }

  if (anyEdges) {
    for (const acc of byIdentity.values()) {
      if (acc.edges) continue;
      acc.mergeWarnings.push(
        describeUntrackedEdges(acc.ecosystem, acc.component.package, acc.component.version, [...acc.projects]),
      );
    }
  }

  const components: MergedLockfileComponent[] = [...byIdentity.values()]
    .map((acc) => ({
      package: acc.component.package,
      version: acc.component.version,
      ecosystem: acc.ecosystem,
      projects: sortedUnique(acc.projects),
      winningProject: acc.winningProject,
      mergeWarnings: acc.mergeWarnings,
    }))
    .sort(
      (a, b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version) || a.ecosystem.localeCompare(b.ecosystem),
    );

  const edges = anyEdges ? new Map<string, string[]>() : undefined;
  if (edges) {
    for (const acc of byIdentity.values()) {
      if (!acc.edges) continue;
      edges.set(componentIdentity(acc.ecosystem, acc.component.package, acc.component.version), uniqSorted(acc.edges));
    }
  }

  const rootEntry =
    entries.find((entry) => entry.path === '.' || path.resolve(root, entry.path) === path.resolve(root)) ?? entries[0]!;
  const rootEcosystem = resolveLockfileEcosystem(rootEntry).ecosystem;
  return {
    components,
    edges,
    rootDependsOn: rootEntry.graph.rootDependsOn.map((key) => qualifyEdgeKey(rootEcosystem, key)),
    ecosystem: rootEcosystem,
  };
}

function resolveLockfileEcosystem(entry: LockfileMergeEntry): { ecosystem: Ecosystem; guessedProjects: ProjectScan[] } {
  if (entry.graph.ecosystem && (ECOSYSTEMS as readonly string[]).includes(entry.graph.ecosystem)) {
    return { ecosystem: entry.graph.ecosystem, guessedProjects: [] };
  }
  const unknown = entry.projects.filter((project) => projectEcosystemGuessed(project.type));
  const known = entry.projects.some((project) => !projectEcosystemGuessed(project.type));
  // JS lockfiles omit `ecosystem`; that is npm. Warn only when no project at
  // this path has a type we can map, so the npm label is an assumption.
  if (!known && unknown.length > 0) return { ecosystem: 'npm', guessedProjects: unknown };
  return { ecosystem: 'npm', guessedProjects: [] };
}

function licenseFor(dep: FlattenedDependency): ComponentLicense {
  return componentLicense(dep.ecosystem, dep.package, dep.version, dep.license);
}

export function toCycloneDx(artifact: ScanArtifact, graph?: LockfileGraph): Record<string, unknown> {
  const dependencies = flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem);
  const dependencyGraph = cycloneDxDependencyGraph(dependencies, graph);
  const licenseNotes = licenseParseFindings(artifact);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${deterministicUuid(sbomSerialSeed('cyclonedx', artifact, dependencies, graph))}`,
    version: 1,
    metadata: {
      timestamp: artifact.timestamp,
      tools: [
        {
          vendor: 'Vibgrate',
          name: '@vibgrate/cli',
          version: artifact.vibgrateVersion,
        },
      ],
      component: {
        type: 'application',
        'bom-ref': ROOT_BOM_REF,
        name: artifact.rootPath,
      },
      ...(licenseNotes.length
        ? {
            properties: licenseNotes.flatMap((f) => [
              {
                name: LICENSE_PARSE_FAILED,
                value: `${f.location}: ${f.message}`,
              },
              { name: WARNING_CODE_PROPERTY, value: WARNING_CODES.LICENSE_UNPARSEABLE },
            ]),
          }
        : {}),
    },
    components: dependencies.map((dep) => {
      const { purl, warning } = resolvePurl(dep.ecosystem, dep.package, dep.version);
      const license = licenseFor(dep);
      const properties: Array<{ name: string; value: string }> = [
        { name: 'vibgrate:project', value: dep.project },
        { name: 'vibgrate:projects', value: dep.projects.join(', ') },
        { name: 'vibgrate:currentSpec', value: dep.currentSpec },
        { name: 'vibgrate:drift', value: dep.drift },
        { name: 'vibgrate:majorsBehind', value: String(dep.majorsBehind ?? 'unknown') },
        { name: 'vibgrate:scope', value: dep.scope },
      ];
      if (warning) {
        properties.push(
          { name: PURL_STATUS_PROPERTY, value: PURL_STATUS_UNAVAILABLE },
          { name: PURL_WARNING_PROPERTY, value: warning },
        );
        pushWarningCode(properties, warning);
      }
      if (license.warning) {
        properties.push(
          { name: LICENSE_STATUS_PROPERTY, value: LICENSE_STATUS_UNREPRESENTABLE },
          { name: LICENSE_WARNING_PROPERTY, value: license.warning },
        );
        pushWarningCode(properties, license.warning);
      }
      for (const mergeWarning of dep.mergeWarnings) {
        properties.push({ name: 'vibgrate:mergeWarning', value: mergeWarning });
        pushWarningCode(properties, mergeWarning);
      }
      return {
        type: 'library',
        'bom-ref': purl ?? componentBomRef(dep.ecosystem, dep.package, dep.version),
        name: dep.package,
        version: dep.version,
        ...(purl ? { purl } : {}),
        ...(license.cycloneLicenses ? { licenses: license.cycloneLicenses } : {}),
        properties,
      };
    }),
    ...(dependencyGraph ? { dependencies: dependencyGraph } : {}),
  };
}

export function toSpdx(artifact: ScanArtifact, graph?: LockfileGraph): Record<string, unknown> {
  const dependencies = flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem);
  const relationships = spdxRelationships(dependencies, graph);
  const licenseNotes = licenseParseFindings(artifact);
  const licenses = dependencies.map((dep) => licenseFor(dep));
  const extracted = extractedLicensingInfos(licenses.flatMap((license) => license.licenseRefs));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${artifact.rootPath}-sbom`,
    documentNamespace: `https://vibgrate.com/spdx/${artifact.rootPath}/${deterministicUuid(sbomSerialSeed('spdx', artifact, dependencies, graph))}`,
    creationInfo: {
      created: artifact.timestamp,
      creators: [`Tool: @vibgrate/cli-${artifact.vibgrateVersion}`],
    },
    packages: dependencies.map((dep, i) => {
      const { purl, warning } = resolvePurl(dep.ecosystem, dep.package, dep.version);
      const license = licenses[i]!;
      const purlStatus = warning ? `; purlStatus=${PURL_STATUS_UNAVAILABLE}` : '';
      const licenseStatus = license.warning ? `; licenseStatus=${LICENSE_STATUS_UNREPRESENTABLE}` : '';
      const annotations = [
        {
          annotationType: 'OTHER',
          annotator: 'Tool: @vibgrate/cli',
          annotationDate: artifact.timestamp,
          comment: `project=${dep.project}; projects=${dep.projects.join(', ')}; drift=${dep.drift}; majorsBehind=${dep.majorsBehind ?? 'unknown'}; scope=${dep.scope}${purlStatus}${licenseStatus}`,
        },
      ];
      const pushSpdxWarning = (message: string): void => {
        annotations.push({
          annotationType: 'OTHER',
          annotator: 'Tool: @vibgrate/cli',
          annotationDate: artifact.timestamp,
          comment: message,
        });
        const code = sbomWarningCode(message);
        if (code) {
          annotations.push({
            annotationType: 'OTHER',
            annotator: 'Tool: @vibgrate/cli',
            annotationDate: artifact.timestamp,
            comment: `warningCode=${code}`,
          });
        }
      };
      if (warning) pushSpdxWarning(warning);
      if (license.warning) pushSpdxWarning(license.warning);
      for (const mergeWarning of dep.mergeWarnings) pushSpdxWarning(mergeWarning);
      return {
        name: dep.package,
        SPDXID: `SPDXRef-Package-${i + 1}`,
        versionInfo: dep.version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: license.licenseDeclared,
        ...(purl
          ? {
              externalRefs: [
                {
                  referenceCategory: 'PACKAGE-MANAGER',
                  referenceType: 'purl',
                  referenceLocator: purl,
                },
              ],
            }
          : {}),
        annotations,
      };
    }),
    ...(extracted.length ? { hasExtractedLicensingInfos: extracted } : {}),
    ...(relationships ? { relationships } : {}),
    ...(licenseNotes.length
      ? {
          annotations: licenseNotes.flatMap((f) => [
            {
              annotationType: 'OTHER',
              annotator: 'Tool: @vibgrate/cli',
              annotationDate: artifact.timestamp,
              comment: `${f.ruleId}: ${f.message}`,
            },
            {
              annotationType: 'OTHER',
              annotator: 'Tool: @vibgrate/cli',
              annotationDate: artifact.timestamp,
              comment: `warningCode=${WARNING_CODES.LICENSE_UNPARSEABLE}`,
            },
          ]),
        }
      : {}),
  };
}

/** Warnings for components whose purl was omitted. Same order as the SBOM rows; stable for a given artifact. */
export function collectPurlWarnings(artifact: ScanArtifact, graph?: LockfileGraph): string[] {
  return flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem).flatMap((dep) => {
    const warning = resolvePurl(dep.ecosystem, dep.package, dep.version).warning;
    return warning ? [warning] : [];
  });
}

/** Warnings for declared licenses that cannot be represented. Same order as the SBOM rows. */
export function collectLicenseWarnings(artifact: ScanArtifact, graph?: LockfileGraph): string[] {
  return flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem).flatMap((dep) => {
    const warning = licenseFor(dep).warning;
    return warning ? [warning] : [];
  });
}

/**
 * Warnings for a merge that dropped or guessed a fact (unknown ecosystem,
 * a later lockfile's dependency list, edges a format does not record).
 * Same order as the SBOM rows. The export command prints each one on stderr.
 */
export function collectMergeWarnings(artifact: ScanArtifact, graph?: LockfileGraph): string[] {
  return flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem).flatMap((dep) => dep.mergeWarnings);
}

function projectDependencyMap(artifact: ScanArtifact): Map<string, DependencyRow> {
  const map = new Map<string, DependencyRow>();
  for (const project of artifact.projects) {
    for (const dep of project.dependencies) {
      map.set(`${project.name}:${dep.package}`, dep);
    }
  }
  return map;
}

export function formatDeltaText(base: ScanArtifact, current: ScanArtifact): string {
  const baseMap = projectDependencyMap(base);
  const currentMap = projectDependencyMap(current);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, dep] of currentMap.entries()) {
    if (!baseMap.has(key)) {
      added.push(`${key} @ ${dep.resolvedVersion ?? dep.currentSpec}`);
      continue;
    }
    const prev = baseMap.get(key)!;
    const prevVersion = prev.resolvedVersion ?? prev.currentSpec;
    const nowVersion = dep.resolvedVersion ?? dep.currentSpec;
    if (prevVersion !== nowVersion || prev.majorsBehind !== dep.majorsBehind) {
      changed.push(`${key} ${prevVersion} -> ${nowVersion} (majorsBehind ${prev.majorsBehind ?? 'unknown'} -> ${dep.majorsBehind ?? 'unknown'})`);
    }
  }

  for (const [key, dep] of baseMap.entries()) {
    if (!currentMap.has(key)) {
      removed.push(`${key} @ ${dep.resolvedVersion ?? dep.currentSpec}`);
    }
  }

  const lines = [
    'Vibgrate SBOM Delta',
    '===================',
    `Baseline: ${base.timestamp}`,
    `Current:  ${current.timestamp}`,
    `DriftScore delta: ${
      typeof current.drift.score === 'number' && typeof base.drift.score === 'number'
        ? `${(current.drift.score - base.drift.score).toFixed(2)} points`
        : 'n/a'
    }`,
    '',
    `Added dependencies (${added.length})`,
    ...added.map((d) => `  + ${d}`),
    '',
    `Removed dependencies (${removed.length})`,
    ...removed.map((d) => `  - ${d}`),
    '',
    `Changed dependencies (${changed.length})`,
    ...changed.map((d) => `  * ${d}`),
  ];

  return lines.join('\n');
}

async function readArtifactOrExit(filePath: string): Promise<ScanArtifact> {
  const absolutePath = path.resolve(filePath);
  if (!(await pathExists(absolutePath))) {
    console.error(chalk.red(`Artifact not found: ${absolutePath}`));
    process.exit(1);
  }
  return readJsonFile<ScanArtifact>(absolutePath);
}

const exportCommand = new Command('export')
  .description('Export scan artifact as SBOM')
  .option('--in <file>', 'Input artifact file', '.vibgrate/scan_result.json')
  .option('--out <file>', 'Output SBOM file')
  .option('--format <format>', 'SBOM format (cyclonedx|spdx)', 'cyclonedx')
  .option('--root <dir>', 'Project root to read the lockfile from', '.')
  .option('--no-transitive', 'Report only direct, manifest-declared dependencies')
  .action(async (opts: { in: string; out?: string; format: string; root: string; transitive: boolean }) => {
    const artifact = await readArtifactOrExit(opts.in);
    const format = opts.format.toLowerCase() as SbomFormat;

    if (format !== 'cyclonedx' && format !== 'spdx') {
      console.error(chalk.red('Invalid SBOM format. Use cyclonedx or spdx.'));
      process.exit(1);
    }

    // Manifest scanning only sees what's declared in package.json (by design —
    // see engine/manifests.ts), which is a fraction of what's actually
    // installed. Pull the full resolved tree — merged across every scanned
    // sub-project's own lockfile, not just root's — and, where the lockfile
    // format supports it, the resolved dependency edges — so the SBOM
    // reflects real supply-chain exposure, not just direct dependencies.
    const lockfileGraph = opts.transitive ? collectLockfileGraph(artifact, path.resolve(opts.root)) : undefined;

    const sbom = format === 'cyclonedx' ? toCycloneDx(artifact, lockfileGraph) : toSpdx(artifact, lockfileGraph);
    const coded: CodedWarning[] = [];
    const plain: string[] = [];
    const rootIdentityWarning = rootPackageIdentityMessage(readRootPackageIdentity(path.resolve(opts.root)));
    if (rootIdentityWarning) {
      coded.push(codedWarning(WARNING_CODES.ROOT_PACKAGE_IDENTITY, rootIdentityWarning));
    }
    for (const warning of [
      ...collectPurlWarnings(artifact, lockfileGraph),
      ...collectLicenseWarnings(artifact, lockfileGraph),
      ...collectMergeWarnings(artifact, lockfileGraph),
    ]) {
      const code = sbomWarningCode(warning);
      if (code) coded.push(codedWarning(code, warning));
      else plain.push(warning);
    }
    for (const warning of sortCodedWarnings(coded)) {
      console.error(chalk.yellow(formatWarningLine(warning)));
    }
    for (const warning of plain) {
      console.error(chalk.yellow(`warning: ${warning}`));
    }
    const body = JSON.stringify(sbom, null, 2);

    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), body);
      console.log(chalk.green('✔') + ` SBOM written to ${opts.out}`);
    } else {
      console.log(body);
    }
  });

const deltaCommand = new Command('delta')
  .description('Show SBOM delta between two scan artifacts')
  .requiredOption('--from <file>', 'Baseline scan artifact path')
  .requiredOption('--to <file>', 'Current scan artifact path')
  .option('--out <file>', 'Write report to file')
  .action(async (opts: { from: string; to: string; out?: string }) => {
    const base = await readArtifactOrExit(opts.from);
    const current = await readArtifactOrExit(opts.to);
    const report = formatDeltaText(base, current);

    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), report);
      console.log(chalk.green('✔') + ` SBOM delta report written to ${opts.out}`);
    } else {
      console.log(report);
    }
  });

export const sbomCommand = new Command('sbom')
  .description('Supply-chain evidence: SBOM export/delta and OpenVEX generation')
  .addCommand(exportCommand)
  .addCommand(deltaCommand)
  .addCommand(vexCommand);
