import { describe, expect, it } from 'vitest';
import { sanitizeInventory } from './surface-provider.js';

/**
 * The surface catalog is separately distributed code, so nothing it returns is
 * taken on faith before it reaches a stored scan artifact. These are the
 * negative cases: the shapes a compromised, buggy, or simply newer module
 * could hand back, and what must happen to each.
 */
const AT = '2026-09-11T00:00:00.000Z';

/**
 * Credential-shaped values, assembled at runtime. A literal one must not live
 * in the repository even as a fixture (GUARDRAILS §6), but the redaction tests
 * below have to feed the sanitiser exactly such a value to prove it drops it.
 */
const FAKE_STRIPE_KEY = ['sk', 'live', 'a'.repeat(12)].join('_');
const FAKE_GITHUB_TOKEN = ['ghp', 'b'.repeat(20)].join('_');

function surface(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'abc123',
    kind: 'saas',
    provider: { id: 'stripe', displayName: 'Stripe', iconId: 'Stripe', category: 'payment' },
    detectedId: 'stripe',
    displayName: 'Stripe',
    freshness: { status: 'unknown', detected: 'stripe', latest: null, alternatives: [] },
    confidence: 'high',
    evidence: [],
    callSites: 0,
    projects: [],
    ...overrides,
  };
}

describe('sanitizeInventory', () => {
  it('keeps a well-formed surface intact', () => {
    const out = sanitizeInventory({ surfaces: [surface()], catalog: { stale: false } }, AT);
    expect(out.schema).toBe('vg-surfaces/1.0');
    expect(out.generatedAt).toBe(AT);
    expect(out.surfaces).toHaveLength(1);
    expect(out.surfaces[0].provider.displayName).toBe('Stripe');
  });

  it('drops anything that still looks like a credential', () => {
    const out = sanitizeInventory(
      {
        surfaces: [
          surface({
            evidence: [{ signal: 'env-key', file: '.env', snippet: `STRIPE_SECRET_KEY=${FAKE_STRIPE_KEY}`, confidence: 1 }],
            metadata: { envKeys: ['STRIPE_SECRET_KEY', FAKE_GITHUB_TOKEN], hosts: ['api.stripe.com'] },
          }),
        ],
      },
      AT,
    );
    const [s] = out.surfaces;
    expect(s.evidence[0].snippet).toBeUndefined();
    expect(s.metadata?.envKeys).toEqual(['STRIPE_SECRET_KEY']);
    expect(JSON.stringify(out)).not.toContain(FAKE_STRIPE_KEY);
    expect(JSON.stringify(out)).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('degrades an unrecognised freshness status to unknown, never to current', () => {
    const out = sanitizeInventory({ surfaces: [surface({ freshness: { status: 'perfect', detected: 'x', latest: null } })] }, AT);
    expect(out.surfaces[0].freshness.status).toBe('unknown');
  });

  it('degrades an unrecognised confidence to low and an unknown category to other', () => {
    const out = sanitizeInventory(
      {
        surfaces: [
          surface({
            confidence: 'certain',
            provider: { id: 'x', displayName: 'X', iconId: 'X', category: 'quantum' },
          }),
        ],
      },
      AT,
    );
    expect(out.surfaces[0].confidence).toBe('low');
    expect(out.surfaces[0].provider.category).toBe('other');
  });

  it('rejects a surface with no provider, no kind, or no detected id', () => {
    const out = sanitizeInventory(
      {
        surfaces: [
          surface({ provider: { id: '' } }),
          surface({ kind: 'telepathy' }),
          surface({ detectedId: '' }),
          surface(),
        ],
      },
      AT,
    );
    expect(out.surfaces).toHaveLength(1);
  });

  it('strips control characters and caps long strings', () => {
    const out = sanitizeInventory(
      {
        surfaces: [
          surface({
            // A NUL and an ANSI escape, written as escapes so this file stays text.
            displayName: `Stripe\u0000\u001b[31m injected`,
            detectedId: 'x'.repeat(500),
          }),
        ],
      },
      AT,
    );
    expect(out.surfaces[0].displayName).toBe('Stripe [31m injected');
    expect(out.surfaces[0].detectedId.length).toBeLessThanOrEqual(160);
  });

  it('bounds the collections a module can return', () => {
    const many = Array.from({ length: 900 }, (_, i) => surface({ detectedId: `p${i}`, provider: { id: `p${i}`, displayName: 'P', iconId: 'P', category: 'other' } }));
    const out = sanitizeInventory(
      {
        surfaces: [
          ...many,
          surface({ evidence: Array.from({ length: 50 }, () => ({ signal: 'env-key', file: 'a', confidence: 1 })) }),
        ],
        unknownHosts: Array.from({ length: 200 }, (_, i) => `h${i}.example.org`),
      },
      AT,
    );
    expect(out.surfaces.length).toBeLessThanOrEqual(500);
    expect(out.unknownHosts).toHaveLength(50);
    for (const s of out.surfaces) expect(s.evidence.length).toBeLessThanOrEqual(12);
  });

  it('treats a missing catalog block as stale rather than fresh', () => {
    expect(sanitizeInventory({}, AT).catalog.stale).toBe(true);
    expect(sanitizeInventory({ catalog: { stale: false } }, AT).catalog.stale).toBe(false);
  });

  it('normalises garbage counts to zero instead of leaking NaN into the artifact', () => {
    const out = sanitizeInventory({ counts: { providers: 'lots', models: -3, behind: 2.7 } }, AT);
    expect(out.counts.providers).toBe(0);
    expect(out.counts.models).toBe(0);
    expect(out.counts.behind).toBe(2);
  });

  it('survives a module returning nothing at all', () => {
    const out = sanitizeInventory(null, AT);
    expect(out.surfaces).toEqual([]);
    expect(out.unknownHosts).toEqual([]);
    expect(out.counts.providers).toBe(0);
  });

  it('sorts surfaces deterministically', () => {
    const out = sanitizeInventory(
      {
        surfaces: [
          surface({ kind: 'model', detectedId: 'gpt-4o', provider: { id: 'openai', displayName: 'OpenAI', iconId: 'OpenAI', category: 'ai' } }),
          surface({ kind: 'api', detectedId: '2024-04-10' }),
          surface({ kind: 'model', detectedId: 'claude-3-5-sonnet', provider: { id: 'anthropic', displayName: 'Anthropic', iconId: 'Anthropic', category: 'ai' } }),
        ],
      },
      AT,
    );
    expect(out.surfaces.map((s) => `${s.kind}:${s.provider.id}`)).toEqual([
      'api:stripe',
      'model:anthropic',
      'model:openai',
    ]);
  });
});
