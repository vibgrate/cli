import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { billsPriorThinking, canonicalModelId, contextLimitFor, DEFAULT_CONTEXT_LIMIT, inferModelInfo, knownModels, loadModelsConfig, modelInfo, ONE_MILLION } from './models.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpEnv(): NodeJS.ProcessEnv {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-models-'));
  dirs.push(d);
  return { VG_CONTEXT_DIR: d };
}

describe('registry', () => {
  it('knows the major families', () => {
    const ids = knownModels().map((m) => m.id);
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o3', 'gemini-2.5-pro', 'llama-3.3-70b', 'mistral-large', 'deepseek-chat', 'grok-4', 'qwen2.5-72b', 'ollama/llama3']) expect(ids).toContain(id);
    expect(knownModels()).toEqual(knownModels());
  });
  it('resolves exact ids, aliases and dated snapshots', () => {
    const env = tmpEnv();
    expect(modelInfo('claude-opus-5', env)).toMatchObject({ family: 'anthropic', contextLimit: ONE_MILLION, maxOutput: 128_000, billsThinking: true, supportsCacheControl: true });
    expect(modelInfo('claude-haiku-4-5-20251001', env)).toMatchObject({ id: 'claude-haiku-4-5', contextLimit: 200_000 });
    expect(modelInfo('claude-sonnet-4-20250514', env).id).toBe('claude-sonnet-4-0');
    expect(modelInfo('gpt-4o-2024-08-06', env).contextLimit).toBe(128_000);
    expect(modelInfo('GPT-4O', env).id).toBe('gpt-4o');
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
  it('knows the current OpenAI, Gemini and Grok releases by exact id', () => {
    expect(modelInfo('gpt-6-astra')).toMatchObject({ family: 'openai', contextLimit: 1_050_000, maxOutput: 128_000, billsThinking: true });
    expect(modelInfo('gpt-5.6-sol').contextLimit).toBe(1_050_000);
    expect(modelInfo('gpt-5.5').contextLimit).toBe(1_050_000);
    expect(modelInfo('gpt-5.4-mini').contextLimit).toBe(400_000);
    expect(modelInfo('gpt-5.3-codex').family).toBe('openai');
    expect(modelInfo('gemini-3.8-flash')).toMatchObject({ family: 'google', contextLimit: 1_000_000, billsThinking: true });
    expect(modelInfo('gemini-3.1-pro').id).toBe('gemini-3.1-pro-preview');
    expect(modelInfo('gemini-omni-flash-preview').id).toBe('gemini-omni-1.1-flash');
    expect(modelInfo('grok-4.6')).toMatchObject({ family: 'xai', contextLimit: 500_000, billsThinking: true });
    expect(modelInfo('grok-4.3').contextLimit).toBe(1_000_000);
  });

  it('infers the next releases in each line instead of falling to the 128k bucket', () => {
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
