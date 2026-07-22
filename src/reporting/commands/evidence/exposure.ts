// ── Deterministic exposure engine ──
//
// The flagship question: which SHIPPED products contain this vulnerability, at
// which versions, in which markets, still in support? Computed against frozen
// release manifests — never the current source tree.
//
// P1 (determinism): this function is PURE — no filesystem, no network, no clock.
// Identical inputs produce a byte-identical result. No language model touches a
// number here. A missing manifest yields `undetermined` WITH A REASON, never a
// confident "not affected" (a false negative here is a regulatory failure for
// the customer).

import semver from 'semver';
import { canonicalize } from '../../../engine/hash.js';
import { sha256Hex } from '../../../engine/attest.js';
import type {
  Advisory,
  AdvisoryRange,
  AffectedRelease,
  EvidenceOrg,
  ExposureResult,
  ExposureStatus,
  Product,
  ProductExposure,
  Regime,
  Release,
  SupportStatus,
} from './types.js';

export interface ExposureInput {
  regime: Regime;
  advisory: Advisory;
  products: Product[];
  /** Frozen releases keyed by product id. A product with bindings but no
   *  releases here is `undetermined`, not `not-affected`. */
  releasesByProduct: Map<string, Release[]>;
  org: EvidenceOrg;
  /** ISO date the determination is "as of" — drives support-period status. */
  asOf: string;
  dataPackVersion: string;
  /** RFC 3161 is not yet wired in; this is honestly labelled `local-clock`. */
  generatedAt: string;
  /** Restrict to these product ids/names (glob-free simple filter). */
  productFilter?: (product: Product) => boolean;
  /** Include releases whose product support period has expired. */
  includeEol?: boolean;
}

/** Normalise a version so a shipped `1.62.0` or `v1.62` compares cleanly. */
function coerce(version: string): string | null {
  const parsed = semver.parse(version, { loose: true });
  if (parsed) return parsed.version;
  const c = semver.coerce(version);
  return c ? c.version : null;
}

/** Is `version` affected by a single advisory range? [introduced, fixed) + list. */
export function versionAffected(version: string, range: AdvisoryRange): boolean {
  const v = coerce(version);
  if (!v) return false;
  if (range.versions && range.versions.some((x) => coerce(x) === v)) return true;
  // A range with neither bound nor explicit versions matches nothing (we never
  // treat "no data" as "everything affected").
  if (!range.introduced && !range.fixed && !range.versions) return false;
  const introduced = range.introduced ? coerce(range.introduced) : '0.0.0';
  if (!introduced) return false;
  if (semver.lt(v, introduced)) return false;
  if (range.fixed) {
    const fixed = coerce(range.fixed);
    if (!fixed) return false;
    if (semver.gte(v, fixed)) return false;
  }
  return true;
}

function rangeMatchesComponent(range: AdvisoryRange, name: string, ecosystem?: string): boolean {
  if (range.package.toLowerCase() !== name.toLowerCase()) return false;
  if (range.ecosystem && ecosystem && range.ecosystem.toLowerCase() !== ecosystem.toLowerCase()) return false;
  return true;
}

function supportStatusFor(product: Product, asOf: string): { status: SupportStatus; detail?: string } {
  const sp = product.supportPeriod;
  if (!sp || !sp.declaredUntil) return { status: 'not_declared' };
  const until = sp.declaredUntil;
  if (asOf > until) return { status: 'expired', detail: `expired_on ${until}` };
  return { status: 'in_support', detail: `until ${until}` };
}

