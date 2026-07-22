import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordCliCall, readModelSavings, readSavings, sanitizeModelId } from './savings.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-savings-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sanitizeModelId', () => {
  it('keeps slug punctuation but bounds and lowercases', () => {
    expect(sanitizeModelId('Anthropic/Claude-3.5-Sonnet')).toBe('anthropic/claude-3.5-sonnet');
    expect(sanitizeModelId('qwen2.5-coder:7b')).toBe('qwen2.5-coder:7b');
    expect(sanitizeModelId('   ')).toBeUndefined();
    expect(sanitizeModelId(undefined)).toBeUndefined();
  });
});

describe('per-model savings', () => {
  it('records provider/model and breaks savings down per model', () => {
    const now = Date.now();
    recordCliCall(root, { tool: 'query_graph', client: 'vg-code', provider: 'anthropic', model: 'anthropic/claude-3.5-sonnet', outcome: 'complete', vgTokens: 500, baselineFiles: 10 }, now);
    recordCliCall(root, { tool: 'query_graph', client: 'vg-code', provider: 'anthropic', model: 'anthropic/claude-3.5-sonnet', outcome: 'complete', vgTokens: 300, baselineFiles: 6 }, now);
    recordCliCall(root, { tool: 'query_graph', client: 'vg-code', provider: 'ollama', model: 'qwen2.5-coder:7b', outcome: 'complete', vgTokens: 400, baselineFiles: 8 }, now);

    const models = readModelSavings(root, 30, now);
    expect(models).toHaveLength(2);
    const claude = models.find((m) => m.model === 'anthropic/claude-3.5-sonnet')!;
    expect(claude.queries).toBe(2);
    expect(claude.vgTokens).toBe(800);
    expect(claude.baselineTokens).toBe(16 * 400); // baselineFiles × PER_FILE_TOKENS
    expect(claude.saved).toBeGreaterThan(0);

    // The per-model totals reconcile with the headline savings totals.
    const headline = readSavings(root, 30, now);
    const modelVg = models.reduce((n, m) => n + m.vgTokens, 0);
    expect(modelVg).toBe(headline.vgTokens);
  });

  it('ignores entries without a model in the per-model view', () => {
    const now = Date.now();
    recordCliCall(root, { tool: 'query_graph', client: 'claude', outcome: 'complete', vgTokens: 100, baselineFiles: 2 }, now);
    expect(readModelSavings(root, 30, now)).toHaveLength(0);
  });
});
