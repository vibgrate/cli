import { describe, expect, it } from 'vitest';
import { sanitizeModelTable } from './model-catalog-provider.js';

/**
 * The trust boundary. Everything the module hands over crosses here before it
 * can size a token budget or quote a dollar figure, so the tests are mostly
 * about what must be REFUSED.
 *
 * The asymmetry that drives all of it: a context limit that reads too low makes
 * compression work harder than it needs to, while one that reads too high
 * overflows the model and the request fails. So a doubtful row is dropped, and
 * the caller's own conservative default takes over. Nothing here ever clamps a
 * bad value into a plausible one.
 */
const ok = {
  id: 'claude-opus-5',
  family: 'anthropic',
  contextLimit: 1_000_000,
  maxOutput: 128_000,
  billsThinking: true,
  supportsCacheControl: true,
  aliases: ['opus-5'],
  price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

const table = (...models: unknown[]) => ({ version: '2026.09.11', models });

describe('sanitizeModelTable', () => {
  it('passes a well-formed row through intact', () => {
    const out = sanitizeModelTable(table(ok));
    expect(out?.version).toBe('2026.09.11');
    expect(out?.models[0]).toEqual(ok);
  });

  it('drops a row whose context limit is absent, zero, negative or absurd', () => {
    for (const contextLimit of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12, '200000']) {
      const out = sanitizeModelTable(table({ ...ok, contextLimit }));
      expect(out, `contextLimit ${String(contextLimit)} should have been refused`).toBeNull();
    }
  });

  it('never clamps a bad window into a plausible one', () => {
    // Clamping 1e12 down to the cap would hand the caller a 100M-token budget
    // it has no basis for. The row goes, and the default takes over.
    expect(sanitizeModelTable(table({ ...ok, contextLimit: 1e12 }))).toBeNull();
  });

  it('drops a half-price rather than quoting a saving from an invented rate', () => {
    const out = sanitizeModelTable(table({ ...ok, price: { input: 5 } }));
    expect(out?.models[0].price).toBeNull();
  });

  it('keeps an unpublished cache rate as null, never as zero', () => {
    // Zero would quote cache reads as free and understate the real cost.
    const out = sanitizeModelTable(table({ ...ok, price: { input: 5, output: 25 } }));
    expect(out?.models[0].price).toEqual({ input: 5, output: 25, cacheRead: null, cacheWrite: null });
  });

  it('refuses a negative or absurd rate', () => {
    expect(sanitizeModelTable(table({ ...ok, price: { input: -1, output: 25 } }))?.models[0].price).toBeNull();
    expect(sanitizeModelTable(table({ ...ok, price: { input: 5, output: 1e9 } }))?.models[0].price).toBeNull();
  });

  it('strips control characters from ids and aliases', () => {
    // An id reaches logs and error text; a smuggled escape sequence there can
    // rewrite what the reader sees.
    const dirty = { ...ok, id: 'claude\u001b[2K-opus-5', aliases: ['opus\u0000-5'] };
    const out = sanitizeModelTable(table(dirty));
    expect(out?.models[0].id).toBe('claude[2k-opus-5');
    expect(out?.models[0].aliases).toEqual(['opus-5']);
  });

  it('lowercases ids so resolution is case-insensitive', () => {
    expect(sanitizeModelTable(table({ ...ok, id: 'Claude-Opus-5' }))?.models[0].id).toBe('claude-opus-5');
  });

  it('drops an alias that shadows its own id', () => {
    const out = sanitizeModelTable(table({ ...ok, aliases: ['claude-opus-5', 'opus-5'] }));
    expect(out?.models[0].aliases).toEqual(['opus-5']);
  });

  it('keeps the first of a duplicated id rather than letting a later row win', () => {
    const out = sanitizeModelTable(table(ok, { ...ok, contextLimit: 1000 }));
    expect(out?.models).toHaveLength(1);
    expect(out?.models[0].contextLimit).toBe(1_000_000);
  });

  it('treats a malformed table as no table at all', () => {
    for (const raw of [null, undefined, 42, 'nope', {}, { models: 'nope' }, { models: [] }, { models: [null, 7] }]) {
      expect(sanitizeModelTable(raw), `${JSON.stringify(raw)} should have been refused`).toBeNull();
    }
  });

  it('coerces booleans rather than trusting a truthy value', () => {
    const out = sanitizeModelTable(table({ ...ok, billsThinking: 'yes', supportsCacheControl: 1 }));
    expect(out?.models[0].billsThinking).toBe(false);
    expect(out?.models[0].supportsCacheControl).toBe(false);
  });
});
