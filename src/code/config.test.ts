import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCodeConfig, contextBudgetFor } from './config.js';

function withConfig(json: string, fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cfg-'));
  try {
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate', 'code.json'), json);
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('loadCodeConfig', () => {
  it('reads recognised keys', () => {
    withConfig(JSON.stringify({ provider: 'ollama', model: 'qwen2.5-coder:7b', auto: true, testCommand: 'npm test', denyCommands: ['deploy'], contextWindow: 32000, maxSteps: 30 }), (root) => {
      const c = loadCodeConfig(root);
      expect(c).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:7b', auto: true, testCommand: 'npm test', denyCommands: ['deploy'], contextWindow: 32000, maxSteps: 30 });
    });
  });

  it('parses mcpServers (stdio + remote), dropping entries with neither command nor url', () => {
    withConfig(JSON.stringify({ mcpServers: { good: { command: 'node', args: ['x.js'] }, remote: { url: 'https://x/mcp', type: 'sse' }, bad: { args: ['y'] } } }), (root) => {
      const c = loadCodeConfig(root);
      expect(Object.keys(c.mcpServers ?? {}).sort()).toEqual(['good', 'remote']);
      expect(c.mcpServers?.good.command).toBe('node');
      expect(c.mcpServers?.remote.url).toBe('https://x/mcp');
      expect(c.mcpServers?.remote.type).toBe('sse');
    });
  });

  it('ignores junk and wrong types', () => {
    withConfig(JSON.stringify({ provider: 123, auto: 'yes', denyCommands: [1, 'ok'], nope: true }), (root) => {
      const c = loadCodeConfig(root);
      expect(c.provider).toBeUndefined();
      expect(c.auto).toBeUndefined();
      expect(c.denyCommands).toEqual(['ok']);
    });
  });

  it('returns {} for a missing or malformed file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cfg-'));
    try {
      expect(loadCodeConfig(root)).toEqual({});
      fs.mkdirSync(path.join(root, '.vibgrate'));
      fs.writeFileSync(path.join(root, '.vibgrate', 'code.json'), '{ not json');
      expect(loadCodeConfig(root)).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('contextBudgetFor', () => {
  it('prefers an explicit config window, then the model window, then a default', () => {
    expect(contextBudgetFor({ contextWindow: 100000 })).toBe(60000);
    expect(contextBudgetFor({}, 32000)).toBe(19200);
    expect(contextBudgetFor({})).toBe(16000);
  });
});
