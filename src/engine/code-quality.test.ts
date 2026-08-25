import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from './build.js';
import { queryGraph } from './query.js';
import type { VgGraph } from '../schema.js';

/**
 * The `vg code` MECHANICAL prompt gate (module-less fallback).
 *
 * The full coding-prompt corpus gates `@vibgrate/relevance`. This public gate
 * only asserts what the host matcher must still win without that module:
 * prompts that name a real symbol or paste a real path pin the named file,
 * and content-free prompts return an honest empty. The fixture is local —
 * ranking corpora live with the relevance package, not this replica.
 */

interface CodeEntry {
  q: string;
  category: string;
  k: number;
  expectFile: string;
}
interface Outcome {
  entry: CodeEntry;
  pass: boolean;
  reason?: string;
  ms: number;
}

const SEED_LIMIT = 16;

function materializeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-code-mechanical-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'code-mechanical-fixture', type: 'module' }),
    'src/payments/checkout.ts': `
export function computeCartTotal(lines: { price: number; qty: number }[]): number {
  return lines.reduce((s, l) => s + l.price * l.qty, 0);
}
export class CheckoutService {
  total(lines: { price: number; qty: number }[]): number {
    return computeCartTotal(lines);
  }
}
`,
    'src/auth/login.ts': `
export class LoginService {
  authenticate(user: string, password: string): boolean {
    return user.length > 0 && password.length > 0;
  }
}
`,
    'src/http/health.ts': `
export function healthHandler(): { status: string } {
  return { status: 'ok' };
}
`,
    'src/noise/unrelated.ts': `
export function formatBanner(title: string): string {
  return title.toUpperCase();
}
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.trimStart());
  }
  return root;
}

const CORPUS: CodeEntry[] = [
  { category: 'code-test-writing', q: 'write unit tests for computeCartTotal', expectFile: 'src/payments/checkout.ts', k: 3 },
  { category: 'code-test-writing', q: 'add a regression test covering LoginService edge cases', expectFile: 'src/auth/login.ts', k: 3 },
  { category: 'code-test-writing', q: 'write unit tests for healthHandler', expectFile: 'src/http/health.ts', k: 3 },
  {
    category: 'code-refactor-named',
    q: 'refactor CheckoutService to extract the validation logic, keeping behaviour identical',
    expectFile: 'src/payments/checkout.ts',
    k: 3,
  },
  {
    category: 'code-refactor-named',
    q: 'simplify authenticate without changing its return values',
    expectFile: 'src/auth/login.ts',
    k: 3,
  },
  { category: 'code-path-hint', q: 'fix the todo in src/payments/checkout.ts', expectFile: 'src/payments/checkout.ts', k: 3 },
  {
    category: 'code-path-hint',
    q: 'there is a bug somewhere in src/auth/login.ts — find and fix it',
    expectFile: 'src/auth/login.ts',
    k: 3,
  },
  {
    category: 'code-path-hint',
    q: 'TypeError: cannot read properties of undefined at computeCartTotal (src/payments/checkout.ts:14:7) — fix the crash',
    expectFile: 'src/payments/checkout.ts',
    k: 3,
  },
];

function scoreByCategory(outcomes: Outcome[]) {
  const byCat = new Map<string, { category: string; total: number; passed: number; failures: Array<{ q: string; reason: string }> }>();
  for (const o of outcomes) {
    const row = byCat.get(o.entry.category) ?? { category: o.entry.category, total: 0, passed: 0, failures: [] };
    row.total++;
    if (o.pass) row.passed++;
    else row.failures.push({ q: o.entry.q, reason: o.reason ?? 'fail' });
    byCat.set(o.entry.category, row);
  }
  return [...byCat.values()].map((r) => ({ ...r, rate: r.passed / r.total }));
}

let root: string;
let graph: VgGraph;
let outcomes: Outcome[];

beforeAll(async () => {
  root = materializeRepo();
  const built = await buildGraph({
    root,
    inline: true,
    noGround: true,
    noTsc: true,
    noCoverage: true,
    noScip: true,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  graph = built.graph;
  outcomes = [];
  for (const entry of CORPUS) {
    const s = process.hrtime.bigint();
    const result = queryGraph(graph, entry.q, { limit: SEED_LIMIT });
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    const files = result.matches.slice(0, entry.k).map((m) => m.node.file.replace(/\\/g, '/'));
    const pass = files.includes(entry.expectFile);
    outcomes.push({
      entry,
      pass,
      reason: pass ? undefined : `expected ${entry.expectFile} in top-${entry.k}, got [${files.join(', ')}]`,
      ms,
    });
  }
}, 60_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('vg code mechanical prompt gate (module-less fallback)', () => {
  it('every name-bearing coding-prompt category resolves at 100%', () => {
    const scored = scoreByCategory(outcomes);
    const failing = scored.filter((r) => r.rate < 1);
    const detail = failing
      .map((r) => `${r.category} ${r.passed}/${r.total}\n` + r.failures.map((f) => `    "${f.q}" — ${f.reason}`).join('\n'))
      .join('\n');
    expect(failing, `\nfailing categories:\n${detail}\n`).toEqual([]);
  });

  it('content-free coding prompts return an honest empty mechanically', () => {
    for (const q of ['fix the bug', 'make it faster please', 'the fft window function clips at the nyquist bin']) {
      const r = queryGraph(graph, q, { limit: SEED_LIMIT });
      expect(r.matches, q).toEqual([]);
    }
  });

  it('stays fast: p95 per-prompt latency under 250ms at gate scale', () => {
    const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(250);
  });
});
