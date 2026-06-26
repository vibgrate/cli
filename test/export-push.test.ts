import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { exportGraph, formatForExt } from '../src/engine/export.js';
import { redactGraph, buildEnvelope } from '../src/engine/push.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

let graph: VgGraph;
let dir: string;
beforeAll(async () => {
  dir = makeProject(SAMPLE_FILES);
  graph = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
});
afterAll(() => cleanup(dir));

describe('export formats', () => {
  it('maps extensions to formats', () => {
    expect(formatForExt('.graphml')).toBe('graphml');
    expect(formatForExt('.dot')).toBe('dot');
    expect(formatForExt('.cypher')).toBe('cypher');
    expect(formatForExt('.xyz')).toBeNull();
  });

  it('emits valid-looking GraphML / DOT / Cypher', () => {
    const ctx = { graph, generatedAt: graph.generatedAt };
    expect(exportGraph('graphml', ctx)).toContain('<graphml');
    expect(exportGraph('dot', ctx)).toMatch(/^digraph vg \{/);
    expect(exportGraph('cypher', ctx)).toContain('CREATE');
    expect(exportGraph('ndjson', ctx).trim().split('\n').length).toBeGreaterThan(0);
  });

  it('emits a CycloneDX SBOM with components', () => {
    const out = exportGraph('cyclonedx', {
      graph,
      generatedAt: graph.generatedAt,
      deps: [{ name: 'left', ecosystem: 'npm', declared: '^1', installed: '1.2.3' }],
      models: [{ runtime: 'ollama', name: 'llama3:latest', path: '/x' }],
    });
    const bom = JSON.parse(out);
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.components.some((c: { type: string }) => c.type === 'machine-learning-model')).toBe(true);
  });

  it('exports are deterministic', () => {
    const ctx = { graph, generatedAt: graph.generatedAt };
    expect(exportGraph('graphml', ctx)).toBe(exportGraph('graphml', ctx));
  });
});

describe('push envelope + redaction', () => {
  it('redacts credential-shaped signatures', () => {
    const tainted: VgGraph = {
      ...graph,
      nodes: graph.nodes.map((n, i) =>
        i === 0 ? { ...n, signature: 'const k = "sk-abcdefghijklmnop0123456789"' } : n,
      ),
    };
    const red = redactGraph(tainted);
    expect(red.nodes.some((n) => n.signature === '[redacted]')).toBe(true);
    expect(JSON.stringify(red)).not.toContain('sk-abcdefghijklmnop');
  });

  it('builds a decoupled envelope (no upload)', () => {
    const env = buildEnvelope(dir, graph);
    expect(env.artifactType).toBe('graph');
    expect(env.schemaVersion).toBe('vg-graph/1.0');
    expect(env.graph.nodes.length).toBe(graph.nodes.length);
  });
});
