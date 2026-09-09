import { describe, expect, it } from 'vitest';
import {
  buildFactsFromInspection,
  componentsFromSpdx,
  filterOciLabels,
  inspectImage,
  isValidImageRef,
  parseBuildxMetadata,
  pickAttestation,
  summarizeProvenance,
  unwrapStatement,
  type Exec,
} from './buildkit.js';

const DIGEST = 'sha256:' + 'ab'.repeat(32);
const CONFIG_DIGEST = 'sha256:' + 'cd'.repeat(32);
const BASE_DIGEST = 'ef'.repeat(32);

const provenanceV02 = {
  buildType: 'https://mobyproject.org/buildkit@v1',
  builder: { id: 'https://github.com/acme/web/actions/runs/42' },
  invocation: { configSource: { uri: 'git+https://github.com/acme/web@refs/heads/main', digest: { sha1: 'deadbeef' }, entryPoint: 'Dockerfile' } },
  materials: [
    { uri: 'pkg:docker/node@22-alpine?platform=linux%2Famd64', digest: { sha256: BASE_DIGEST } },
    { uri: 'git+https://github.com/acme/web@refs/heads/main', digest: { sha1: 'deadbeef' } },
  ],
};

const provenanceV1 = {
  buildDefinition: {
    buildType: 'https://mobyproject.org/buildkit@v1',
    resolvedDependencies: [
      { uri: 'git+https://gitlab.com/acme/api.git@refs/tags/v3.2.1', digest: { gitCommit: 'cafebabe' } },
      { uri: 'pkg:docker/python@3.12-slim?platform=linux%2Farm64', digest: { sha256: BASE_DIGEST } },
      { uri: 'pkg:docker/python@3.12-slim?platform=linux%2Famd64', digest: { sha256: BASE_DIGEST } },
    ],
  },
  runDetails: { builder: { id: 'https://builder.example/v1' } },
};

