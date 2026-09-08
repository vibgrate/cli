import { describe, expect, it } from 'vitest';
import { countTokens } from '../engine/tokens.js';
import { CL100K, countDenseChars, detectCharsPerToken, estimateTokens, modelIdCandidates, tokenizerFamily, tokenizerFor } from './tokenizers.js';

describe('modelIdCandidates', () => {
  it('unwraps gateway prefixes progressively', () => {
    const c = modelIdCandidates('openrouter/anthropic/claude-sonnet-4-5');
    expect(c[0]).toBe('openrouter/anthropic/claude-sonnet-4-5');
    expect(c).toContain('anthropic/claude-sonnet-4-5');
    expect(c).toContain('claude-sonnet-4-5');
  });
  it('unwraps bedrock dotted ids and version tails', () => {
    const c = modelIdCandidates('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(c).toContain('claude-sonnet-4-5-20250929-v1:0');
    expect(c).toContain('claude-sonnet-4-5-20250929');
    expect(c).toContain('claude-sonnet-4-5');
  });
  it('never splits dotted version numbers', () => {
    expect(modelIdCandidates('gpt-4.1-mini')).toEqual(['gpt-4.1-mini']);
  });
});

describe('tokenizerFamily', () => {
  it('classifies known families', () => {
    expect(tokenizerFamily('gpt-4o')).toBe('openai');
    expect(tokenizerFamily('o3-mini')).toBe('openai');
    expect(tokenizerFamily('claude-opus-5')).toBe('anthropic');
    expect(tokenizerFamily('bedrock/anthropic.claude-sonnet-4-6-v1:0')).toBe('anthropic');
    expect(tokenizerFamily('gemini-2.5-pro')).toBe('gemini');
    expect(tokenizerFamily('meta-llama/Llama-3.3-70B-Instruct')).toBe('llama');
    expect(tokenizerFamily('mistral-large-latest')).toBe('llama');
    expect(tokenizerFamily(undefined)).toBe('unknown');
    expect(tokenizerFamily('some-custom-model')).toBe('unknown');
  });
});

describe('tokenizerFor', () => {
  it('returns exact cl100k for openai and unknown', () => {
    expect(tokenizerFor('gpt-4o')).toBe(CL100K);
    expect(tokenizerFor(undefined).id).toBe('cl100k');
    expect(CL100K.count('hello world')).toBe(countTokens('hello world'));
    expect(CL100K.count('')).toBe(0);
  });
  it('scales by the family factor with a stable id', () => {
    const t = tokenizerFor('claude-sonnet-4-6');
    expect(t.id).toBe('anthropic~cl100k*1.15');
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    expect(t.count(text)).toBe(Math.round(countTokens(text) * 1.15));
    expect(tokenizerFor('gemini-2.5-flash').id).toBe('gemini~cl100k');
    expect(tokenizerFor('claude-x')).toBe(tokenizerFor('claude-y'));
  });
});

describe('estimateTokens', () => {
  it('prices dense scripts at 1.5 chars per token', () => {
    expect(countDenseChars('数据库连接失败')).toBe(7);
    expect(estimateTokens('数据库')).toBe(2);
    expect(estimateTokens('数据库连接失败')).toBe(5);
    expect(estimateTokens('ＡＰＩ')).toBe(2);
  });
  it('uses fixed ratios for calibrated families', () => {
    expect(estimateTokens('a'.repeat(35), 'claude-3-5-sonnet')).toBe(10);
    expect(estimateTokens('a'.repeat(38), 'claude-3-5-sonnet')).toBe(11);
    expect(estimateTokens('a'.repeat(40), 'gemini-pro')).toBe(10);
  });
  it('auto-detects json / code / prose ratios', () => {
    expect(detectCharsPerToken('{"a":1,"b":[1,2,3]}')).toBe(3.2);
    expect(detectCharsPerToken('def f():\n    return 1\nclass A:\n    pass\n'.repeat(4))).toBe(3.5);
    expect(detectCharsPerToken('Plain English prose without any code markers at all.')).toBe(4);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x')).toBe(1);
  });
  it('adds URL and UUID overhead', () => {
    const plain = estimateTokens('a'.repeat(40));
    const withUrl = estimateTokens('a'.repeat(40).replace(/a{20}$/, 'http://x.io/a/b?c=1&d=2'));
    expect(withUrl).toBeGreaterThan(plain - 5);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(estimateTokens(uuid)).toBe(Math.trunc(uuid.length / 4 + 0.5) + 2);
  });
  it('is linear on a 1 MB single line', () => {
    const big = 'x'.repeat(1_000_000);
    const t0 = Date.now();
    expect(estimateTokens(big)).toBeGreaterThan(200_000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
