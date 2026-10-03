import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { pathExists, readJsonFile, writeTextFile } from '../utils/fs.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../types.js';
import { fullDependencyGraph, type LockfileComponent, type LockfileGraph } from '../../engine/lockfile.js';
import { ECOSYSTEMS, type Ecosystem } from '../../engine/drift.js';
import { vexCommand } from './vex.js';

type SbomFormat = 'cyclonedx' | 'spdx';

interface FlattenedDependency {
  project: string;
  package: string;
  version: string;
  currentSpec: string;
  drift: DependencyRow['drift'];
  majorsBehind: number | null;
  /** 'direct' comes from a scanned manifest; 'transitive' is lockfile-only. */
  scope: 'direct' | 'transitive';
  /** Which package registry this dependency resolves against — picks the purl scheme. */
  ecosystem: Ecosystem;
}

/** `ProjectScan.type` → the purl-scheme ecosystem for its dependencies. */
function projectEcosystem(type: ProjectScan['type']): Ecosystem {
  switch (type) {
    case 'python':
      return 'pypi';
    case 'rust':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
    case 'kotlin':
    case 'scala':
      return 'java';
    case 'ruby':
      return 'ruby';
    case 'php':
      return 'php';
    case 'dotnet':
      return 'dotnet';
    case 'swift':
      return 'swift';
    case 'dart':
      return 'dart';
    default:
      return 'npm';
  }
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

function splitDependencyKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@');
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function uniqSorted(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

/** Stable, always-present identifier for the SBOM's root/application component. */
const ROOT_BOM_REF = 'vibgrate-root';

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
    ...deps.map((d) => `${d.package}|${d.version}|${d.currentSpec}|${d.project}|${d.drift}|${d.majorsBehind ?? ''}|${d.scope}`),
    ...(graph?.rootDependsOn.length ? [`root>${uniqSorted(graph.rootDependsOn).join(',')}`] : []),
    ...edgeLines,
  ].join('\n');
}

/**
 * The resolved dependency graph, keyed by purl, for CycloneDX's top-level
 * `dependencies` array. `undefined` (rather than an all-empty graph) when
 * the lockfile format didn't give us real edges — see `LockfileGraph.edges`.
 */
function cycloneDxDependencyGraph(
  dependencies: FlattenedDependency[],
  graph: LockfileGraph | undefined,
): Array<{ ref: string; dependsOn: string[] }> | undefined {
  if (!graph?.edges) return undefined;
  const purlOfKey = (key: string): string => {
    const { name, version } = splitDependencyKey(key);
    // Lockfile edges are keyed `name@version` and carry no ecosystem. For npm
    // this ref matches the component bom-ref, including the non-purl ref used
    // when the name cannot be a Package URL.
    return componentBomRef('npm', name, version);
  };
  const nodes = [{ ref: ROOT_BOM_REF, dependsOn: uniqSorted(graph.rootDependsOn).map(purlOfKey) }];
  for (const dep of dependencies) {
    const key = `${dep.package}@${dep.version}`;
    nodes.push({ ref: componentBomRef('npm', dep.package, dep.version), dependsOn: uniqSorted(graph.edges.get(key) ?? []).map(purlOfKey) });
  }
  return nodes;
}

/** Same graph as `cycloneDxDependencyGraph`, expressed as SPDX `DEPENDS_ON` relationships. */
function spdxRelationships(
  dependencies: FlattenedDependency[],
  graph: LockfileGraph | undefined,
): Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }> | undefined {
  if (!graph?.edges) return undefined;
  const spdxIdOf = new Map<string, string>();
  dependencies.forEach((dep, i) => spdxIdOf.set(`${dep.package}@${dep.version}`, `SPDXRef-Package-${i + 1}`));

  const rels: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }> = [];
  for (const key of uniqSorted(graph.rootDependsOn)) {
    const id = spdxIdOf.get(key);
    if (id) rels.push({ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: id, relationshipType: 'DEPENDS_ON' });
  }
  for (const dep of dependencies) {
    const fromId = spdxIdOf.get(`${dep.package}@${dep.version}`);
    if (!fromId) continue;
    for (const childKey of uniqSorted(graph.edges.get(`${dep.package}@${dep.version}`) ?? [])) {
      const toId = spdxIdOf.get(childKey);
      if (toId) rels.push({ spdxElementId: fromId, relatedSpdxElementId: toId, relationshipType: 'DEPENDS_ON' });
    }
  }
  return rels;
}

/**
 * Direct, scanned manifest dependencies plus (when `lockfileDeps` is given)
 * every additional package the lockfile resolves that the manifest scan
 * doesn't see — the transitive tree. Manifest scanning intentionally stays
 * lockfile-free for the code graph (see `engine/manifests.ts`), which is
 * right for that use case but wrong for an SBOM: "16 packages I typed into
 * package.json" is not the installed dependency surface a vulnerability or
 * supply-chain review needs. Deduped by exact name@version so a package
 * already reported as direct isn't repeated as transitive.
 */