/** Deterministic evidence id derived from the exact inputs (not random). */
function deriveEvidenceId(input: ExposureInput, products: ProductExposure[]): string {
  const seed = canonicalize({
    regime: input.regime.id,
    advisory: {
      id: input.advisory.id,
      ranges: input.advisory.ranges,
      source: input.advisory.sourceProvenance,
    },
    asOf: input.asOf,
    products,
  });
  // 26-char Crockford-base32-ish id from the hash, ULID-shaped but reproducible.
  const hex = sha256Hex(seed);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let id = '';
  for (let i = 0; i < 26; i++) {
    id += alphabet[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  }
  return id;
}

export function computeExposure(input: ExposureInput): ExposureResult {
  const products = input.productFilter ? input.products.filter(input.productFilter) : input.products;

  const productExposures: ProductExposure[] = products.map((product) => {
    const support = supportStatusFor(product, input.asOf);
    const releases = input.releasesByProduct.get(product.id) ?? [];

    // No frozen manifest for a bound product → we cannot answer. Never guess.
    if (product.bindings.length > 0 && releases.length === 0) {
      return {
        productId: product.id,
        productName: product.name,
        classification: product.classification,
        status: 'undetermined',
        reason: 'no frozen release manifest for this product — run `vg evidence release` before you can answer',
        affectedVersions: [],
        releases: [],
        memberStates: product.memberStates,
        supportStatus: support.status,
        supportDetail: support.detail,
      };
    }

    const affectedReleases: AffectedRelease[] = [];
    const affectedVersions = new Set<string>();
    for (const release of releases) {
      if (!input.includeEol && support.status === 'expired') continue;
      for (const component of release.components) {
        const hit = input.advisory.ranges.find(
          (range) => rangeMatchesComponent(range, component.name, component.ecosystem) && versionAffected(component.version, range),
        );
        if (hit) {
          affectedVersions.add(release.version);
          affectedReleases.push({
            version: release.version,
            shipDate: release.shipDate,
            buildId: release.buildId,
            artefactDigest: release.artefactDigest,
            markets: release.distribution.length ? release.distribution : product.memberStates,
            matchedComponent: { name: component.name, version: component.version },
          });
        }
      }
    }

    const status: ExposureStatus = affectedReleases.length > 0 ? 'affected' : 'not-affected';
    return {
      productId: product.id,
      productName: product.name,
      classification: product.classification,
      status,
      affectedVersions: [...affectedVersions].sort(semver.compareLoose),
      releases: affectedReleases.sort((a, b) => semver.compareLoose(a.version, b.version)),
      memberStates: product.memberStates,
      supportStatus: support.status,
      supportDetail: support.detail,
    };
  });

  const anyAffected = productExposures.some((p) => p.status === 'affected');
  const anyUndetermined = productExposures.some((p) => p.status === 'undetermined');
  const overallStatus: ExposureStatus = anyAffected ? 'affected' : anyUndetermined ? 'undetermined' : 'not-affected';

  const filingPerson = input.org.responsiblePersons.find((p) => p.filingAuthority) ?? input.org.responsiblePersons[0];

  const evidenceId = deriveEvidenceId(input, productExposures);

  return {
    schemaVersion: 'evidence-1',
    regime: input.regime.id,
    advisory: {
      id: input.advisory.id,
      sourceProvenance: input.advisory.sourceProvenance,
      kevListed: Boolean(input.advisory.kevListedAt),
    },
    overallStatus,
    products: productExposures,
    coordinatorCsirt: input.org.coordinatorCsirt,
    responsiblePerson: filingPerson
      ? { name: filingPerson.name, filingAuthority: filingPerson.filingAuthority }
      : undefined,
    meta: {
      evidenceId,
      dataPackVersion: input.dataPackVersion,
      kernelVersion: 'evidence-1',
      timestamp: { source: 'local-clock', value: input.generatedAt },
    },
  };
}

/**
 * The exposure result's subject digest — the deterministic answer, with the
 * volatile `meta` (timestamp, ids) excluded, so two runs over identical inputs
 * attest to the same digest. Mirrors the graph attestation's approach.
 */
export function exposureSubjectDigest(result: ExposureResult): string {
  const { meta: _omit, ...rest } = result;
  return sha256Hex(canonicalize(rest));
}
