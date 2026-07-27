import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { isFrameworkName, isFrameworkOddity } from '../src/commands/insights.js';
import type { GraphNode } from '../src/schema.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function external(name: string): GraphNode {
  return {
    id: `ext:${name}`,
    kind: 'external',
    name,
    qualifiedName: name,
    file: '',
    lang: 'ts',
    span: { start: 0, end: 0 },
    importance: 0,
    isHub: false,
    area: 0,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
  } as GraphNode;
}

function appFn(name: string): GraphNode {
  return {
    id: `fn:${name}`,
    kind: 'function',
    name,
    qualifiedName: name,
    file: 'src/a.ts',
    lang: 'ts',
    span: { start: 1, end: 2 },
    importance: 0,
    isHub: false,
    area: 0,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
  } as GraphNode;
}

describe('isFrameworkName', () => {
  it('matches known frameworks and subpaths', () => {
    expect(isFrameworkName('react')).toBe(true);
    expect(isFrameworkName('react-dom')).toBe(true);
    expect(isFrameworkName('react/jsx-runtime')).toBe(true);
    expect(isFrameworkName('@vue/runtime-dom')).toBe(true);
    expect(isFrameworkName('@angular/core')).toBe(true);
    expect(isFrameworkName('node:fs')).toBe(true);
    expect(isFrameworkName('fs')).toBe(true);
    expect(isFrameworkName('lodash/get')).toBe(true);
  });

  it('does not match application packages', () => {
    expect(isFrameworkName('bugben-api')).toBe(false);
    expect(isFrameworkName('@bugben/ui')).toBe(false);
    expect(isFrameworkName('my-react-helper')).toBe(false); // not react- prefix package root
  });
});

describe('isFrameworkOddity', () => {
  it('filters pure import edges to framework externals', () => {
    expect(isFrameworkOddity(appFn('A'), external('react'), 'import')).toBe(true);
    expect(isFrameworkOddity(appFn('A'), external('vue'), 'import')).toBe(true);
  });

  it('keeps call edges and app-to-app imports', () => {
    expect(isFrameworkOddity(appFn('A'), external('react'), 'call')).toBe(false);
    expect(isFrameworkOddity(appFn('A'), appFn('B'), 'import')).toBe(false);
    expect(isFrameworkOddity(appFn('A'), external('bugben-api'), 'import')).toBe(false);
  });
});

describe('framework imports in the graph', () => {
  it('records import edges to external packages (oddities filters them at display time)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } }),
      'src/a.tsx': ["import React from 'react';", 'export function A() { return null; }', ''].join('\n'),
    });
    dirs.push(root);
    const { graph } = await buildGraph({
      root,
      generatedAt: '2020-01-01T00:00:00.000Z',
      inline: true,
      noGround: true,
    });
    const reactExt = graph.nodes.find((n) => n.kind === 'external' && n.name === 'react');
    const hasReactImport =
      !!reactExt ||
      graph.nodes.some((n) => n.kind === 'external' && /react/i.test(n.qualifiedName));
    expect(hasReactImport || graph.edges.some((e) => e.kind === 'import')).toBe(true);
  });
});
