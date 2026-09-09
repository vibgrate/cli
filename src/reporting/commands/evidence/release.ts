// ── Freezing a shipped release into an immutable manifest ──
//
// The single biggest differentiator: the component manifest is frozen at ship
// time from what was actually shipped, and never regenerated. We build it from
// a scan artifact or an SBOM (CycloneDX/SPDX, bare or as an in-toto/DSSE
// attestation) captured at release, and can take the artefact digest, build
// reference and provenance straight from what BuildKit wrote — or from a local
// image — instead of values typed in by hand.

import { readJsonFile, pathExists } from '../../utils/fs.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import type { ProjectType, ScanArtifact } from '../../types.js';
import type { FrozenComponent, Release, ReleaseBuild } from './types.js';
import {
  buildFactsFromInspection,
  componentsFromSpdx,
  inspectImage,
  isProvenancePredicateType,
  isSbomPredicateType,
  isSpdxDocument,
  looksLikeProvenancePredicate,
  parseBuildxMetadata,
  summarizeProvenance,
  unwrapStatement,
  type Exec,
  type ProvenanceSummary,
  type SpdxDocument,
} from './buildkit.js';

/** Map a Vibgrate project type to the OSV ecosystem used for advisory matching. */
export function ecosystemForProjectType(type: ProjectType): string | undefined {
  switch (type) {
    case 'node':
    case 'typescript':
      return 'npm';
    case 'python':
      return 'PyPI';
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'groovy':
      return 'Maven';
    case 'dotnet':
    case 'visual-basic':
      return 'NuGet';
    case 'go':
      return 'Go';
    case 'rust':
      return 'crates.io';
    case 'ruby':
      return 'RubyGems';
    case 'php':
      return 'Packagist';
    case 'dart':
      return 'Pub';
    case 'elixir':
      return 'Hex';
    default:
      return undefined;
  }
}

function ecosystemForPurl(purl: string): string | undefined {
  const m = /^pkg:([^/]+)\//.exec(purl);
  if (!m) return undefined;
  const map: Record<string, string> = { npm: 'npm', pypi: 'PyPI', maven: 'Maven', nuget: 'NuGet', golang: 'Go', cargo: 'crates.io', gem: 'RubyGems', composer: 'Packagist', pub: 'Pub', hex: 'Hex' };
  return map[m[1].toLowerCase()];
}

