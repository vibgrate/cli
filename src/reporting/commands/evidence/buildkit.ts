// ── BuildKit build outputs as evidence inputs ──
//
// BuildKit (the engine behind `docker build` / `docker buildx build`) already
// writes the facts a frozen release needs: the image digest (`--metadata-file`),
// the source repository and commit plus the base images (the SLSA provenance
// attestation), and a component inventory (the SBOM attestation). Nothing here
// generates any of that — this module only *reads* what the build produced, so
// a release manifest can be tied to the artefact that actually shipped rather
// than to values typed in by hand.
//
// Three readers, all pure functions of their input:
//   - `parseBuildxMetadata`   — the `--metadata-file` JSON
//   - `unwrapStatement`       — a DSSE envelope or bare in-toto Statement
//   - `summarizeProvenance`   — a SLSA v0.2 or v1 provenance predicate
//   - `componentsFromSpdx`    — an SPDX 2.x document (what `--sbom=true` emits)
//
// plus one that shells out: `inspectImage`, which asks a local Docker for the
// image config, labels and attached attestations. It is read-only, takes the
// reference as an argv element (never through a shell), and is injectable so
// the parsing is testable without a daemon.
//
// Signatures on attestations are recorded as `unverified`: vg does not carry a
// registry trust root, and pretending to verify would be worse than saying so.

import { execFile } from 'node:child_process';
import { CliError, ExitCode } from '../../../util/exit.js';
import type { FrozenComponent, ReleaseBuild } from './types.js';

// ── `--metadata-file` ──

export interface BuildxMetadata {
  /** `image.name` — comma-separated when the build tagged several names. */
  imageName?: string;
  /** `containerimage.digest` — the manifest (or index) digest that was pushed. */
  digest?: string;
  /** `containerimage.config.digest` — the image config digest (`docker image inspect` `Id`). */
  configDigest?: string;
  /** `buildx.build.ref` — the build record reference (`<builder>/<node>/<id>`). */
  buildRef?: string;
  /** Inline provenance predicate when `BUILDX_METADATA_PROVENANCE` was set. */
  provenance?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseBuildxMetadata(data: unknown): BuildxMetadata {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CliError('BuildKit metadata file must be a JSON object (the output of `docker buildx build --metadata-file`)', ExitCode.USAGE_ERROR);
  }
  const o = data as Record<string, unknown>;
  const descriptor = o['containerimage.descriptor'] as Record<string, unknown> | undefined;
  const digest = str(o['containerimage.digest']) ?? (descriptor ? str(descriptor.digest) : undefined);
  const out: BuildxMetadata = {
    imageName: str(o['image.name']),
    digest,
    configDigest: str(o['containerimage.config.digest']),
    buildRef: str(o['buildx.build.ref']),
    provenance: o['buildx.build.provenance'],
  };
  if (!out.digest && !out.configDigest && !out.buildRef && !out.imageName) {
    throw new CliError(
      'no BuildKit fields found — expected `containerimage.digest`, `containerimage.config.digest`, `buildx.build.ref` or `image.name` (is this the `--metadata-file` output?)',
      ExitCode.USAGE_ERROR,
    );
  }
  return out;
}

// ── in-toto / DSSE ──

export const SPDX_PREDICATE_TYPE = 'https://spdx.dev/Document';
export const CYCLONEDX_PREDICATE_TYPE = 'https://cyclonedx.org/bom';

export interface StatementView {
  predicateType: string;
  predicate: unknown;
  subjects: { name?: string; digest?: Record<string, string> }[];
}

function isStatement(o: Record<string, unknown>): boolean {
  return typeof o._type === 'string' && o._type.startsWith('https://in-toto.io/Statement') && typeof o.predicateType === 'string';
}

/**
 * Accept either a DSSE envelope (`payloadType` + base64 `payload`) or a bare
 * in-toto Statement; anything else returns null so the caller can try the
 * next format. The envelope's signatures are not checked — see the header.
 */
export function unwrapStatement(data: unknown): StatementView | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.payload === 'string' && typeof o.payloadType === 'string') {
    let inner: unknown;
    try {
      inner = JSON.parse(Buffer.from(o.payload, 'base64').toString('utf8'));
    } catch {
      throw new CliError('DSSE payload is not base64-encoded JSON', ExitCode.USAGE_ERROR);
    }
    return unwrapStatement(inner);
  }
  if (!isStatement(o)) return null;
  const rawSubjects = Array.isArray(o.subject) ? (o.subject as Record<string, unknown>[]) : [];
  return {
    predicateType: o.predicateType as string,
    predicate: o.predicate,
    subjects: rawSubjects.map((s) => ({
      name: str(s.name),
      digest: s.digest && typeof s.digest === 'object' ? (s.digest as Record<string, string>) : undefined,
    })),
  };
}

