import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRegime, listRegimes, getRegime } from './regimes.js';
import { computeExposure, versionAffected, exposureSubjectDigest, type ExposureInput } from './exposure.js';
import { computeReadiness } from './readiness.js';
import { buildRelease, componentsFromArtifact, componentsFromCycloneDx, componentsFromSource } from './release.js';
import type { Exec } from './buildkit.js';
import { buildEvidenceStatement, signEvidenceStatement, verifyEvidenceEnvelope } from './bundle.js';
import { osvToAdvisory } from './advisory.js';
import { buildTimeStampReq, parseTimestampToken, verifyTimestamp } from './tsa.js';
import type { Advisory, EvidenceOrg, Product, Release } from './types.js';

const org: EvidenceOrg = {
  defaultRegime: 'cra',
  coordinatorCsirt: 'NCSC-NL',
  responsiblePersons: [{ name: 'Alex', filingAuthority: true, outOfHoursContact: 'alex@oncall' }],
};

function product(over: Partial<Product> = {}): Product {
  return {
    id: 'sentinelgate',
    name: 'SentinelGate',
    classification: 'default',
    memberStates: ['DE', 'FR'],
    bindings: ['repo:acme/sentinelgate'],
    supportPeriod: { declaredUntil: '2030-01-01' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function release(over: Partial<Release> = {}): Release {
  return {
    productId: 'sentinelgate',
    version: '4.2.0',
    shipDate: '2026-02-01',
    manifestFormat: 'vibgrate-frozen-1',
    components: [{ name: 'netty', version: '4.1.104', ecosystem: 'Maven' }],
    distribution: ['DE', 'FR'],
    frozenAt: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

const advisory: Advisory = {
  id: 'CVE-2026-48282',
  ranges: [{ ecosystem: 'Maven', package: 'netty', introduced: '4.1.0', fixed: '4.1.110' }],
  sourceProvenance: 'test',
};

function baseInput(over: Partial<ExposureInput> = {}): ExposureInput {
  return {
    regime: resolveRegime('cra'),
    advisory,
    products: [product()],
    releasesByProduct: new Map([['sentinelgate', [release()]]]),
    org,
    asOf: '2026-07-22',
    dataPackVersion: '2026.07.19',
    generatedAt: '2026-07-22T10:00:00.000Z',
    ...over,
  };
}

describe('regimes', () => {
  it('bundles CRA as the first regime and validates ids', () => {
    expect(getRegime('cra')?.name).toContain('Cyber Resilience Act');
    expect(resolveRegime('cra').clocks.map((c) => c.within)).toEqual(['PT24H', 'PT72H', 'P14D']);
    expect(listRegimes().length).toBeGreaterThanOrEqual(2);
  });
  it('throws an actionable error for an unknown regime', () => {
    expect(() => resolveRegime('nope')).toThrow(/unknown regime/);
  });
});

describe('versionAffected', () => {
  it('matches a semver range [introduced, fixed)', () => {
    const r = { package: 'netty', introduced: '4.1.0', fixed: '4.1.110' };
    expect(versionAffected('4.1.104', r)).toBe(true);
    expect(versionAffected('4.1.110', r)).toBe(false); // fixed is exclusive
    expect(versionAffected('4.0.9', r)).toBe(false);
  });
  it('matches explicit versions and never treats no-data as affected', () => {
    expect(versionAffected('1.2.3', { package: 'x', versions: ['1.2.3'] })).toBe(true);
    expect(versionAffected('1.2.3', { package: 'x' })).toBe(false);
  });
});

describe('computeExposure', () => {
  it('reports a shipped release as affected', () => {
    const result = computeExposure(baseInput());
    expect(result.overallStatus).toBe('affected');
    expect(result.products[0].affectedVersions).toEqual(['4.2.0']);
    expect(result.products[0].supportStatus).toBe('in_support');
    expect(result.coordinatorCsirt).toBe('NCSC-NL');
    expect(result.responsiblePerson).toEqual({ name: 'Alex', filingAuthority: true });
  });

  it('returns not-affected when no component matches', () => {
    const result = computeExposure(baseInput({ releasesByProduct: new Map([['sentinelgate', [release({ components: [{ name: 'left-pad', version: '1.3.0', ecosystem: 'npm' }] })]]]) }));
    expect(result.overallStatus).toBe('not-affected');
  });

  it('returns undetermined (never a false clean) when a bound product has no frozen manifest', () => {
    const result = computeExposure(baseInput({ releasesByProduct: new Map([['sentinelgate', []]]) }));
    expect(result.overallStatus).toBe('undetermined');
    expect(result.products[0].reason).toMatch(/no frozen release manifest/);
  });

  it('is deterministic — identical inputs give a byte-identical result (excluding meta)', () => {
    const a = computeExposure(baseInput({ generatedAt: '2020-01-01T00:00:00.000Z' }));
    const b = computeExposure(baseInput({ generatedAt: '2099-12-31T23:59:59.000Z' }));
    expect(exposureSubjectDigest(a)).toBe(exposureSubjectDigest(b));
    expect(a.meta.evidenceId).toBe(b.meta.evidenceId); // id derived from inputs, not the clock
  });

  it('excludes expired releases unless --include-eol', () => {
    const expiredProduct = product({ supportPeriod: { declaredUntil: '2026-01-01' } });
    const inp = baseInput({ products: [expiredProduct] });
    expect(computeExposure(inp).overallStatus).toBe('not-affected');
    expect(computeExposure({ ...inp, includeEol: true }).overallStatus).toBe('affected');
  });
});

describe('readiness', () => {
  it('scores a fully-configured org at 100% and flags gaps otherwise', () => {
    const configured = product({ scopeDetermination: { inScope: true, rationale: 'ships firmware', determinedAt: '2026-01-01' } });
    const full = computeReadiness({ regime: resolveRegime('cra'), org, products: [configured], releasesByProduct: new Map([['sentinelgate', [release()]]]), recentDrill: true });
    expect(full.score).toBe(100);

    const bare = computeReadiness({ regime: resolveRegime('cra'), org: { defaultRegime: 'cra', responsiblePersons: [] }, products: [], releasesByProduct: new Map() });
    expect(bare.score).toBeLessThan(100);
    expect(bare.items.find((i) => i.id === 'coordinator-csirt')?.status).toBe('gap');
  });
});

describe('release freezing', () => {
  it('extracts components from a scan artifact with the right ecosystem', () => {
    const artifact = { projects: [{ type: 'node', dependencies: [{ package: 'netty', resolvedVersion: '4.1.104', currentSpec: '^4.1.0' }] }] };
    const comps = componentsFromArtifact(artifact as never);
    expect(comps).toEqual([{ name: 'netty', version: '4.1.104', ecosystem: 'npm', purl: 'pkg:npm/netty@4.1.104' }]);
  });
  it('extracts components from a CycloneDX SBOM', () => {
    const comps = componentsFromCycloneDx({ components: [{ name: 'netty', version: '4.1.104', purl: 'pkg:maven/io.netty/netty@4.1.104' }] });
    expect(comps[0]).toMatchObject({ name: 'netty', version: '4.1.104', ecosystem: 'Maven' });
  });
  it('extracts components from an SPDX document and from an SBOM attestation', () => {
    const spdx = { spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [{ name: 'netty', versionInfo: '4.1.104', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:maven/io.netty/netty@4.1.104' }] }] };
    expect(componentsFromSource(spdx, 'sbom.spdx.json')).toEqual({ attested: false, components: [{ name: 'netty', version: '4.1.104', purl: 'pkg:maven/io.netty/netty@4.1.104', ecosystem: 'Maven' }] });
    const statement = { _type: 'https://in-toto.io/Statement/v0.1', subject: [], predicateType: 'https://spdx.dev/Document', predicate: spdx };
    const envelope = { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [] };
    expect(componentsFromSource(envelope, 'sbom.att.json')).toMatchObject({ attested: true, components: [{ name: 'netty' }] });
    expect(() => componentsFromSource({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1', predicate: {} }, 'p.json')).toThrow(/pass it with --provenance/);
    expect(() => componentsFromSource({ hello: 1 }, 'x.json')).toThrow(/unrecognised source format/);
  });
});

describe('release freezing from BuildKit outputs', () => {
  const DIGEST = 'sha256:' + '11'.repeat(32);
  const CONFIG = 'sha256:' + '22'.repeat(32);
  const provenance = {
    buildType: 'https://mobyproject.org/buildkit@v1',
    builder: { id: 'https://github.com/acme/web/actions/runs/7' },
    materials: [
      { uri: 'pkg:docker/node@22-alpine?platform=linux%2Famd64', digest: { sha256: '33'.repeat(32) } },
      { uri: 'git+https://github.com/acme/web@refs/heads/main', digest: { sha1: 'deadbeef' } },
    ],
  };
  const spdx = { spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [{ name: 'left-pad', versionInfo: '1.3.0', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/left-pad@1.3.0' }] }] };
  const base = { productId: 'sentinelgate', version: '3.2.1', distribution: ['DE'], frozenAt: '2026-09-09T00:00:00.000Z' };

  function tmp(files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-evidence-'));
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
    return dir;
  }

  it('takes digest and build ref from --metadata-file and provenance from an attestation', async () => {
    const dir = tmp({
      'meta.json': { 'buildx.build.ref': 'b0/n0/ref1', 'containerimage.digest': DIGEST, 'containerimage.config.digest': CONFIG, 'image.name': 'ghcr.io/acme/web:3.2.1' },
      'prov.json': { _type: 'https://in-toto.io/Statement/v0.1', subject: [], predicateType: 'https://slsa.dev/provenance/v0.2', predicate: provenance },
      'sbom.json': spdx,
    });
    const release = await buildRelease({ ...base, from: path.join(dir, 'sbom.json'), fromExplicit: true, buildkitMetadata: path.join(dir, 'meta.json'), provenance: path.join(dir, 'prov.json') });
    expect(release.artefactDigest).toBe(DIGEST);
    expect(release.buildId).toBe('b0/n0/ref1');
    expect(release.components).toEqual([{ name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', ecosystem: 'npm' }]);
    expect(release.build).toEqual({
      sources: ['buildx-metadata', 'provenance-attestation'],
      signature: 'unverified',
      imageName: 'ghcr.io/acme/web:3.2.1',
      configDigest: CONFIG,
      buildRef: 'b0/n0/ref1',
      builderId: 'https://github.com/acme/web/actions/runs/7',
      buildType: 'https://mobyproject.org/buildkit@v1',
      sourceUri: 'https://github.com/acme/web',
      sourceRevision: 'deadbeef',
      baseImages: [{ ref: 'node@22-alpine', digest: 'sha256:' + '33'.repeat(32) }],
    });
  });

  it('refuses a typed --digest that contradicts what the build wrote', async () => {
    const dir = tmp({ 'meta.json': { 'containerimage.digest': DIGEST }, 'sbom.json': spdx });
    await expect(buildRelease({ ...base, from: path.join(dir, 'sbom.json'), artefactDigest: 'sha256:' + 'ff'.repeat(32), buildkitMetadata: path.join(dir, 'meta.json') })).rejects.toThrow(/artefact digest mismatch/);
  });

  it('records no build block when only --from was given', async () => {
    const dir = tmp({ 'sbom.json': spdx });
    const release = await buildRelease({ ...base, from: path.join(dir, 'sbom.json') });
    expect(release.build).toBeUndefined();
    expect(release.artefactDigest).toBeUndefined();
  });

  it('freezes from a local image: repo digest, OCI labels, attached provenance and SBOM', async () => {
    const exec: Exec = async (_file, args) => {
      if (args[0] === 'image') {
        return { stdout: JSON.stringify([{ Id: CONFIG, RepoDigests: [`ghcr.io/acme/web@${DIGEST}`], Config: { Labels: { 'org.opencontainers.image.source': 'https://github.com/acme/web', 'org.opencontainers.image.revision': 'deadbeef' } } }]) };
      }
      return { stdout: JSON.stringify({ manifest: { digest: DIGEST }, Provenance: { SLSA: provenance }, SBOM: { SPDX: spdx } }) };
    };
    const release = await buildRelease({ ...base, from: '/nonexistent/scan_result.json', image: 'ghcr.io/acme/web:3.2.1', exec });
    expect(release.artefactDigest).toBe(DIGEST);
    expect(release.components.map((c) => c.name)).toEqual(['left-pad']);
    expect(release.build).toMatchObject({
      sources: ['image-inspect', 'provenance-attestation', 'sbom-attestation'],
      imageName: 'ghcr.io/acme/web:3.2.1',
      configDigest: CONFIG,
      sourceUri: 'https://github.com/acme/web',
      sourceRevision: 'deadbeef',
      labels: { 'org.opencontainers.image.revision': 'deadbeef', 'org.opencontainers.image.source': 'https://github.com/acme/web' },
      baseImages: [{ ref: 'node@22-alpine' }],
    });
  });

  it('prefers the builder\'s provenance over an author-typed label for the source commit', async () => {
    const exec: Exec = async (_file, args) => {
      if (args[0] === 'image') return { stdout: JSON.stringify([{ Id: CONFIG, RepoDigests: [], Config: { Labels: { 'org.opencontainers.image.revision': 'stale-label' } } }]) };
      return { stdout: JSON.stringify({ manifest: { digest: DIGEST }, Provenance: { SLSA: provenance }, SBOM: { SPDX: spdx } }) };
    };
    const release = await buildRelease({ ...base, from: '/nonexistent/scan_result.json', image: 'web:local', exec });
    expect(release.build?.sourceRevision).toBe('deadbeef');
    expect(release.build?.labels).toEqual({ 'org.opencontainers.image.revision': 'stale-label' });
    // No repo digest for a never-pushed image: the index digest from imagetools is the artefact identity.
    expect(release.artefactDigest).toBe(DIGEST);
    expect(release.build?.configDigest).toBe(CONFIG);
  });

  it('is actionable when the image has no SBOM and --from does not exist', async () => {
    const exec: Exec = async () => ({ stdout: JSON.stringify({ manifest: { digest: DIGEST } }) });
    await expect(buildRelease({ ...base, from: '/nonexistent/scan_result.json', image: 'ghcr.io/acme/web:3.2.1', exec })).rejects.toThrow(/carries no SBOM attestation.*build with --sbom=true/);
  });
});

describe('advisory ingestion', () => {
  it('converts an OSV vuln into a Vibgrate advisory', () => {
    const adv = osvToAdvisory({ id: 'GHSA-xxxx', affected: [{ package: { name: 'netty', ecosystem: 'Maven' }, ranges: [{ events: [{ introduced: '4.1.0' }, { fixed: '4.1.110' }] }] }] }, 'osv');
    expect(adv.ranges[0]).toMatchObject({ package: 'netty', introduced: '4.1.0', fixed: '4.1.110' });
  });
});

describe('evidence bundle signing', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('round-trips: verified with a pinned key, unverified without', () => {
    const result = computeExposure(baseInput());
    const env = signEvidenceStatement(buildEvidenceStatement(result, '1.0.0'), privateKey);
    expect(verifyEvidenceEnvelope(env, { publicKeyPem: pubPem, result }).status).toBe('verified');
    expect(verifyEvidenceEnvelope(env, { result }).status).toBe('unverified'); // integrity-only, signer not pinned
  });

  it('fails when the result no longer matches the signed digest', () => {
    const result = computeExposure(baseInput());
    const env = signEvidenceStatement(buildEvidenceStatement(result, '1.0.0'), privateKey);
    const tampered = { ...result, products: [{ ...result.products[0], affectedVersions: ['9.9.9'] }] };
    expect(verifyEvidenceEnvelope(env, { publicKeyPem: pubPem, result: tampered }).status).toBe('failed');
  });

  it('fails on a malformed envelope without crashing', () => {
    expect(verifyEvidenceEnvelope({ payloadType: 'x', payload: 'not-base64-json', signatures: [] }).status).toBe('failed');
  });
});

describe('RFC 3161 timestamping', () => {
  // Minimal DER helpers to synthesize a token for the parser test.
  const lenBytes = (n: number): Buffer => {
    if (n < 0x80) return Buffer.from([n]);
    const a: number[] = [];
    let v = n;
    while (v > 0) { a.unshift(v & 0xff); v >>>= 8; }
    return Buffer.from([0x80 | a.length, ...a]);
  };
  const der = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), lenBytes(content.length), content]);
  const OID_SHA256 = Buffer.from('608648016503040201', 'hex');

  function synthToken(digest: Buffer, genTime: string): Buffer {
    const algId = der(0x30, Buffer.concat([der(0x06, OID_SHA256), der(0x05, Buffer.alloc(0))]));
    const messageImprint = der(0x30, Buffer.concat([algId, der(0x04, digest)]));
    const tstInfo = der(0x30, Buffer.concat([
      der(0x02, Buffer.from([1])),                 // version
      der(0x06, Buffer.from('2a0304', 'hex')),     // policy OID (arbitrary)
      messageImprint,
      der(0x02, Buffer.from([0x2a])),              // serial
      der(0x18, Buffer.from(genTime, 'ascii')),    // GeneralizedTime
    ]));
    // Wrap like a TimeStampResp: SEQ( INTEGER status, OCTETSTRING(tstInfo) )
    return der(0x30, Buffer.concat([der(0x02, Buffer.from([0])), der(0x04, tstInfo)]));
  }

  const digest = crypto.createHash('sha256').update('hello world').digest();

  it('builds a TimeStampReq that embeds the digest', () => {
    const req = buildTimeStampReq(digest);
    expect(req[0]).toBe(0x30); // SEQUENCE
    expect(req.includes(digest)).toBe(true);
  });

  it('parses a token to its imprint and genTime', () => {
    const token = synthToken(digest, '20260722100000Z');
    const parsed = parseTimestampToken(token);
    expect(parsed.imprintHex).toBe(digest.toString('hex'));
    expect(parsed.genTime).toBe('2026-07-22T10:00:00Z');
  });

  it('verifies imprint match and rejects a mismatched digest', () => {
    const token = synthToken(digest, '20260722100000Z');
    expect(verifyTimestamp(token, digest.toString('hex')).imprintMatches).toBe(true);
    expect(verifyTimestamp(token, 'deadbeef').imprintMatches).toBe(false);
  });
})