export function componentsFromArtifact(artifact: ScanArtifact): FrozenComponent[] {
  const out: FrozenComponent[] = [];
  const seen = new Set<string>();
  for (const project of artifact.projects) {
    const ecosystem = ecosystemForProjectType(project.type);
    for (const dep of project.dependencies) {
      const version = dep.resolvedVersion ?? dep.currentSpec;
      const key = `${ecosystem ?? ''}|${dep.package}|${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: dep.package, version, ecosystem, purl: ecosystem === 'npm' ? `pkg:npm/${dep.package}@${version}` : undefined });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

interface CycloneDxComponent {
  name?: string;
  version?: string;
  purl?: string;
}
export function componentsFromCycloneDx(doc: { components?: CycloneDxComponent[] }): FrozenComponent[] {
  const out: FrozenComponent[] = [];
  for (const c of doc.components ?? []) {
    if (!c.name || !c.version) continue;
    out.push({ name: c.name, version: c.version, purl: c.purl, ecosystem: c.purl ? ecosystemForPurl(c.purl) : undefined });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export interface FreezeInput {
  productId: string;
  version: string;
  from: string; // path to scan artifact or SBOM (bare or attestation)
  /**
   * Was `from` given explicitly? When it was not and an inspected image carries
   * an SBOM attestation, that SBOM is the manifest source.
   */
  fromExplicit?: boolean;
  shipDate?: string;
  buildId?: string;
  artefactDigest?: string;
  distribution: string[];
  frozenAt: string;
  /** Path to a `docker buildx build --metadata-file` JSON. */
  buildkitMetadata?: string;
  /** Path to a SLSA provenance attestation (DSSE envelope, in-toto Statement, or bare predicate). */
  provenance?: string;
  /** A local image reference to inspect for digest, labels and attestations. */
  image?: string;
  /** Process runner for `--image`; injectable for tests. */
  exec?: Exec;
}

interface CycloneDxDocument {
  bomFormat?: string;
  components?: CycloneDxComponent[];
}

/**
 * Components from whatever `--from` points at: a Vibgrate scan artifact, a
 * CycloneDX or SPDX document, or either SBOM wrapped in an in-toto Statement /
 * DSSE envelope (what `docker buildx build --sbom=true` attaches to an image and
 * `imagetools inspect` exports).
 */
export function componentsFromSource(data: unknown, label: string): { components: FrozenComponent[]; attested: boolean } {
  const statement = unwrapStatement(data);
  if (statement) {
    if (!isSbomPredicateType(statement.predicateType)) {
      const hint = isProvenancePredicateType(statement.predicateType) ? ' — that is a provenance attestation; pass it with --provenance' : '';
      throw new CliError(`${label} is an attestation of type ${statement.predicateType}, not an SBOM${hint}`, ExitCode.USAGE_ERROR);
    }
    return { components: componentsFromSbom(statement.predicate, label), attested: true };
  }
  if (data && typeof data === 'object' && Array.isArray((data as ScanArtifact).projects)) {
    return { components: componentsFromArtifact(data as ScanArtifact), attested: false };
  }
  return { components: componentsFromSbom(data, label), attested: false };
}

function componentsFromSbom(data: unknown, label: string): FrozenComponent[] {
  const doc = data as CycloneDxDocument | SpdxDocument | null;
  if (doc && (('bomFormat' in doc && doc.bomFormat === 'CycloneDX') || Array.isArray((doc as CycloneDxDocument).components))) {
    return componentsFromCycloneDx(doc as CycloneDxDocument);
  }
  if (isSpdxDocument(doc)) return componentsFromSpdx(doc);
  throw new CliError(
    `unrecognised source format in ${label} — expected a Vibgrate scan artifact, a CycloneDX or SPDX SBOM, or an SBOM attestation`,
    ExitCode.USAGE_ERROR,
  );
}

async function readSource(file: string, what: string): Promise<unknown> {
  if (!(await pathExists(file))) {
    throw new CliError(`${what} not found: ${file}`, ExitCode.NOT_FOUND);
  }
  return readJsonFile<unknown>(file);
}

/** Merge a provenance summary into the build facts; the first source to name a fact keeps it. */
function applyProvenance(build: ReleaseBuild, summary: ProvenanceSummary): void {
  build.builderId ??= summary.builderId;
  build.buildType ??= summary.buildType;
  build.sourceUri ??= summary.sourceUri;
  build.sourceRevision ??= summary.sourceRevision;
  if (summary.baseImages.length) build.baseImages ??= summary.baseImages;
}

/**
 * Two sources naming the same fact must agree. A typed `--digest` that differs
 * from what the build wrote is exactly the mistake this exists to catch, so it
 * is an error, never a silent preference.
 */
function reconcile(what: string, flag: string, typed: string | undefined, found: string | undefined, foundFrom: string): string | undefined {
  if (typed && found && typed !== found) {
    throw new CliError(`${what} mismatch: ${flag} says ${typed} but ${foundFrom} says ${found}`, ExitCode.USAGE_ERROR);
  }
  return typed ?? found;
}

/** Build (but do not persist) a frozen release manifest from its sources. */
export async function buildRelease(input: FreezeInput): Promise<Release> {
  const build: ReleaseBuild = { sources: [], signature: 'unverified' };
  let artefactDigest = input.artefactDigest;
  let buildId = input.buildId;
  let components: FrozenComponent[] | undefined;

  if (input.image) {
    const inspection = await inspectImage(input.image, input.exec);
    build.sources.push('image-inspect');
    Object.assign(build, buildFactsFromInspection(inspection));
    // A pushed image is identified by its repo digest; a local-only one has
    // none, and its config digest is recorded separately rather than passed
    // off as the artefact digest.
    const repoDigest = inspection.repoDigests[0]?.split('@')[1] ?? inspection.manifestDigest;
    artefactDigest = reconcile('artefact digest', '--digest', artefactDigest, repoDigest, `image ${input.image}`);
    if (inspection.provenance) {
      build.sources.push('provenance-attestation');
      applyProvenance(build, summarizeProvenance(inspection.provenance));
    }
    // Labels are the author's word; provenance (above) is the builder's.
    build.sourceUri ??= inspection.labels['org.opencontainers.image.source'];
    build.sourceRevision ??= inspection.labels['org.opencontainers.image.revision'];
    if (inspection.sbom && !input.fromExplicit) {
      build.sources.push('sbom-attestation');
      components = componentsFromSpdx(inspection.sbom);
    }
  }

  if (input.buildkitMetadata) {
    const meta = parseBuildxMetadata(await readSource(input.buildkitMetadata, 'BuildKit metadata file'));
    build.sources.push('buildx-metadata');
    build.imageName ??= meta.imageName;
    build.configDigest ??= meta.configDigest;
    build.buildRef ??= meta.buildRef;
    artefactDigest = reconcile('artefact digest', '--digest', artefactDigest, meta.digest, input.buildkitMetadata);
    buildId = reconcile('build id', '--build-id', buildId, meta.buildRef, input.buildkitMetadata);
    if (looksLikeProvenancePredicate(meta.provenance)) {
      build.sources.push('provenance-attestation');
      applyProvenance(build, summarizeProvenance(meta.provenance));
    }
  }

  if (input.provenance) {
    const raw = await readSource(input.provenance, 'provenance file');
    const statement = unwrapStatement(raw);
    let predicate: unknown;
    if (statement) {
      if (!isProvenancePredicateType(statement.predicateType)) {
        const hint = isSbomPredicateType(statement.predicateType) ? ' — that is an SBOM attestation; pass it with --from' : '';
        throw new CliError(`${input.provenance} is an attestation of type ${statement.predicateType}, not SLSA provenance${hint}`, ExitCode.USAGE_ERROR);
      }
      predicate = statement.predicate;
    } else if (looksLikeProvenancePredicate(raw)) {
      predicate = raw;
    } else {
      throw new CliError(`unrecognised provenance format in ${input.provenance} — expected a DSSE envelope, an in-toto Statement, or a SLSA predicate`, ExitCode.USAGE_ERROR);
    }
    build.sources.push('provenance-attestation');
    applyProvenance(build, summarizeProvenance(predicate));
  }

  if (!components) {
    if (!(await pathExists(input.from))) {
      const hint = input.image
        ? `image ${input.image} carries no SBOM attestation (build with --sbom=true) and `
        : '';
      throw new CliError(`${hint}source not found: ${input.from} — point --from at a scan artifact or SBOM`, ExitCode.NOT_FOUND);
    }
    const parsed = componentsFromSource(await readJsonFile<unknown>(input.from), input.from);
    components = parsed.components;
    if (parsed.attested) build.sources.push('sbom-attestation');
  }
  if (components.length === 0) {
    throw new CliError(`no components found in ${input.image && !input.fromExplicit ? `the SBOM of ${input.image}` : input.from} — cannot freeze an empty manifest`, ExitCode.USAGE_ERROR);
  }

  return {
    productId: input.productId,
    version: input.version,
    shipDate: input.shipDate,
    buildId,
    artefactDigest,
    manifestFormat: 'vibgrate-frozen-1',
    components,
    distribution: input.distribution,
    frozenAt: input.frozenAt,
    ...(build.sources.length ? { build } : {}),
  };
}
