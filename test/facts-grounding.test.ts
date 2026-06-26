import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { findNodes } from '../src/engine/lookup.js';
import { discoverModels } from '../src/engine/models.js';
import { inventory } from '../src/engine/drift.js';
import { readSavings, recordSaving } from '../src/engine/savings.js';
import { makeProject, cleanup } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

const AUTH = {
  'src/auth.ts': [
    "import jwt from 'jsonwebtoken';",
    'export function authenticate(token: string) {',
    '  assert(token != null);',
    '  return jwt.verify(token, key);',
    '}',
  ].join('\n'),
  'package.json': JSON.stringify({ name: 'demo', dependencies: { jsonwebtoken: '^9.0.0' } }),
};

describe('facts (--deep)', () => {
  it('derives contract and invariant facts, epistemic-typed', async () => {
    const { graph } = await buildGraph({ root: project(AUTH), generatedAt: PIN, inline: true, deep: true });
    const auth = findNodes(graph, 'authenticate')[0];
    const facts = (graph.facts ?? []).filter((f) => f.subjectIds.includes(auth.id));
    const kinds = facts.map((f) => f.kind);
    expect(kinds).toContain('contract');
    expect(kinds).toContain('invariant');
    const invariant = facts.find((f) => f.kind === 'invariant')!;
    expect(invariant.derivedBy).toBe('static');
    expect(invariant.confidence).toBe('Derived');
  });

  it('omits facts without --deep', async () => {
    const { graph } = await buildGraph({ root: project(AUTH), generatedAt: PIN, inline: true });
    expect(graph.facts).toBeUndefined();
  });

  it('--deep build remains byte-deterministic', async () => {
    const root = project(AUTH);
    const a = serializeGraph((await buildGraph({ root, generatedAt: PIN, inline: true, deep: true, noCache: true })).graph);
    const b = serializeGraph((await buildGraph({ root, generatedAt: PIN, inline: true, deep: true, noCache: true })).graph);
    expect(a).toBe(b);
  });
});

describe('grounding', () => {
  it('attaches cited guidance to auth code', async () => {
    const { graph } = await buildGraph({ root: project(AUTH), generatedAt: PIN, inline: true });
    const auth = findNodes(graph, 'authenticate')[0];
    const g = (graph.grounding ?? []).filter((x) => x.src === auth.id);
    expect(g.length).toBeGreaterThan(0);
    expect(g.some((x) => x.citation.url.includes('owasp.org'))).toBe(true);
  });

  it('can be disabled with noGround', async () => {
    const { graph } = await buildGraph({ root: project(AUTH), generatedAt: PIN, inline: true, noGround: true });
    expect(graph.grounding).toBeUndefined();
  });
});

describe('drift inventory', () => {
  it('reads npm dependencies offline', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: { left: '^1', right: '^2' } }) });
    const inv = inventory(root);
    expect(inv.counts.npm).toBe(2);
    expect(inv.records.map((r) => r.name).sort()).toEqual(['left', 'right']);
  });

  it('reads PEP 621 pyproject.toml dependencies', () => {
    const root = project({
      'pyproject.toml': [
        '[project]',
        'name = "demo"',
        'dependencies = [',
        '  "fastapi>=0.100",',
        '  "pydantic[email]>=2",',
        ']',
      ].join('\n'),
    });
    const names = inventory(root).records.map((r) => r.name).sort();
    expect(names).toEqual(['fastapi', 'pydantic']); // extras stripped
  });

  it('reads Poetry pyproject.toml dependencies (skipping python)', () => {
    const root = project({
      'pyproject.toml': [
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'fastapi = "^0.100"',
        '[tool.poetry.group.dev.dependencies]',
        'pytest = "^8"',
      ].join('\n'),
    });
    const names = inventory(root).records.map((r) => r.name).sort();
    expect(names).toEqual(['fastapi', 'pytest']);
  });
});

describe('models discovery', () => {
  it('finds ollama manifests under a fake home', () => {
    const home = project({
      '.ollama/models/manifests/registry.ollama.ai/library/llama3/latest': '{}',
    });
    const models = discoverModels(home);
    expect(models.some((m) => m.runtime === 'ollama' && m.name === 'llama3:latest')).toBe(true);
  });
});

describe('savings ledger', () => {
  it('records and aggregates counts-only entries', () => {
    const root = project({ 'a.ts': 'x' });
    const now = 1_700_000_000_000;
    recordSaving(root, { tool: 'query_graph', vgTokens: 250_000, baselineTokens: 2_000_000 }, now);
    recordSaving(root, { tool: 'query_graph', vgTokens: 250_000, baselineTokens: 2_000_000 }, now);
    const report = readSavings(root, 30, now + 1000);
    expect(report.queries).toBe(2);
    expect(report.vgTokens).toBe(500_000);
    expect(report.baselineTokens).toBe(4_000_000);
    expect(report.ratio).toBe(8);
    expect(report.saved).toBeGreaterThan(0);
  });
});
