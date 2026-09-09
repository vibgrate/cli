import { describe, expect, it } from 'vitest';
import { buildPushPayload, describePushResult, PUSH_SCHEMA_VERSION } from './push-payload.js';
import type { Product, Release } from './types.js';

const product: Product = {
  id: 'acme-web',
  name: 'Acme Web',
  classification: 'default',
  memberStates: ['DE'],
  bindings: ['repo:acme/web'],
  supportPeriod: { declaredUntil: '2031-01-01' },
  scopeDetermination: { inScope: true },
  createdAt: '2026-01-01T00:00:00.000Z',
};

function release(version: string, frozenAt: string, n = 3): Release {
  return {
    productId: 'acme-web',
    version,
    shipDate: '2026-02-01',
    artefactDigest: 'sha256:' + 'ab'.repeat(32),
    manifestFormat: 'vibgrate-frozen-1',
    components: Array.from({ length: n }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0', ecosystem: 'npm', purl: `pkg:npm/pkg-${i}@1.0.0` })),
    distribution: ['DE'],
    frozenAt,
    build: { sources: ['buildx-metadata'], signature: 'unverified', imageName: 'ghcr.io/acme/web:' + version },
  };
}

describe('buildPushPayload', () => {
  it('carries products with counts and full release manifests incl. build facts', () => {
    const { payload, omittedComponentsFor } = buildPushPayload({ regime: 'cra', generatedAt: '2026-09-09T00:00:00.000Z', products: [product], releases: [release('4.2.0', '2026-02-01T10:00:00Z'), release('4.1.0', '2025-11-01T10:00:00Z')] });
    expect(payload.schemaVersion).toBe(PUSH_SCHEMA_VERSION);
    expect(payload.signed).toBe(false);
    expect(payload.products[0]).toMatchObject({ id: 'acme-web', bound: true, frozenReleaseCount: 2, supportUntil: '2031-01-01', inScope: true, scopeRecorded: true });
    // Oldest frozen first.
    expect(payload.releases.map((r) => r.version)).toEqual(['4.1.0', '4.2.0']);
    expect(payload.releases[1]).toMatchObject({ componentCount: 3, build: { sources: ['buildx-metadata'], signature: 'unverified' } });
    expect(payload.releases[1].components[0]).toEqual({ name: 'pkg-0', version: '1.0.0', ecosystem: 'npm', purl: 'pkg:npm/pkg-0@1.0.0' });
    expect(omittedComponentsFor).toEqual([]);
  });

  it('drops components oldest-first under the body budget and says so', () => {
    const rels = [release('4.2.0', '2026-02-01T10:00:00Z', 200), release('4.1.0', '2025-11-01T10:00:00Z', 200), release('4.0.0', '2025-06-01T10:00:00Z', 200)];
    const { payload, omittedComponentsFor } = buildPushPayload({ regime: 'cra', generatedAt: 'x', products: [product], releases: rels, bodyBudgetBytes: 20_000 });
    expect(omittedComponentsFor).toEqual(['acme-web@4.0.0', 'acme-web@4.1.0']);
    const by = Object.fromEntries(payload.releases.map((r) => [r.version, r]));
    expect(by['4.0.0']).toMatchObject({ componentsOmitted: true, componentCount: 200, components: [] });
    expect(by['4.2.0'].components).toHaveLength(200);
    expect(by['4.2.0'].componentsOmitted).toBeUndefined();
  });

  it('marks signed only when an envelope is attached, and omits releases on request', () => {
    const envelope = { payloadType: 'application/vnd.in-toto+json', payload: 'e30=', signatures: [{ keyid: 'k', sig: 'AA==' }] };
    const { payload } = buildPushPayload({ regime: 'cra', generatedAt: 'x', products: [product], releases: [release('4.2.0', 'z')], attestation: { envelope }, includeReleases: false });
    expect(payload.signed).toBe(true);
    expect(payload.releases).toEqual([]);
    expect(payload.products[0].frozenReleaseCount).toBe(1);
    expect(payload.attestation?.envelope).toBe(envelope);
  });
});

describe('describePushResult', () => {
  it('reports what the server confirmed', () => {
    const { payload } = buildPushPayload({ regime: 'cra', generatedAt: 'x', products: [product], releases: [release('4.2.0', 'z')], exposure: { meta: {} } as never, attestation: { envelope: { payloadType: 'x', payload: 'e30=', signatures: [] } } });
    expect(describePushResult(payload, { status: 'ok', releases: 1, components: 3, attestation: { state: 'intact' } })).toBe('1 product(s), 1 frozen release(s) · 3 components, an exposure result (signature intact)');
    expect(describePushResult(payload, { status: 'ok' })).toBe('1 product(s), 1 frozen release(s) · 3 components, an exposure result (signature sent for verification)');
  });
});
