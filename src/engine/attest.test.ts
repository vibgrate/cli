import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import {
  buildStatement,
  signStatement,
  verifyEnvelope,
  generateKeypair,
  graphSubjectDigest,
  serializeEnvelope,
  parseEnvelope,
  dssePae,
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from './attest.js';
import type { VgGraph } from '../schema.js';

function graph(over: Partial<VgGraph> = {}): VgGraph {
  return {
    schemaVersion: 'vg-graph/1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: {
      tool: 'vg',
      version: 't',
      grammars: { ts: 'g@1' },
      resolver: ['heuristic'],
      deep: false,
      corpusHash: 'abc123',
      toolchain: { schema: 'vg-graph/1.0', tool: 't', grammars: 'g@1', resolvers: ['heuristic'], fingerprint: 'fp123' },
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: 1, edges: 0, areas: 0, tests: 0, untested: 1 },
      cluster: 'louvain',
      edgeKinds: [],
    },
    nodes: [],
    edges: [],
    areas: [],
    ...over,
  };
}

describe('graphSubjectDigest', () => {
  it('is independent of the volatile generatedAt', () => {
    const a = graphSubjectDigest(graph({ generatedAt: '2020-01-01T00:00:00Z' }));
    const b = graphSubjectDigest(graph({ generatedAt: '2099-12-31T23:59:59Z' }));
    expect(a).toBe(b);
  });

  it('changes when real content changes', () => {
    const a = graphSubjectDigest(graph());
    const b = graphSubjectDigest(graph({ provenance: { ...graph().provenance, corpusHash: 'different' } }));
    expect(a).not.toBe(b);
  });
});

describe('dssePae', () => {
  it('encodes the DSSE pre-authentication header exactly', () => {
    const body = Buffer.from('hello', 'utf8');
    const pae = dssePae('t', body).toString('utf8');
    expect(pae).toBe('DSSEv1 1 t 5 hello');
  });
});

describe('sign / verify round trip', () => {
  it('verifies a freshly signed envelope against the embedded key', () => {
    const kp = generateKeypair();
    const key = crypto.createPrivateKey(kp.privatePem);
    const g = graph();
    const env = signStatement(buildStatement(g), key);
    expect(env.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(env.signatures[0].keyid).toBe(kp.keyid);

    const r = verifyEnvelope(env, { graph: g });
    expect(r.signatureValid).toBe(true);
    expect(r.digestMatches).toBe(true);
    // No pinned signer → signature-valid, not verified.
    expect(r.status).toBe('signature-valid');
  });

  it('reports verified when the signer is pinned and the tree is clean', () => {
    const kp = generateKeypair();
    const key = crypto.createPrivateKey(kp.privatePem);
    const g = graph();
    const env = signStatement(buildStatement(g, { commit: { sha: 'deadbeef', dirty: false } }), key);
    const r = verifyEnvelope(env, { publicKeyPem: kp.publicPem, graph: g });
    expect(r.status).toBe('verified');
    expect(r.signerPinned).toBe(true);
  });

  it('never reports verified for a dirty tree', () => {
    const kp = generateKeypair();
    const key = crypto.createPrivateKey(kp.privatePem);
    const g = graph();
    const env = signStatement(buildStatement(g, { commit: { sha: 'deadbeef', dirty: true } }), key);
    const r = verifyEnvelope(env, { publicKeyPem: kp.publicPem, graph: g });
    expect(r.status).toBe('signature-valid');
    expect(r.dirty).toBe(true);
  });

  it('fails when the graph content changed since signing', () => {
    const kp = generateKeypair();
    const key = crypto.createPrivateKey(kp.privatePem);
    const env = signStatement(buildStatement(graph()), key);
    const tampered = graph({ provenance: { ...graph().provenance, corpusHash: 'tampered' } });
    const r = verifyEnvelope(env, { publicKeyPem: kp.publicPem, graph: tampered });
    expect(r.status).toBe('failed');
    expect(r.digestMatches).toBe(false);
  });

  it('fails when the signature is corrupted', () => {
    const kp = generateKeypair();
    const key = crypto.createPrivateKey(kp.privatePem);
    const env = signStatement(buildStatement(graph()), key);
    env.signatures[0].sig = Buffer.from('not-the-real-signature').toString('base64');
    const r = verifyEnvelope(env, { publicKeyPem: kp.publicPem });
    expect(r.status).toBe('failed');
    expect(r.signatureValid).toBe(false);
  });

  it('fails against a different (non-signing) public key', () => {
    const signer = crypto.createPrivateKey(generateKeypair().privatePem);
    const other = generateKeypair();
    const env = signStatement(buildStatement(graph()), signer);
    const r = verifyEnvelope(env, { publicKeyPem: other.publicPem });
    expect(r.status).toBe('failed');
  });

  it('reports failed (never throws) on malformed / crafted envelopes', () => {
    // Missing payload, non-JSON payload, garbage embedded key, missing sig —
    // all attacker-reachable; each must degrade to failed, not crash.
    const crafted = [
      {} as never,
      { payloadType: 'x', signatures: [] } as never,
      { payloadType: 'x', payload: 'not-base64-json!!', signatures: [] } as never,
      { payloadType: 'x', payload: Buffer.from('{}').toString('base64'), signatures: [{ keyid: 'a', sig: 'AA', publicKey: 'garbage' }] } as never,
      { payloadType: 'x', payload: Buffer.from(JSON.stringify(buildStatement(graph()))).toString('base64'), signatures: [{ keyid: 'a', sig: 'AA', publicKey: 'garbage' }] } as never,
    ];
    for (const env of crafted) {
      expect(() => verifyEnvelope(env)).not.toThrow();
      expect(verifyEnvelope(env).status).toBe('failed');
    }
  });
});

describe('determinism', () => {
  it('produces a byte-identical envelope for the same graph + key (Ed25519 is deterministic)', () => {
    const key = crypto.createPrivateKey(generateKeypair().privatePem);
    const g = graph();
    const a = serializeEnvelope(signStatement(buildStatement(g), key));
    const b = serializeEnvelope(signStatement(buildStatement(g), key));
    expect(a).toBe(b);
  });

  it('round-trips through serialize/parse', () => {
    const key = crypto.createPrivateKey(generateKeypair().privatePem);
    const env = signStatement(buildStatement(graph()), key);
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed).toEqual(env);
    expect(parsed.payload).toBe(env.payload);
  });

  it('builds an in-toto v1 statement with a graph.json subject', () => {
    const st = buildStatement(graph());
    expect(st._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(st.subject[0].name).toBe('graph.json');
    expect(st.subject[0].digest.sha256).toBe(graphSubjectDigest(graph()));
  });
});
