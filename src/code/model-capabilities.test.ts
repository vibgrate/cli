import { describe, it, expect } from 'vitest';
import { lookupModelCapabilities } from './model-capabilities.js';

describe('lookupModelCapabilities', () => {
  it('knows vision-capable families', () => {
    for (const m of ['gpt-4o', 'claude-sonnet-4-5', 'gemini-2.5-pro', 'llava:13b', 'llama3.2-vision', 'qwen2.5-vl-7b', 'minicpm-v']) {
      expect(lookupModelCapabilities(m).vision, m).toBe(true);
    }
  });

  it('knows text-only families', () => {
    for (const m of ['deepseek-r1:14b', 'codestral-22b', 'qwen2.5-coder:7b', 'codellama:13b', 'phi-3-mini', 'llama-3.1-70b']) {
      expect(lookupModelCapabilities(m).vision, m).toBe(false);
    }
  });

  it('knows models that cannot tool-call natively', () => {
    for (const m of ['tinyllama', 'codellama:7b', 'gemma-2-9b', 'starcoder2', 'qwen2.5-7b-base']) {
      expect(lookupModelCapabilities(m).nativeTools, m).toBe(false);
    }
  });

  it('knows reliable native tool callers', () => {
    for (const m of ['claude-sonnet-4-5', 'gpt-5', 'qwen2.5-coder-instruct', 'hermes-3-llama-3.1', 'deepseek-chat']) {
      expect(lookupModelCapabilities(m).nativeTools, m).toBe(true);
    }
  });

  it('returns null (unknown) for unrecognized ids and empty input', () => {
    expect(lookupModelCapabilities('some-brand-new-model')).toEqual({ nativeTools: null, vision: null });
    expect(lookupModelCapabilities(undefined)).toEqual({ nativeTools: null, vision: null });
  });

  it('project overrides win over the built-in rules', () => {
    const caps = lookupModelCapabilities('deepseek-r1:14b', { 'deepseek-r1': { vision: true, nativeTools: false } });
    expect(caps.vision).toBe(true);
    expect(caps.nativeTools).toBe(false);
  });
});