const spdx = {
  spdxVersion: 'SPDX-2.3',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'ghcr.io/acme/web',
  packages: [
    { name: 'ghcr.io/acme/web', versionInfo: DIGEST, SPDXID: 'SPDXRef-image', primaryPackagePurpose: 'CONTAINER' },
    { name: 'left-pad', versionInfo: '1.3.0', SPDXID: 'SPDXRef-1', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/left-pad@1.3.0' }] },
    { name: 'left-pad', versionInfo: '1.3.0', SPDXID: 'SPDXRef-1-dup', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/left-pad@1.3.0' }] },
    { name: 'musl', versionInfo: '1.2.4-r2', SPDXID: 'SPDXRef-2', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:apk/alpine/musl@1.2.4-r2' }] },
    { name: 'no-version', SPDXID: 'SPDXRef-3' },
  ],
};

function statement(predicateType: string, predicate: unknown) {
  return { _type: 'https://in-toto.io/Statement/v0.1', subject: [{ name: 'ghcr.io/acme/web', digest: { sha256: DIGEST.slice(7) } }], predicateType, predicate };
}

function envelope(body: unknown) {
  return { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(body)).toString('base64'), signatures: [{ keyid: '', sig: 'AAAA' }] };
}

describe('parseBuildxMetadata', () => {
  it('reads the digest, config digest, build ref and image name', () => {
    const meta = parseBuildxMetadata({
      'buildx.build.ref': 'builder0/builder00/abc123',
      'containerimage.config.digest': CONFIG_DIGEST,
      'containerimage.descriptor': { mediaType: 'application/vnd.oci.image.index.v1+json', digest: DIGEST, size: 1234 },
      'containerimage.digest': DIGEST,
      'image.name': 'ghcr.io/acme/web:3.2.1,ghcr.io/acme/web:latest',
    });
    expect(meta).toEqual({ imageName: 'ghcr.io/acme/web:3.2.1,ghcr.io/acme/web:latest', digest: DIGEST, configDigest: CONFIG_DIGEST, buildRef: 'builder0/builder00/abc123', provenance: undefined });
  });
  it('falls back to the descriptor digest and carries inline provenance', () => {
    const meta = parseBuildxMetadata({ 'containerimage.descriptor': { digest: DIGEST }, 'buildx.build.provenance': provenanceV02 });
    expect(meta.digest).toBe(DIGEST);
    expect(meta.provenance).toBe(provenanceV02);
  });
  it('rejects a file with no BuildKit fields', () => {
    expect(() => parseBuildxMetadata({ hello: 'world' })).toThrow(/no BuildKit fields/);
    expect(() => parseBuildxMetadata([])).toThrow(/JSON object/);
  });
});

describe('unwrapStatement', () => {
  it('unwraps a DSSE envelope around an in-toto Statement', () => {
    const view = unwrapStatement(envelope(statement('https://spdx.dev/Document', spdx)));
    expect(view?.predicateType).toBe('https://spdx.dev/Document');
    expect(view?.predicate).toEqual(spdx);
    expect(view?.subjects[0]).toEqual({ name: 'ghcr.io/acme/web', digest: { sha256: DIGEST.slice(7) } });
  });
  it('accepts a bare Statement and rejects everything else', () => {
    expect(unwrapStatement(statement('https://slsa.dev/provenance/v0.2', provenanceV02))?.predicateType).toBe('https://slsa.dev/provenance/v0.2');
    expect(unwrapStatement(spdx)).toBeNull();
    expect(unwrapStatement('nope')).toBeNull();
    expect(unwrapStatement(null)).toBeNull();
  });
  it('fails loudly on a payload that is not JSON', () => {
    expect(() => unwrapStatement({ payloadType: 'x', payload: Buffer.from('not json').toString('base64') })).toThrow(/base64-encoded JSON/);
  });
});

describe('summarizeProvenance', () => {
  it('reads source, commit, builder and base images from SLSA v0.2', () => {
    const s = summarizeProvenance(provenanceV02);
    expect(s).toEqual({
      builderId: 'https://github.com/acme/web/actions/runs/42',
      buildType: 'https://mobyproject.org/buildkit@v1',
      sourceUri: 'https://github.com/acme/web',
      sourceRevision: 'deadbeef',
      baseImages: [{ ref: 'node@22-alpine', digest: `sha256:${BASE_DIGEST}` }],
      materialCount: 2,
    });
  });
  it('reads SLSA v1 and de-duplicates per-platform base images deterministically', () => {
    const s = summarizeProvenance(provenanceV1);
    expect(s.sourceUri).toBe('https://gitlab.com/acme/api');
    expect(s.sourceRevision).toBe('cafebabe');
    expect(s.builderId).toBe('https://builder.example/v1');
    expect(s.baseImages).toEqual([{ ref: 'python@3.12-slim', digest: `sha256:${BASE_DIGEST}` }]);
    expect(s.materialCount).toBe(3);
  });
  it('uses configSource when no git material is listed', () => {
    const s = summarizeProvenance({ invocation: { configSource: { uri: 'https://github.com/acme/web.git', digest: { sha1: '0123' } } }, materials: [] });
    expect(s.sourceUri).toBe('https://github.com/acme/web');
    expect(s.sourceRevision).toBe('0123');
  });
  it('is empty, not wrong, for junk', () => {
    expect(summarizeProvenance(undefined)).toEqual({ baseImages: [], materialCount: 0 });
  });
});

describe('componentsFromSpdx', () => {
  it('skips the image package and unversioned entries, de-duplicates, and maps ecosystems', () => {
    expect(componentsFromSpdx(spdx)).toEqual([
      { name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', ecosystem: 'npm' },
      { name: 'musl', version: '1.2.4-r2', purl: 'pkg:apk/alpine/musl@1.2.4-r2', ecosystem: 'Alpine' },
    ]);
  });
});

describe('image inspection helpers', () => {
  it('validates references the way a registry would', () => {
    expect(isValidImageRef('ghcr.io/acme/web:3.2.1')).toBe(true);
    expect(isValidImageRef('localhost:5000/web@' + DIGEST)).toBe(true);
    expect(isValidImageRef('web')).toBe(true);
    expect(isValidImageRef('--rm')).toBe(false);
    expect(isValidImageRef('web; rm -rf /')).toBe(false);
    expect(isValidImageRef('')).toBe(false);
  });
  it('keeps only the standard descriptive labels, sorted', () => {
    expect(filterOciLabels({ 'org.opencontainers.image.source': 'https://github.com/acme/web', 'com.acme.internal': 'x', 'org.opencontainers.image.revision': 'abc', 'org.label-schema.vcs-url': 'y' })).toEqual({
      'org.label-schema.vcs-url': 'y',
      'org.opencontainers.image.revision': 'abc',
      'org.opencontainers.image.source': 'https://github.com/acme/web',
    });
  });
  it('picks attestations directly or from the first platform in sorted order', () => {
    expect(pickAttestation({ SLSA: provenanceV02 }, 'SLSA')).toBe(provenanceV02);
    expect(pickAttestation({ 'linux/arm64': { SLSA: provenanceV1 }, 'linux/amd64': { SLSA: provenanceV02 } }, 'SLSA')).toBe(provenanceV02);
    expect(pickAttestation(undefined, 'SPDX')).toBeUndefined();
  });
});

function fakeDocker(responses: Record<string, unknown>): Exec {
  return async (file, args) => {
    expect(file).toBe('docker');
    const key = args.slice(0, 2).join(' ');
    const r = responses[key];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`No such image: ${args.at(-1)}`);
    return { stdout: JSON.stringify(r) };
  };
}

describe('inspectImage', () => {
  it('merges a local inspect with imagetools attestations', async () => {
    const exec = fakeDocker({
      'image inspect': [{ Id: CONFIG_DIGEST, RepoDigests: [`ghcr.io/acme/web@${DIGEST}`], Config: { Labels: { 'org.opencontainers.image.source': 'https://github.com/acme/web', 'org.opencontainers.image.revision': 'deadbeef', 'com.acme.team': 'edge' } } }],
      'buildx imagetools': { name: 'ghcr.io/acme/web:3.2.1', manifest: { digest: DIGEST }, Provenance: { 'linux/amd64': { SLSA: provenanceV02 } }, SBOM: { 'linux/amd64': { SPDX: spdx } } },
    });
    const result = await inspectImage('ghcr.io/acme/web:3.2.1', exec);
    expect(result.configDigest).toBe(CONFIG_DIGEST);
    expect(result.repoDigests).toEqual([`ghcr.io/acme/web@${DIGEST}`]);
    expect(result.manifestDigest).toBe(DIGEST);
    expect(result.labels).toEqual({ 'org.opencontainers.image.revision': 'deadbeef', 'org.opencontainers.image.source': 'https://github.com/acme/web' });
    expect(result.provenance).toEqual(provenanceV02);
    expect(result.sbom).toEqual(spdx);
    expect(buildFactsFromInspection(result)).toEqual({ imageName: 'ghcr.io/acme/web:3.2.1', configDigest: CONFIG_DIGEST, labels: result.labels });
  });
  it('works for a registry-only reference via imagetools, taking labels from the image config', async () => {
    const exec = fakeDocker({ 'buildx imagetools': { manifest: { digest: DIGEST }, image: { 'linux/amd64': { config: { Labels: { 'org.opencontainers.image.version': '3.2.1' } } } } } });
    const result = await inspectImage('ghcr.io/acme/web:3.2.1', exec);
    expect(result.configDigest).toBeUndefined();
    expect(result.manifestDigest).toBe(DIGEST);
    expect(result.labels).toEqual({ 'org.opencontainers.image.version': '3.2.1' });
  });
  it('is actionable when docker is missing or the image is unknown everywhere', async () => {
    const missing = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    await expect(inspectImage('web:1', fakeDocker({ 'image inspect': missing }))).rejects.toThrow(/docker not found on PATH/);
    await expect(inspectImage('web:1', fakeDocker({}))).rejects.toThrow(/could not inspect image web:1/);
  });
  it('never passes an unsafe reference to docker', async () => {
    let called = false;
    const exec: Exec = async () => {
      called = true;
      return { stdout: '{}' };
    };
    await expect(inspectImage('--rm', exec)).rejects.toThrow(/not a valid image reference/);
    expect(called).toBe(false);
  });
});