export function flattenDependencies(
  artifact: ScanArtifact,
  lockfileDeps: LockfileComponent[] = [],
  lockfileEcosystem?: Ecosystem,
): FlattenedDependency[] {
  const rows: FlattenedDependency[] = [];
  const seen = new Set<string>();
  for (const project of artifact.projects) {
    const ecosystem = projectEcosystem(project.type);
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
      const key = `${dep.package}@${version}`;
      // A workspace/monorepo (Cargo workspace, npm workspaces, Gradle
      // multi-module, …) scans as several `artifact.projects`, and the same
      // dependency is commonly declared by more than one of them. An SBOM
      // reports the installed package surface, not "once per project that
      // happens to use it" — keep the first project's attribution and skip
      // the rest, same as the lockfile-only loop below already does.
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        project: project.name,
        package: dep.package,
        version,
        currentSpec: dep.currentSpec,
        drift: dep.drift,
        majorsBehind: dep.majorsBehind,
        scope: 'direct',
        ecosystem,
      });
    }
  }
  for (const dep of lockfileDeps) {
    const key = `${dep.package}@${dep.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      project: artifact.rootPath,
      package: dep.package,
      version: dep.version,
      currentSpec: dep.version,
      drift: 'unknown',
      majorsBehind: null,
      scope: 'transitive',
      ecosystem: lockfileEcosystem ?? 'npm',
    });
  }
  return rows;
}

/**
 * A monorepo scans as several `artifact.projects`, each potentially with its
 * own lockfile (a `docs/` site, a `tests/` harness, a Cargo/Go/npm workspace
 * member) — not just the one at `root`. Reading only `root`'s lockfile misses
 * every package a sub-project's own lockfile resolves that root's lockfile
 * doesn't also list, which for something like a docs site's build toolchain
 * can be hundreds of components. Merge every project path's lockfile graph
 * into one components list; the top-level dependency-graph edges/rootDependsOn
 * still come from whichever project's lockfile matches `root` itself (or the
 * first one found), since a single CycloneDX `dependencies` section can only
 * describe one root's resolution, not several unrelated ones side by side.
 */
export function collectLockfileGraph(artifact: ScanArtifact, root: string): LockfileGraph | undefined {
  const paths = uniqSorted(artifact.projects.map((p) => p.path));
  const graphs = paths.map((p) => fullDependencyGraph(path.resolve(root, p))).filter((g): g is LockfileGraph => Boolean(g));
  if (!graphs.length) return undefined;

  const primaryIndex = paths.findIndex((p, i) => graphs[i] && (p === '.' || path.resolve(root, p) === path.resolve(root)));
  const primary = primaryIndex >= 0 ? graphs[primaryIndex]! : graphs[0]!;

  const components = new Map<string, LockfileComponent>();
  for (const graph of graphs) {
    for (const c of graph.components) components.set(`${c.package}@${c.version}`, c);
  }
  return { ...primary, components: [...components.values()].sort((a, b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version)) };
}

export function toCycloneDx(artifact: ScanArtifact, graph?: LockfileGraph): Record<string, unknown> {
  const dependencies = flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem);
  const dependencyGraph = cycloneDxDependencyGraph(dependencies, graph);
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
    },
    components: dependencies.map((dep) => {
      const { purl, warning } = resolvePurl(dep.ecosystem, dep.package, dep.version);
      const properties: Array<{ name: string; value: string }> = [
        { name: 'vibgrate:project', value: dep.project },
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
      }
      return {
        type: 'library',
        'bom-ref': purl ?? componentBomRef(dep.ecosystem, dep.package, dep.version),
        name: dep.package,
        version: dep.version,
        ...(purl ? { purl } : {}),
        properties,
      };
    }),
    ...(dependencyGraph ? { dependencies: dependencyGraph } : {}),
  };
}

export function toSpdx(artifact: ScanArtifact, graph?: LockfileGraph): Record<string, unknown> {
  const dependencies = flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem);
  const relationships = spdxRelationships(dependencies, graph);
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
      const status = warning ? `; purlStatus=${PURL_STATUS_UNAVAILABLE}` : '';
      const annotations = [
        {
          annotationType: 'OTHER',
          annotator: 'Tool: @vibgrate/cli',
          annotationDate: artifact.timestamp,
          comment: `project=${dep.project}; drift=${dep.drift}; majorsBehind=${dep.majorsBehind ?? 'unknown'}; scope=${dep.scope}${status}`,
        },
      ];
      if (warning) {
        annotations.push({
          annotationType: 'OTHER',
          annotator: 'Tool: @vibgrate/cli',
          annotationDate: artifact.timestamp,
          comment: warning,
        });
      }
      return {
        name: dep.package,
        SPDXID: `SPDXRef-Package-${i + 1}`,
        versionInfo: dep.version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
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
    ...(relationships ? { relationships } : {}),
  };
}

/** Warnings for components whose purl was omitted. Same order as the SBOM rows; stable for a given artifact. */
export function collectPurlWarnings(artifact: ScanArtifact, graph?: LockfileGraph): string[] {
  return flattenDependencies(artifact, graph?.components ?? [], graph?.ecosystem).flatMap((dep) => {
    const warning = resolvePurl(dep.ecosystem, dep.package, dep.version).warning;
    return warning ? [warning] : [];
  });
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
    for (const warning of collectPurlWarnings(artifact, lockfileGraph)) {
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
