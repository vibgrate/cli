import { serializeGraph } from './serialize.js';
import { renderReport } from './report.js';
import { renderHtml } from './html.js';
import type { DepRecord } from './drift.js';
import type { LocalModel } from './models.js';
import type { VgGraph } from '../schema.js';

/**
 * Deterministic exporters (VG-CLI-SPEC §4.2). One `vg export <file>` verb, format
 * inferred from the extension. Live graph-DB push is deliberately out (a file
 * import covers the same need offline). CycloneDX/SPDX power the SBOM/AI-BOM seam
 * (VG-LOCAL-MODELS §9.4).
 */

export type ExportFormat =
  | 'json'
  | 'ndjson'
  | 'graphml'
  | 'dot'
  | 'cypher'
  | 'md'
  | 'html'
  | 'cyclonedx'
  | 'spdx';

export function formatForExt(ext: string): ExportFormat | null {
  switch (ext.toLowerCase()) {
    case '.json':
      return 'json';
    case '.ndjson':
      return 'ndjson';
    case '.graphml':
      return 'graphml';
    case '.dot':
    case '.gv':
      return 'dot';
    case '.cypher':
      return 'cypher';
    case '.md':
      return 'md';
    case '.html':
      return 'html';
    default:
      return null;
  }
}

export interface ExportContext {
  graph: VgGraph;
  deps?: DepRecord[];
  models?: LocalModel[];
  generatedAt: string;
}

export function exportGraph(format: ExportFormat, ctx: ExportContext): string {
  switch (format) {
    case 'json':
      return serializeGraph(ctx.graph);
    case 'md':
      return renderReport(ctx.graph);
    case 'html':
      return renderHtml(ctx.graph);
    case 'ndjson':
      return ndjson(ctx.graph);
    case 'graphml':
      return graphml(ctx.graph);
    case 'dot':
      return dot(ctx.graph);
    case 'cypher':
      return cypher(ctx.graph);
    case 'cyclonedx':
      return cyclonedx(ctx);
    case 'spdx':
      return spdx(ctx);
  }
}

function ndjson(graph: VgGraph): string {
  // Facts stream if present, else the node stream — one JSON object per line.
  const rows = graph.facts && graph.facts.length ? graph.facts : graph.nodes;
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function graphml(graph: VgGraph): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
  lines.push('  <key id="name" for="node" attr.name="name" attr.type="string"/>');
  lines.push('  <key id="kind" for="node" attr.name="kind" attr.type="string"/>');
  lines.push('  <key id="file" for="node" attr.name="file" attr.type="string"/>');
  lines.push('  <key id="ekind" for="edge" attr.name="kind" attr.type="string"/>');
  lines.push('  <graph edgedefault="directed">');
  for (const n of graph.nodes) {
    lines.push(`    <node id="${esc(n.id)}"><data key="name">${esc(n.qualifiedName)}</data><data key="kind">${esc(n.kind)}</data><data key="file">${esc(n.file)}</data></node>`);
  }
  for (const e of graph.edges) {
    lines.push(`    <edge source="${esc(e.src)}" target="${esc(e.dst)}"><data key="ekind">${esc(e.kind)}</data></edge>`);
  }
  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n') + '\n';
}

function dot(graph: VgGraph): string {
  const lines: string[] = ['digraph vg {'];
  for (const n of graph.nodes) lines.push(`  "${n.id}" [label="${dotEsc(n.qualifiedName)}"];`);
  for (const e of graph.edges) lines.push(`  "${e.src}" -> "${e.dst}" [label="${e.kind}"];`);
  lines.push('}');
  return lines.join('\n') + '\n';
}
function dotEsc(s: string): string {
  return s.replace(/"/g, '\\"');
}

function cypher(graph: VgGraph): string {
  const lines: string[] = [];
  for (const n of graph.nodes) {
    lines.push(
      `CREATE (:\`${cypherLabel(n.kind)}\` {id:${q(n.id)}, name:${q(n.qualifiedName)}, file:${q(n.file)}});`,
    );
  }
  for (const e of graph.edges) {
    lines.push(
      `MATCH (a {id:${q(e.src)}}),(b {id:${q(e.dst)}}) CREATE (a)-[:\`${cypherLabel(e.kind)}\`]->(b);`,
    );
  }
  return lines.join('\n') + '\n';
}
function cypherLabel(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}
function q(s: string): string {
  return JSON.stringify(s);
}

function cyclonedx(ctx: ExportContext): string {
  // CycloneDX 1.6 JSON — dependencies as library components + local models as
  // machine-learning-model components (AI-BOM). Deterministic ordering; no
  // timestamps beyond the pinned generatedAt.
  const components: unknown[] = [];
  for (const d of ctx.deps ?? []) {
    components.push({
      type: 'library',
      name: d.name,
      version: d.installed ?? d.declared,
      purl: d.ecosystem === 'npm' ? `pkg:npm/${d.name}@${d.installed ?? ''}` : undefined,
    });
  }
  for (const m of ctx.models ?? []) {
    components.push({ type: 'machine-learning-model', name: m.name, properties: [{ name: 'vg:runtime', value: m.runtime }] });
  }
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    metadata: { timestamp: ctx.generatedAt, tools: [{ name: 'vg', version: ctx.graph.provenance.version }] },
    components,
  };
  return JSON.stringify(bom, null, 2) + '\n';
}

function spdx(ctx: ExportContext): string {
  const packages = (ctx.deps ?? []).map((d) => ({
    SPDXID: `SPDXRef-Package-${cypherLabel(d.name)}`,
    name: d.name,
    versionInfo: d.installed ?? d.declared,
    downloadLocation: 'NOASSERTION',
  }));
  const doc = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'vg-sbom',
    creationInfo: { created: ctx.generatedAt, creators: [`Tool: vg-${ctx.graph.provenance.version}`] },
    packages,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}
