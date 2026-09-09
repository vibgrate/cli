// ── `vg evidence push` payload (evidence-push-2) ──
//
// What Vibgrate Cloud receives. Version 2 carries the frozen release manifests
// themselves — components, artefact digest, build facts — and, when a signed
// bundle is pushed, the DSSE envelope and RFC 3161 token so the server can
// verify the signature rather than take a flag's word for it. Version 1 sent
// product rows with a release count only.
//
// Pure: no I/O, no clock. The command reads files and calls `buildPushPayload`.

import type { DsseEnvelope } from '../../../engine/attest.js';
import type { ExposureResult, Product, Release, ReleaseBuild } from './types.js';

export const PUSH_SCHEMA_VERSION = 'evidence-push-2' as const;

/** The API rejects bodies above 10 MB; leave headroom for JSON overhead. */
export const PUSH_BODY_BUDGET_BYTES = 9 * 1024 * 1024;

export interface PushProduct {
  id: string;
  name: string;
  classification: string;
  inScope?: boolean;
  scopeRecorded: boolean;
  memberStates: string[];
  supportDeclared: boolean;
  supportUntil?: string;
  bound: boolean;
  frozenReleaseCount: number;
}

export interface PushComponent {
  name: string;
  version: string;
  ecosystem?: string;
  purl?: string;
}

export interface PushRelease {
  productId: string;
  version: string;
  shipDate?: string;
  buildId?: string;
  artefactDigest?: string;
  manifestFormat: Release['manifestFormat'];
  distribution: string[];
  frozenAt: string;
  componentCount: number;
  components: PushComponent[];
  /** Set when the body budget forced this release's components to be dropped. */
  componentsOmitted?: boolean;
  build?: ReleaseBuild;
}

export interface PushAttestation {
  /** The DSSE envelope from `evidence.intoto.jsonl`, verbatim. */
  envelope: DsseEnvelope;
  /** `timestamp.tsr`, base64. */
  timestampToken?: string;
}

export interface PushPayload {
  schemaVersion: typeof PUSH_SCHEMA_VERSION;
  regime: string;
  generatedAt: string;
  /** Kept for the v1 reader: true only when an envelope is included. */
  signed: boolean;
  products: PushProduct[];
  releases: PushRelease[];
  exposure?: ExposureResult;
  attestation?: PushAttestation;
}

export interface BuildPushInput {
  regime: string;
  generatedAt: string;
  products: Product[];
  releases: Release[];
  exposure?: ExposureResult;
  attestation?: PushAttestation;
  /** Leave the manifests out (`--no-releases`); products still carry the count. */
  includeReleases?: boolean;
  bodyBudgetBytes?: number;
}

export function pushProduct(p: Product, frozenReleaseCount: number): PushProduct {
  return {
    id: p.id,
    name: p.name,
    classification: p.classification,
    inScope: p.scopeDetermination?.inScope,
    scopeRecorded: Boolean(p.scopeDetermination),
    memberStates: p.memberStates,
    supportDeclared: Boolean(p.supportPeriod?.declaredUntil),
    supportUntil: p.supportPeriod?.declaredUntil,
    bound: p.bindings.length > 0,
    frozenReleaseCount,
  };
}

export function pushRelease(r: Release): PushRelease {
  return {
    productId: r.productId,
    version: r.version,
    shipDate: r.shipDate,
    buildId: r.buildId,
    artefactDigest: r.artefactDigest,
    manifestFormat: r.manifestFormat,
    distribution: r.distribution,
    frozenAt: r.frozenAt,
    componentCount: r.components.length,
    components: r.components.map((c) => ({ name: c.name, version: c.version, ecosystem: c.ecosystem, purl: c.purl })),
    ...(r.build ? { build: r.build } : {}),
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Assemble the payload. Releases are sorted oldest-frozen first so that, when
 * the body budget is exceeded, components are dropped from the oldest
 * manifests first and the newest shipped releases arrive complete. A release
 * whose components were dropped says so (`componentsOmitted`) and still
 * carries its digest, build facts and count — never silently thinner.
 */
export function buildPushPayload(input: BuildPushInput): { payload: PushPayload; omittedComponentsFor: string[] } {
  const countByProduct = new Map<string, number>();
  for (const r of input.releases) countByProduct.set(r.productId, (countByProduct.get(r.productId) ?? 0) + 1);

  const products = input.products.map((p) => pushProduct(p, countByProduct.get(p.id) ?? 0));
  const releases = (input.includeReleases === false ? [] : input.releases)
    .map(pushRelease)
    .sort((a, b) => a.frozenAt.localeCompare(b.frozenAt) || a.productId.localeCompare(b.productId) || a.version.localeCompare(b.version));

  const payload: PushPayload = {
    schemaVersion: PUSH_SCHEMA_VERSION,
    regime: input.regime,
    generatedAt: input.generatedAt,
    signed: Boolean(input.attestation?.envelope),
    products,
    releases,
    ...(input.exposure ? { exposure: input.exposure } : {}),
    ...(input.attestation ? { attestation: input.attestation } : {}),
  };

  const budget = input.bodyBudgetBytes ?? PUSH_BODY_BUDGET_BYTES;
  const omittedComponentsFor: string[] = [];
  for (const r of releases) {
    if (bytes(payload) <= budget) break;
    if (!r.components.length) continue;
    r.components = [];
    r.componentsOmitted = true;
    omittedComponentsFor.push(`${r.productId}@${r.version}`);
  }
  return { payload, omittedComponentsFor };
}

/** What the API answers; fields beyond `status` are optional so an older server still reads. */
export interface PushResponse {
  status: 'ok' | 'error';
  ingestId?: string;
  receivedAt?: string;
  error?: string;
  releases?: number;
  components?: number;
  attestation?: { state: 'intact' | 'failed' | 'absent'; reason?: string };
}

/** One line for the terminal, from what the server confirmed rather than what we sent. */
export function describePushResult(payload: PushPayload, res: PushResponse): string {
  const bits = [`${payload.products.length} product(s)`];
  const releases = res.releases ?? payload.releases.length;
  if (releases) {
    const components = res.components ?? payload.releases.reduce((n, r) => n + r.components.length, 0);
    bits.push(`${releases} frozen release(s)${components ? ` · ${components} components` : ''}`);
  }
  if (payload.exposure) {
    const state = res.attestation?.state ?? (payload.attestation ? 'sent for verification' : 'absent');
    bits.push(`an exposure result (signature ${state})`);
  }
  return bits.join(', ');
}
