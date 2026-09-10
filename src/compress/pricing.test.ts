import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BLENDED_PRICE, costUsd, inferPrice, priceFor, savingsUsd } from './pricing.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpEnv(): NodeJS.ProcessEnv {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pricing-'));
  dirs.push(d);
  return { VG_CONTEXT_DIR: d };
}

describe('priceFor', () => {
  it('returns table prices with cache rates', () => {
    const env = tmpEnv();
    expect(priceFor('claude-opus-5', env)).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(priceFor('claude-fable-5-1', env)).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(priceFor('gpt-4o', env)).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 });
    expect(priceFor('gpt-4', env).cacheRead).toBe(15);
  });
  it('resolves aliases, gateway ids and dated snapshots', () => {
    const env = tmpEnv();
    expect(priceFor('claude-haiku-4-5-20251001', env).input).toBe(1);
    expect(priceFor('openrouter/openai/gpt-4o-mini', env).input).toBe(0.15);
    expect(priceFor('us.anthropic.claude-sonnet-4-6-v1:0', env).input).toBe(3);
  });
  it('infers unknown ids and falls back to the blended rate', () => {
    expect(inferPrice('claude-opus-9')).toMatchObject({ input: 5, output: 25 });
    expect(inferPrice('gemini-4-flash')).toMatchObject({ input: 0.3 });
    expect(inferPrice('ollama/llama9')).toMatchObject({ input: 0, output: 0 });
    expect(inferPrice('mystery')).toBeNull();
    const env = tmpEnv();
    expect(priceFor('mystery', env)).toEqual(BLENDED_PRICE);
    expect(priceFor('ollama/anything:7b', env).input).toBe(0);
  });
  it('applies VG_MODEL_PRICES and models.json overrides', () => {
    const env = tmpEnv();
    fs.writeFileSync(path.join(env.VG_CONTEXT_DIR as string, 'models.json'), JSON.stringify({ 'my-model': { price: { input: 1, output: 2 } } }));
    expect(priceFor('my-model', env)).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 });
    const env2 = { ...env, VG_MODEL_PRICES: JSON.stringify({ 'my-model': { input: 7, cacheRead: 0.7 }, 'gpt-4o': { input: 9, output: 9 } }) };
    expect(priceFor('my-model', env2)).toEqual({ input: 7, output: 2, cacheRead: 0.7, cacheWrite: 7 });
    // Re-pricing `input` without naming cache rates drops the table's inherited
    // ones: cache reads/writes are a multiple of the input price, so keeping the
    // old figures next to a new input price would misreport the saving.
    expect(priceFor('gpt-4o', env2)).toMatchObject({ input: 9, output: 9, cacheRead: 4.5, cacheWrite: 9 });
    expect(priceFor('gpt-4o', { ...env, VG_MODEL_PRICES: 'not json' }).input).toBe(2.5);
  });
});

describe('costUsd', () => {
  it('sums per-1M rates and rounds to 6 dp', () => {
    const env = tmpEnv();
    expect(costUsd('claude-opus-5', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 100_000 }, env)).toBeCloseTo(5 + 2.5 + 1 + 0.625, 6);
    expect(costUsd('gpt-4o', { input: 1234 }, env)).toBe(0.003085);
    expect(costUsd('gpt-4o', { input: -5, output: Number.NaN }, env)).toBe(0);
    expect(savingsUsd('claude-sonnet-4-6', 1_000_000, env)).toBe(3);
  });
});

describe('Sep-2026 price list', () => {
  it('prices the current OpenAI, Gemini and Grok releases (cached input at the published rate)', () => {
    expect(priceFor('gpt-6-astra')).toMatchObject({ input: 10, output: 50, cacheRead: 1 });
    expect(priceFor('gpt-5.6-sol')).toMatchObject({ input: 4, output: 20, cacheRead: 0.4 });
    expect(priceFor('gpt-5.6-luna')).toMatchObject({ input: 0.2, output: 1.2 });
    expect(priceFor('gpt-5.5')).toMatchObject({ input: 5, output: 30 });
    expect(priceFor('gpt-5.3-codex')).toMatchObject({ input: 1.75, output: 14 });
    expect(priceFor('gemini-3.8-flash')).toMatchObject({ input: 0.75, output: 3.75, cacheRead: 0.075 });
    expect(priceFor('gemini-3.5-flash-lite')).toMatchObject({ input: 0.3, output: 2.5 });
    expect(priceFor('grok-4.6')).toMatchObject({ input: 2, output: 6, cacheRead: 0.5 });
    expect(priceFor('grok-4.3')).toMatchObject({ input: 1.25, output: 2.5 });
  });

  it('infers a sensible rate for the next id in each line', () => {
    expect(inferPrice('gpt-6-nova')).toMatchObject({ input: 10, output: 50 });
    expect(inferPrice('gpt-5.6-marte')).toMatchObject({ input: 2, output: 12 });
    expect(inferPrice('gemini-3.9-flash')).toMatchObject({ input: 0.75, output: 3.75 });
    expect(inferPrice('gemini-3.2-pro')).toMatchObject({ input: 2, output: 12 });
    expect(inferPrice('grok-4.7')).toMatchObject({ input: 2, output: 6 });
  });
});
