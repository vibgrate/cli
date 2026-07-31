import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  answerLocateInstruction,
  formatLocateAnswer,
  isLocateOnlyInstruction,
  primaryLocateNeedle,
  sanitizeAgentDisplayText,
} from './locate-answer.js';
import { SCHEMA_VERSION } from '../schema.js';

const emptyGraph = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: '1970-01-01T00:00:00.000Z',
  provenance: { tool: 'vg' as const, version: '0', grammars: {}, resolver: [] as const, deep: false, corpusHash: 'x' },
  meta: {
    root: '.',
    languages: ['ts'],
    counts: { nodes: 0, edges: 0, areas: 0, tests: 0, untested: 0 },
    cluster: 'none' as const,
    edgeKinds: [],
  },
  nodes: [],
  edges: [],
  areas: [],
};

describe('isLocateOnlyInstruction', () => {
  it('detects where-is URL questions', () => {
    expect(isLocateOnlyInstruction('where is https://dash.vibgrate.com/signup?')).toBe(true);
    expect(isLocateOnlyInstruction('https://dash.vibgrate.com/signup does not exist find occurrences')).toBe(true);
  });

  it('rejects edit tasks even when a URL is mentioned', () => {
    expect(isLocateOnlyInstruction('fix the signup link at https://dash.vibgrate.com/signup')).toBe(false);
    expect(isLocateOnlyInstruction('add a timeout to scanDir')).toBe(false);
  });
});

describe('sanitizeAgentDisplayText', () => {
  it('replaces PatchIR dumps with a short notice', () => {
    const dump = JSON.stringify({
      schemaVersion: 'patch-ir/0',
      operations: [{ op: 'replace-text', file: 'x.ts', search: 'a', replace: 'a' }],
    });
    expect(sanitizeAgentDisplayText(dump)).not.toContain('patch-ir');
    expect(sanitizeAgentDisplayText(dump)).toMatch(/edit-shaped|tools|Markdown/i);
    expect(sanitizeAgentDisplayText(dump)).not.toMatch(/Ask again as/i);
  });

  it('strips identifier annotation comments', () => {
    expect(sanitizeAgentDisplayText('hello\n\n/* vg: unknown identifiers vs graph (not rewritten): foo */')).toBe(
      'hello',
    );
  });
});

describe('answerLocateInstruction', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-locate-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'extension.ts'),
      `void open('https://dash.vibgrate.com/signup');\n`,
    );
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns a clean file:line summary for a URL', async () => {
    const a = await answerLocateInstruction(
      emptyGraph as never,
      root,
      'where is https://dash.vibgrate.com/signup?',
      20,
    );
    expect(a.needle).toBe('https://dash.vibgrate.com/signup');
    expect(a.summary).toContain('src/extension.ts:1');
    expect(a.summary).not.toContain('patch-ir');
    expect(a.summary).not.toContain('unknown identifiers');
  });

  it('finds bare-identifier occurrences via forced literal sweep (workspace-Find quality)', async () => {
    // Fresh tree — walk listing is cached per root; do not append to `root` after a prior scan.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-locate-stripe-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'billing.ts'), `import { stripe } from './pay';\n// stripe webhook\n`);
      const a = await answerLocateInstruction(emptyGraph as never, dir, "where is 'stripe'?", 30);
      expect(a.needle).toBe('stripe');
      expect(a.totalTextMatches).toBeGreaterThan(0);
      expect(a.summary).toMatch(/billing\.ts/i);
      expect(a.summary).not.toMatch(/No occurrences/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats zero hits honestly', () => {
    expect(formatLocateAnswer('https://nope.example', [], 0)).toMatch(/No occurrences/);
  });

  it('picks the URL needle from NL framing', () => {
    expect(primaryLocateNeedle('where is https://dash.vibgrate.com/signup?')).toBe(
      'https://dash.vibgrate.com/signup',
    );
  });
});