export function isSbomPredicateType(t: string): boolean {
  return t.startsWith(SPDX_PREDICATE_TYPE) || t.startsWith(CYCLONEDX_PREDICATE_TYPE);
}

export function isProvenancePredicateType(t: string): boolean {
  return t.startsWith('https://slsa.dev/provenance/');
}

// ── SLSA provenance ──

export interface ProvenanceSummary {
  builderId?: string;
  buildType?: string;
  sourceUri?: string;
  sourceRevision?: string;
  baseImages: { ref: string; digest?: string }[];
  /** How many materials / resolved dependencies the predicate listed. */
  materialCount: number;
}

interface Material {
  uri?: string;
  digest?: Record<string, string>;
}

function materialsOf(p: Record<string, unknown>): Material[] {
  const def = p.buildDefinition as Record<string, unknown> | undefined;
  const v1 = def && Array.isArray(def.resolvedDependencies) ? (def.resolvedDependencies as Material[]) : [];
  const v02 = Array.isArray(p.materials) ? (p.materials as Material[]) : [];
  return [...v1, ...v02].filter((m) => m && typeof m === 'object');
}

const GIT_URI = /^(git\+)?(https?:\/\/|ssh:\/\/|git@)/i;

/** `git+https://github.com/acme/web@refs/heads/main` → `https://github.com/acme/web`. */
function normaliseGitUri(uri: string): string {
  const noScheme = uri.replace(/^git\+/i, '');
  const at = noScheme.indexOf('@refs/');
  return (at > 0 ? noScheme.slice(0, at) : noScheme).replace(/\.git$/, '');
}

