import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphIndex, indexFor } from './relations.js';
import { impactOf } from './impact.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Answering the wedge questions: "which tests cover X" (`vg tests`) and "which
 * tests must I run if I change X" (`vg impact --tests`). Deterministic, from the
 * `test` edges + coverage produced at build time.
 */

export interface CoveringTest {
  file: string; // test file (relative)
  basis: 'call' | 'coverage';
  confidence: number;
}

export function coveringTests(graph: VgGraph, node: GraphNode, index?: GraphIndex): CoveringTest[] {
  const idx = index ?? indexFor(graph);
  const byId = idx.nodeById;
  const out = new Map<string, CoveringTest>();
  for (const e of idx.in(node.id, 'test')) {
    const testNode = byId.get(e.src);
    if (!testNode) continue;
    out.set(testNode.file, { file: testNode.file, basis: 'call', confidence: e.confidence });
  }
  // Runtime coverage is a signal even without a specific test attribution.
  if (typeof node.coverage === 'number' && node.coverage > 0 && out.size === 0) {
    out.set('(coverage)', { file: '(coverage report)', basis: 'coverage', confidence: node.coverage });
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file));
}

export interface TestImpact {
  affectedTestFiles: string[];
  untestedAffected: { id: string; name: string; file: string }[];
}

/** The test files that exercise any node in the impact set of `rootId`. */
export function testsToRun(graph: VgGraph, rootId: string, depth = 4): TestImpact {
  const idx = indexFor(graph);
  const impact = impactOf(graph, rootId, { depth });
  const affectedIds = new Set<string>([rootId, ...impact.affected.map((a) => a.id)]);

  const testFiles = new Set<string>();
  const untested: { id: string; name: string; file: string }[] = [];
  for (const id of affectedIds) {
    const node = idx.node(id);
    if (!node) continue;
    const covers = coveringTests(graph, node, idx).filter((c) => c.basis === 'call');
    for (const c of covers) testFiles.add(c.file);
    if ((node.kind === 'function' || node.kind === 'method') && node.tested === false) {
      untested.push({ id: node.id, name: node.qualifiedName, file: node.file });
    }
  }
  return {
    affectedTestFiles: [...testFiles].sort(),
    untestedAffected: untested.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// --- runner detection ---

export interface Runner {
  name: string;
  command: (testFiles: string[]) => string;
}

export function detectRunner(root: string, lang?: string): Runner {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return { name: 'vitest', command: (f) => `npx vitest run ${f.join(' ')}`.trim() };
      if (deps.jest) return { name: 'jest', command: (f) => `npx jest ${f.join(' ')}`.trim() };
      if (deps.mocha) return { name: 'mocha', command: (f) => `npx mocha ${f.join(' ')}`.trim() };
    } catch {
      /* fall through */
    }
  }
  if (lang === 'py' || fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    return { name: 'pytest', command: (f) => `pytest ${f.join(' ')}`.trim() };
  }
  if (lang === 'go' || fs.existsSync(path.join(root, 'go.mod'))) {
    return { name: 'go test', command: () => 'go test ./...' };
  }
  if (lang === 'cs' || hasFile(root, /\.csproj$/) || hasFile(root, /\.sln$/)) {
    return { name: 'dotnet test', command: () => 'dotnet test' };
  }
  if (lang === 'rb') return { name: 'rspec', command: (f) => `bundle exec rspec ${f.join(' ')}`.trim() };
  return { name: 'tests', command: (f) => (f.length ? f.join(' ') : '(no runner detected)') };
}

function hasFile(root: string, re: RegExp): boolean {
  try {
    return fs.readdirSync(root).some((f) => re.test(f));
  } catch {
    return false;
  }
}
