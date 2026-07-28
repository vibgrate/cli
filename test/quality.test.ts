import { describe, it, expect } from 'vitest';
import { assessDocQuality, identifierTerms } from '../src/engine/quality.js';

/** A rich, on-topic README: name + runnable example + real prose + the queried symbol. */
function richReadme(): string {
  return [
    '# acme-client',
    'acme-client is a tiny HTTP client for the Acme API.',
    '## Usage',
    '```ts',
    'import { AcmeClient } from "acme-client";',
    'const client = new AcmeClient({ apiKey: "x" });',
    'await client.send("/path", { body: {} });',
    '```',
    'It supports retries, timeouts, and streaming responses out of the box.',
  ].join('\n');
}

describe('assessDocQuality — the local→hosted fall-through gate', () => {
  it('passes a rich, on-topic README (code + length + name + query)', () => {
    // Query terms that actually appear in the README (send + streaming).
    const q = assessDocQuality(richReadme(), { name: 'acme-client', query: 'send streaming' });
    expect(q.sufficient).toBe(true);
    expect(q.reasons).toEqual([]);
    expect(q.score).toBeGreaterThan(3);
  });

  it('fails a stub (no code, too thin) → escalate to hosted', () => {
    const q = assessDocQuality('# tiny\nA package.', { name: 'tiny' });
    expect(q.sufficient).toBe(false);
    expect(q.reasons).toContain('no code example');
    expect(q.reasons.some((r) => r.startsWith('thin'))).toBe(true);
  });

  it('fails when the doc is off-topic for the query (keywords absent)', () => {
    // Has code + length, but nothing about "websockets" → not on-topic → escalate.
    const q = assessDocQuality(richReadme(), { name: 'acme-client', query: 'websocket subscriptions' });
    expect(q.sufficient).toBe(false);
    expect(q.reasons).toContain('query terms absent');
  });

  it('with no query, on-topic is vacuously true (gate = code + length)', () => {
    const q = assessDocQuality(richReadme(), { name: 'acme-client' });
    expect(q.sufficient).toBe(true);
  });

  it('flags a missing library name without blocking sufficiency', () => {
    const q = assessDocQuality(richReadme(), { name: 'totally-different-pkg' });
    expect(q.reasons).toContain('library name absent');
    expect(q.sufficient).toBe(true); // name is a signal, not a hard gate
  });

  it('rewards an API symbol surfacing in the doc', () => {
    const withSym = assessDocQuality(richReadme(), { name: 'acme-client', symbols: ['AcmeClient'] });
    const without = assessDocQuality(richReadme(), { name: 'acme-client' });
    expect(withSym.score).toBeGreaterThan(without.score);
  });

  it('recognises indented (non-fenced) code blocks', () => {
    const indented = ['# pkg', 'usage:', '', '    pkg.run()', '', 'more explanatory prose to clear the token floor for the gate.'].join('\n');
    const q = assessDocQuality(indented, { name: 'pkg' });
    expect(q.reasons).not.toContain('no code example');
  });

  it('is deterministic (same input → same verdict)', () => {
    const a = assessDocQuality(richReadme(), { name: 'acme-client', query: 'send' });
    const b = assessDocQuality(richReadme(), { name: 'acme-client', query: 'send' });
    expect(a).toEqual(b);
  });

  it('fails when an identifier-shaped API term is missing (createMiddleware)', () => {
    // Generic README mentions "middleware" but never createMiddleware.
    const readme = [
      '# hono',
      'Ultrafast web framework.',
      '```ts',
      'import { Hono } from "hono"',
      'const app = new Hono()',
      'app.use("*", async (c, next) => { await next() })',
      '```',
      'It has middleware helpers and JWT utilities described at a high level only.',
      'Plenty of prose so we clear the token floor for the quality gate.',
    ].join('\n');
    const q = assessDocQuality(readme, { name: 'hono', query: 'createMiddleware' });
    expect(q.sufficient).toBe(false);
    expect(q.reasons.some((r) => r.includes('createMiddleware') || r.includes('API symbol'))).toBe(true);
  });

  it('does not green-light a multi-term query on a single word overlap', () => {
    const readme = [
      '# hono',
      'Ultrafast web framework with middleware support.',
      '```ts',
      'import { Hono } from "hono"',
      'const app = new Hono()',
      '```',
      'Middleware runs in order. Nothing here covers bearer tokens or signed cookies.',
      'More filler text to clear the token floor for the quality gate assessment.',
    ].join('\n');
    // "middleware" is present; "websocket" is not → strict majority of 2 fails.
    const q = assessDocQuality(readme, { name: 'hono', query: 'websocket middleware' });
    expect(q.sufficient).toBe(false);
    expect(q.reasons.some((r) => r.includes('query terms weak') || r.includes('absent'))).toBe(true);
  });

  it('README-only + focused API query is never sufficient', () => {
    const q = assessDocQuality(richReadme(), {
      name: 'acme-client',
      query: 'createMiddleware',
      readmeOnly: true,
    });
    expect(q.sufficient).toBe(false);
    expect(q.score).toBeLessThanOrEqual(4);
    expect(q.reasons.some((r) => r.includes('README-only') || r.includes('API symbol'))).toBe(true);
  });

  it('identifierTerms extracts camelCase API symbols', () => {
    expect(identifierTerms('hono createMiddleware JWT')).toContain('createMiddleware');
    expect(identifierTerms('send a request')).toEqual([]);
  });
});
