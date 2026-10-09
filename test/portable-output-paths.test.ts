import { describe, expect, it } from 'vitest';
import { formatMarkdown as formatScanMarkdown } from '../src/core-open/formatters/markdown.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import type { ScanArtifact } from '../src/core-open/types.js';
import { portableValue } from '../src/core-open/utils/portable-path.js';
import { renderReport } from '../src/engine/report.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { formatMarkdown as formatReport } from '../src/reporting/formatters/markdown.js';
import type { VgGraph } from '../src/schema.js';

/**
 * Fixture paths use both home prefixes. Default machine-readable output must
 * not repeat them: paths inside the scan/build root are relative to that root,
 * and the same relative layout is byte-identical under either prefix.
 */
const ROOT = '/home/dev/fixture';

function scanFixture(): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-10-09T00:00:00.000Z',
    vibgrateVersion: '0.0.0',
    rootPath: 'fixture',
    projects: [
      {
        type: 'node',
        path: '/home/dev/fixture/services/api',
        name: 'api',
        frameworks: [],
        dependencies: [],
        dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
      },
    ],
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 10, eolScore: 0 },
    },
    findings: [
      {
        ruleId: 'vibgrate/dependency-rot',
        level: 'warning',
        message: 'see /home/dev/fixture/services/api/package.json and /Users/dev/fixture/pkg/lib.ts',
        location: '/home/dev/fixture/services/api/package.json',
      },
    ],
    repository: { name: 'fixture', remoteUrl: 'https://example.com/home/docs' },
  };
}

function graphNode(file: string): VgGraph['nodes'][number] {
  return {
    id: 'fn-main',
    kind: 'function',
    name: 'main',
    qualifiedName: 'main',
    file,
    span: { start: 1, end: 4 },
    lang: 'ts',
    importance: 1,
    centrality: { degree: 1, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: -1,
    isHub: false,
    tested: null,
  };
}

function graphFixture(file: string): VgGraph {
  return {
    schemaVersion: 'vg-graph/1.1',
    generatedAt: '2026-10-09T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: '0.0.0',
      grammars: { ts: 'test' },
      resolver: ['heuristic'],
      deep: false,
      corpusHash: 'abc',
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: 1, edges: 0, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes: [graphNode(file)],
    edges: [],
    areas: [],
  };
}

function assertNoHomePrefix(label: string, text: string): void {
  expect(text, label).not.toContain('/home/dev/');
  expect(text, label).not.toContain('/home/ada/');
  expect(text, label).not.toContain('/Users/');
}

describe('default machine-readable output paths', () => {
  it('omits home-prefixed fixture paths from json, sarif, and report', () => {
    const artifact = scanFixture();
    const json = JSON.stringify(portableValue(artifact, ROOT), null, 2);
    const sarif = JSON.stringify(formatSarif(artifact, ROOT), null, 2);
    const scanReport = formatScanMarkdown(artifact, ROOT);
    const report = formatReport(artifact, ROOT);
    const graphJson = serializeGraph(graphFixture('/home/dev/fixture/src/main.ts'), { root: ROOT });
    const graphReport = renderReport(graphFixture('/Users/dev/fixture/src/main.ts'), '/Users/dev/fixture');

    for (const [label, text] of [
      ['json', json],
      ['sarif', sarif],
      ['scan report', scanReport],
      ['report', report],
      ['graph json', graphJson],
      ['graph report', graphReport],
    ] as const) {
      assertNoHomePrefix(label, text);
    }

    expect(json).toContain('services/api/package.json');
    expect(json).toContain('https://example.com/home/docs');
    expect(sarif).toContain('"uri": "services/api/package.json"');
    expect(report).toContain('services/api/package.json');
    expect(graphJson).toContain('src/main.ts');
    expect(graphReport).toContain('src/main.ts');

    expect(JSON.stringify(formatSarif(scanFixture(), ROOT), null, 2)).toBe(sarif);
    expect(formatReport(scanFixture(), ROOT)).toBe(report);
    expect(serializeGraph(graphFixture('/home/dev/fixture/src/main.ts'), { root: ROOT })).toBe(graphJson);
    expect(serializeGraph(graphFixture('/home/ada/app/src/main.ts'), { root: '/home/ada/app' })).toBe(
      serializeGraph(graphFixture('/Users/ada/app/src/main.ts'), { root: '/Users/ada/app' }),
    );
    expect(portableValue(portableValue(artifact, ROOT), ROOT)).toEqual(portableValue(artifact, ROOT));
  });
});
