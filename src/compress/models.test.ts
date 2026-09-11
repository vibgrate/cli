import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetModelCatalog } from '../engine/model-catalog-provider.js';
import { useFixtureCatalog, useNoCatalog } from './__fixtures__/model-catalog.js';
import { resetModelIndexForTests } from './models.js';
import { billsPriorThinking, canonicalModelId, contextLimitFor, DEFAULT_CONTEXT_LIMIT, inferModelInfo, knownModels, loadModelsConfig, modelInfo, ONE_MILLION } from './models.js';

const dirs: string[] = [];
beforeEach(() => {
  resetModelIndexForTests();
  useFixtureCatalog();
});
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  resetModelIndexForTests();
  resetModelCatalog();
});

function tmpEnv(): NodeJS.ProcessEnv {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-models-'));
  dirs.push(d);
  return { VG_CONTEXT_DIR: d };
}

describe('registry', () => {
  it('surfaces whatever the catalog carries, and nothing when it carries none', () => {
    // WHICH models ship is asserted where the data lives (the relevance
    // package). What matters here is that this file no longer holds a table:
    // the list is exactly what the seam handed over, and with no module
    // installed it is empty and every id falls through to inference.
    expect(knownModels().map((m) => m.id).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5', 'gpt-4o', 'house-model-1']);
    expect(knownModels()).toEqual(knownModels());

    useNoCatalog();
    resetModelIndexForTests();
    expect(knownModels()).toEqual([]);
  });
  it('resolves exact ids, aliases and dated snapshots from the catalog', () => {
    const env = tmpEnv();
    expect(modelInfo('claude-opus-5', env)).toMatchObject({ family: 'anthropic', contextLimit: ONE_MILLION, maxOutput: 128_000, billsThinking: true, supportsCacheControl: true });
    expect(modelInfo('claude-haiku-4-5-20251001', env)).toMatchObject({ id: 'claude-haiku-4-5', contextLimit: 200_000 });
    expect(modelInfo('gpt-4o-2024-08-06', env).contextLimit).toBe(128_000);
    expect(modelInfo('GPT-4O', env).id).toBe('gpt-4o');
  });

  it('falls back to inference, never upward, when no module is installed', () => {
    // The safe direction: a window that reads too low makes compression work
    // harder than it needs to; one that reads too high overflows the model and
    // the request fails. So an uncatalogued id gets inference or the
    // conservative default — never a borrowed figure from a bigger sibling.
    useNoCatalog();
    resetModelIndexForTests();
    const env = tmpEnv();
    // Inference still recognises the family and keeps compression sharp…
    expect(modelInfo('claude-opus-5', env).family).toBe('anthropic');
    // …and anything it cannot place lands on the conservative default.
    expect(modelInfo('house-model-1', env).contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(modelInfo('some-model-nobody-ships', env).contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });
  it('unwraps gateway ids and never confuses gpt-4.1 with gpt-4', () => {
    const env = tmpEnv();
    expect(modelInfo('openrouter/anthropic/claude-sonnet-4-6', env).contextLimit).toBe(ONE_MILLION);
    expect(modelInfo('us.anthropic.claude-haiku-4-5-20251001-v1:0', env).contextLimit).toBe(200_000);
    expect(modelInfo('gpt-4.1', env).contextLimit).toBe(1_047_576);
    expect(modelInfo('gpt-4-32k-0613', env).contextLimit).toBe(32_768);
    expect(modelInfo('gpt-4', env).contextLimit).toBe(8192);
  });
  it('infers unknown ids by pattern and falls back to 128k', () => {
    expect(inferModelInfo('claude-opus-7').contextLimit).toBe(ONE_MILLION);
    expect(inferModelInfo('claude-opus-4-5-preview').contextLimit).toBe(200_000);
    expect(inferModelInfo('gpt-5.5-turbo').contextLimit).toBe(1_050_000);
    expect(inferModelInfo('gpt-5.4-turbo').contextLimit).toBe(400_000);
    expect(inferModelInfo('gpt-4.1-ultra').contextLimit).toBe(1_047_576);
    expect(inferModelInfo('gemini-3-flash').contextLimit).toBe(ONE_MILLION);
    expect(inferModelInfo('ollama/tinyllama').family).toBe('ollama');
    expect(inferModelInfo('totally-new-model').contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
    const env = tmpEnv();
    expect(modelInfo('totally-new-model', env)).toMatchObject({ id: 'totally-new-model', family: 'unknown', contextLimit: DEFAULT_CONTEXT_LIMIT });
    expect(modelInfo('', env).contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });
  it('honours -1m suffixes and VG_1M_MODEL', () => {
    const env = tmpEnv();
    expect(modelInfo('claude-sonnet-4-5-1m', env).contextLimit).toBe(ONE_MILLION);
    expect(modelInfo('claude-sonnet-4-5[1m]', env).contextLimit).toBe(ONE_MILLION);
    expect(modelInfo('claude-sonnet-4-5', { ...env, VG_1M_MODEL: 'claude-sonnet-4-5' }).contextLimit).toBe(ONE_MILLION);
  });
  it('applies VG_MODEL_LIMITS and VG_MODEL_ALIAS_MAP', () => {
    const env = { ...tmpEnv(), VG_MODEL_LIMITS: 'my-model=32000,gpt-4o=64000', VG_MODEL_ALIAS_MAP: 'fast=claude-haiku-4-5' };
    expect(modelInfo('my-model', env).contextLimit).toBe(32_000);
    expect(modelInfo('gpt-4o', env).contextLimit).toBe(64_000);
    expect(canonicalModelId('fast', env)).toBe('claude-haiku-4-5');
    expect(modelInfo('fast', env).contextLimit).toBe(200_000);
    expect(contextLimitFor('fast', env)).toBe(200_000);
  });
  it('reads models.json overrides (flat and wrapped) with caching by mtime', () => {
    const env = tmpEnv();
    const file = path.join(env.VG_CONTEXT_DIR as string, 'models.json');
    fs.writeFileSync(file, JSON.stringify({ models: { 'my-local': { contextLimit: 12345, maxOutput: 999, family: 'ollama', aliases: ['local'], price: { input: 0, output: 0 } } } }));
    expect(loadModelsConfig(env)['my-local']).toMatchObject({ contextLimit: 12345, maxOutput: 999, family: 'ollama' });
    expect(modelInfo('local', env)).toMatchObject({ id: 'my-local', contextLimit: 12345, maxOutput: 999, family: 'ollama' });
    fs.writeFileSync(file, '{ not json');
    expect(loadModelsConfig(env)).toEqual({});
    expect(modelInfo('my-local', env).contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});

describe('billsPriorThinking', () => {
  it('follows the (major, minor) ≥ (4, 6) rule', () => {
    expect(billsPriorThinking('claude-opus-4-6')).toBe(true);
    expect(billsPriorThinking('claude-sonnet-4-6-20260101')).toBe(true);
    expect(billsPriorThinking('claude-opus-5')).toBe(true);
    expect(billsPriorThinking('claude-sonnet-4-5')).toBe(false);
    expect(billsPriorThinking('claude-haiku-4-5')).toBe(false);
    expect(billsPriorThinking('claude-3-7-sonnet')).toBe(false);
    expect(billsPriorThinking('gpt-4o')).toBe(false);
  });
});

describe('Sep-2026 model generation', () => {
  // Which ids the shipped catalog carries is asserted over the data file
  // itself, in packages/vibgrate-relevance/tests/model-catalog-data.test.ts.
  // What belongs here is the inference that has to hold for a release nobody
  // has catalogued yet — including when no module is installed at all.
  it('infers the next releases in each line instead of falling to the 128k bucket', () => {
    useNoCatalog();
    resetModelIndexForTests();
    // A GPT-6 or GPT-5.7 id nobody has registered yet keeps the 1.05M window;
    // before this rule `gpt-6-*` fell through `/^gpt-/` to 128k / 16k output.
    expect(modelInfo('gpt-6-nova').contextLimit).toBe(1_050_000);
    expect(modelInfo('gpt-5.7-terra').contextLimit).toBe(1_050_000);
    expect(modelInfo('gpt-5.4-turbo').contextLimit).toBe(400_000);
    expect(modelInfo('grok-4.7').contextLimit).toBe(500_000);
    expect(modelInfo('grok-4.2-fast').contextLimit).toBe(1_000_000);
    expect(modelInfo('gemini-3.9-flash').contextLimit).toBe(1_000_000);
    expect(modelInfo('openrouter/openai/gpt-6-astra').contextLimit).toBe(1_050_000);
  });
});