function isGitMaterial(m: Material): boolean {
  if (!m.uri || !GIT_URI.test(m.uri)) return false;
  return Boolean(m.digest?.sha1 || m.digest?.gitCommit || /@refs\//.test(m.uri) || /\.git$/.test(m.uri));
}

/**
 * Reduce a SLSA v0.2 or v1 predicate to the facts a release cares about. Base
 * images arrive as `pkg:docker/<name>@<tag>?platform=…` materials with a
 * sha256 digest; the source repository as a `git+https://…` material (v0.2
 * also names it in `invocation.configSource`).
 */
export function summarizeProvenance(predicate: unknown): ProvenanceSummary {
  const empty: ProvenanceSummary = { baseImages: [], materialCount: 0 };
  if (!predicate || typeof predicate !== 'object') return empty;
  const p = predicate as Record<string, unknown>;
  const def = p.buildDefinition as Record<string, unknown> | undefined;
  const run = p.runDetails as Record<string, unknown> | undefined;
  const builder = (run?.builder ?? p.builder) as Record<string, unknown> | undefined;
  const invocation = p.invocation as Record<string, unknown> | undefined;
  const configSource = invocation?.configSource as Record<string, unknown> | undefined;

  const materials = materialsOf(p);
  const baseImages: { ref: string; digest?: string }[] = [];
  let sourceUri: string | undefined;
  let sourceRevision: string | undefined;

  for (const m of materials) {
    const uri = str(m.uri);
    if (!uri) continue;
    if (uri.startsWith('pkg:docker/')) {
      const ref = decodeURIComponent(uri.slice('pkg:docker/'.length).split('?')[0]);
      baseImages.push({ ref, digest: str(m.digest?.sha256) ? `sha256:${m.digest!.sha256}` : undefined });
      continue;
    }
    if (!sourceUri && isGitMaterial(m)) {
      sourceUri = normaliseGitUri(uri);
      sourceRevision = str(m.digest?.sha1) ?? str(m.digest?.gitCommit);
    }
  }
  if (!sourceUri && configSource && str(configSource.uri)) {
    sourceUri = normaliseGitUri(configSource.uri as string);
    const d = configSource.digest as Record<string, string> | undefined;
    sourceRevision = str(d?.sha1) ?? str(d?.gitCommit) ?? sourceRevision;
  }

  baseImages.sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
  const unique = baseImages.filter((img, i) => i === 0 || img.ref !== baseImages[i - 1].ref || img.digest !== baseImages[i - 1].digest);

  return {
    builderId: str(builder?.id),
    buildType: str(def?.buildType) ?? str(p.buildType),
    sourceUri,
    sourceRevision,
    baseImages: unique,
    materialCount: materials.length,
  };
}

/** A bare predicate (no Statement wrapper), as `buildx.build.provenance` inlines it. */
export function looksLikeProvenancePredicate(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return Array.isArray(o.materials) || typeof o.buildDefinition === 'object' || typeof o.buildType === 'string';
}

// ── SPDX ──

interface SpdxPackage {
  name?: string;
  versionInfo?: string;
  SPDXID?: string;
  primaryPackagePurpose?: string;
  externalRefs?: { referenceCategory?: string; referenceType?: string; referenceLocator?: string }[];
}

export interface SpdxDocument {
  spdxVersion?: string;
  SPDXID?: string;
  name?: string;
  packages?: SpdxPackage[];
}

export function isSpdxDocument(data: unknown): data is SpdxDocument {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return typeof o.spdxVersion === 'string' || (typeof o.SPDXID === 'string' && Array.isArray(o.packages));
}

function ecosystemForPurl(purl: string): string | undefined {
  const m = /^pkg:([^/]+)\//.exec(purl);
  if (!m) return undefined;
  const map: Record<string, string> = {
    npm: 'npm', pypi: 'PyPI', maven: 'Maven', nuget: 'NuGet', golang: 'Go', cargo: 'crates.io', gem: 'RubyGems',
    composer: 'Packagist', pub: 'Pub', hex: 'Hex', deb: 'Debian', apk: 'Alpine', rpm: 'RPM',
  };
  return map[m[1].toLowerCase()];
}

/**
 * SPDX 2.x `packages[]` → frozen components. The package that *describes the
 * image itself* (purpose `CONTAINER`, or a `pkg:oci/` purl) is not a component
 * of the release and is skipped; so is anything without a concrete version.
 */
export function componentsFromSpdx(doc: SpdxDocument): FrozenComponent[] {
  const out: FrozenComponent[] = [];
  const seen = new Set<string>();
  for (const pkg of doc.packages ?? []) {
    const name = str(pkg.name);
    const version = str(pkg.versionInfo);
    if (!name || !version) continue;
    const purl = pkg.externalRefs?.find((r) => r.referenceType === 'purl' && typeof r.referenceLocator === 'string')?.referenceLocator;
    if (pkg.primaryPackagePurpose === 'CONTAINER' || purl?.startsWith('pkg:oci/')) continue;
    const ecosystem = purl ? ecosystemForPurl(purl) : undefined;
    const key = `${ecosystem ?? ''}|${name}|${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, version, purl, ecosystem });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ── Local image inspection (`docker`) ──

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

const EXEC_TIMEOUT_MS = 60_000;
/** SBOM attestations for a large image run to tens of MB. */
const EXEC_MAX_BUFFER = 256 * 1024 * 1024;

export const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        const detail = String(stderr || e.message || '').trim().split('\n')[0];
        reject(Object.assign(new Error(detail || `${file} failed`), { code: e.code }));
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  });

/** Only image references a registry would accept; never something argv could misread as a flag. */
const IMAGE_REF = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

export function isValidImageRef(ref: string): boolean {
  return IMAGE_REF.test(ref);
}

export interface ImageInspection {
  ref: string;
  /** Image config digest (`docker image inspect` `Id`) — present for a local image. */
  configDigest?: string;
  /** `RepoDigests` — present only once the image has been pushed or pulled. */
  repoDigests: string[];
  /** Manifest / index digest from `buildx imagetools inspect`. */
  manifestDigest?: string;
  /** `org.opencontainers.image.*` (and legacy `org.label-schema.*`) labels only. */
  labels: Record<string, string>;
  /** SLSA provenance predicate attached to the image, if any. */
  provenance?: unknown;
  /** SPDX document attached to the image, if any. */
  sbom?: SpdxDocument;
}

const LABEL_ALLOW = /^(org\.opencontainers\.image|org\.label-schema)\./;

/** Keep the standard descriptive labels; a vendor label can carry anything. */
export function filterOciLabels(labels: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels || typeof labels !== 'object') return out;
  for (const key of Object.keys(labels as Record<string, unknown>).sort()) {
    const value = (labels as Record<string, unknown>)[key];
    if (LABEL_ALLOW.test(key) && typeof value === 'string') out[key] = value;
  }
  return out;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`could not parse ${what} output as JSON`, ExitCode.ERROR);
  }
}

/**
 * `docker buildx imagetools inspect --format '{{json .}}'` nests attestations
 * either directly (`{"Provenance":{"SLSA":…}}`) for a single-platform image or
 * per platform (`{"Provenance":{"linux/amd64":{"SLSA":…}}}`). Pick the first
 * platform in sorted order so the result is deterministic.
 */
export function pickAttestation(container: unknown, key: 'SLSA' | 'SPDX'): unknown {
  if (!container || typeof container !== 'object') return undefined;
  const o = container as Record<string, unknown>;
  if (o[key] && typeof o[key] === 'object') return o[key];
  for (const platform of Object.keys(o).sort()) {
    const inner = o[platform];
    if (inner && typeof inner === 'object' && (inner as Record<string, unknown>)[key]) {
      return (inner as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

/**
 * The `image` block is the config for a single-platform image and a
 * platform-keyed map of configs for a multi-platform one; first platform in
 * sorted order wins, as for attestations.
 */
function imageConfigOf(image: unknown): Record<string, unknown> | undefined {
  if (!image || typeof image !== 'object') return undefined;
  const o = image as Record<string, unknown>;
  if (o.config && typeof o.config === 'object') return o.config as Record<string, unknown>;
  for (const platform of Object.keys(o).sort()) {
    const inner = o[platform] as Record<string, unknown> | undefined;
    if (inner?.config && typeof inner.config === 'object') return inner.config as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Read what a local Docker knows about an image. `docker image inspect` gives
 * the config digest, repo digests and labels of a *local* image; `docker buildx
 * imagetools inspect` gives the manifest digest and any attestations, and also
 * works for a reference that exists only in a registry. Either may be absent —
 * the result records what was found and the caller decides what is enough.
 */
export async function inspectImage(ref: string, exec: Exec = defaultExec): Promise<ImageInspection> {
  if (!isValidImageRef(ref)) {
    throw new CliError(`not a valid image reference: ${ref}`, ExitCode.USAGE_ERROR);
  }
  const result: ImageInspection = { ref, repoDigests: [], labels: {} };
  let localErr: string | undefined;
  let toolsErr: string | undefined;

  try {
    const { stdout } = await exec('docker', ['image', 'inspect', '--format', '{{json .}}', ref]);
    const raw = parseJson(stdout, 'docker image inspect');
    const obj = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
    if (obj) {
      result.configDigest = str(obj.Id);
      result.repoDigests = Array.isArray(obj.RepoDigests) ? (obj.RepoDigests as unknown[]).filter((d): d is string => typeof d === 'string').sort() : [];
      result.labels = filterOciLabels((obj.Config as Record<string, unknown> | undefined)?.Labels);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(
        'docker not found on PATH — inspect needs a local Docker; without one, pass the build outputs as files (--buildkit-metadata, --provenance, --from <sbom>)',
        ExitCode.NOT_FOUND,
      );
    }
    localErr = (err as Error).message;
  }

  try {
    const { stdout } = await exec('docker', ['buildx', 'imagetools', 'inspect', '--format', '{{json .}}', ref]);
    const raw = parseJson(stdout, 'docker buildx imagetools inspect') as Record<string, unknown>;
    const manifest = raw.manifest as Record<string, unknown> | undefined;
    result.manifestDigest = str(manifest?.digest);
    const provenance = pickAttestation(raw.Provenance ?? raw.provenance, 'SLSA');
    if (provenance) result.provenance = provenance;
    const sbom = pickAttestation(raw.SBOM ?? raw.sbom, 'SPDX');
    if (isSpdxDocument(sbom)) result.sbom = sbom;
    if (!Object.keys(result.labels).length) result.labels = filterOciLabels(imageConfigOf(raw.image)?.Labels);
  } catch (err) {
    toolsErr = (err as Error).message;
  }

  if (localErr && toolsErr) {
    throw new CliError(
      `could not inspect image ${ref} — docker image inspect: ${localErr}; docker buildx imagetools inspect: ${toolsErr}`,
      ExitCode.NOT_FOUND,
    );
  }
  return result;
}

/**
 * Fold an inspection into release build facts. Pure; deterministic key order.
 * The source repository and commit are *not* taken from labels here: a label
 * is typed by the Dockerfile author, provenance is written by the builder, so
 * the caller applies provenance first and falls back to the labels.
 */
export function buildFactsFromInspection(inspection: ImageInspection): Partial<ReleaseBuild> {
  const facts: Partial<ReleaseBuild> = { imageName: inspection.ref };
  if (inspection.configDigest) facts.configDigest = inspection.configDigest;
  if (Object.keys(inspection.labels).length) facts.labels = inspection.labels;
  return facts;
}
