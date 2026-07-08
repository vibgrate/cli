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
  | 'sql'
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
    case '.sql':
      return 'sql';
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
    case 'sql':
      return sql(ctx);
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

/**
 * Portable SQL fact-DB (VG-CLI-SPEC §4.2, agent-consumption). Emits deterministic
 * DDL + INSERT text — NOT a native driver — that loads identically into BOTH
 * sqlite3 and duckdb (`sqlite3 map.db < map.sql` / `duckdb map.db < map.sql`).
 * Text keeps the CLI dependency-free, offline, and byte-diffable; an identical
 * graph yields identical bytes. An agent can then run e.g.
 *   SELECT src, dst FROM edges WHERE epistemic = 'observed' AND confidence >= 0.9;
 * Determinism: single transaction, `CREATE TABLE IF NOT EXISTS`, rows emitted in
 * the graph's own (already-sorted) array order, single quotes doubled, NULL for
 * absent optionals, booleans as 0/1, and no timestamp but the graph's generatedAt.
 */
function sql(ctx: ExportContext): string {
  const graph = ctx.graph;
  const lines: string[] = [];
  lines.push('BEGIN;');

  // meta — provenance / toolchain fingerprint (key/value; agent can read the corpus hash).
  lines.push('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);');
  const meta: [string, string | null][] = [
    ['schemaVersion', graph.schemaVersion],
    ['generatedAt', ctx.generatedAt],
    ['corpusHash', graph.provenance.corpusHash],
    ['tool', graph.provenance.tool],
    ['toolVersion', graph.provenance.version],
    ['resolver', graph.provenance.resolver.join(',')],
    ['fingerprint', graph.provenance.toolchain?.fingerprint ?? null],
  ];
  for (const [k, v] of meta) lines.push(`INSERT INTO meta VALUES (${sqlStr(k)}, ${sqlStr(v)});`);

  // nodes
  lines.push(
    'CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file TEXT, span_start INTEGER, span_end INTEGER, lang TEXT, visibility TEXT, signature TEXT, importance REAL, area INTEGER, is_hub INTEGER, tested INTEGER, coverage REAL);',
  );
  for (const n of graph.nodes) {
    lines.push(
      `INSERT INTO nodes VALUES (${sqlStr(n.id)}, ${sqlStr(n.kind)}, ${sqlStr(n.name)}, ${sqlStr(n.qualifiedName)}, ${sqlStr(n.file)}, ${sqlNum(n.span.start)}, ${sqlNum(n.span.end)}, ${sqlStr(n.lang)}, ${sqlStr(n.visibility)}, ${sqlStr(n.signature)}, ${sqlNum(n.importance)}, ${sqlNum(n.area)}, ${sqlBool(n.isHub)}, ${sqlBool(n.tested)}, ${sqlNum(n.coverage)});`,
    );
  }

  // edges — the epistemic column is the point: SELECT ... WHERE epistemic='observed'.
  lines.push(
    'CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, kind TEXT, src TEXT, dst TEXT, resolution TEXT, confidence REAL, epistemic TEXT, surprise REAL, "count" INTEGER);',
  );
  for (const e of graph.edges) {
    lines.push(
      `INSERT INTO edges VALUES (${sqlStr(e.id)}, ${sqlStr(e.kind)}, ${sqlStr(e.src)}, ${sqlStr(e.dst)}, ${sqlStr(e.resolution)}, ${sqlNum(e.confidence)}, ${sqlStr(e.epistemic)}, ${sqlNum(e.surprise)}, ${sqlNum(e.count)});`,
    );
  }

  // areas (+ members)
  lines.push('CREATE TABLE IF NOT EXISTS areas (id INTEGER PRIMARY KEY, label TEXT, size INTEGER, cohesion REAL, external_edges INTEGER);');
  lines.push('CREATE TABLE IF NOT EXISTS area_members (area_id INTEGER, node_id TEXT);');
  for (const a of graph.areas) {
    lines.push(`INSERT INTO areas VALUES (${sqlNum(a.id)}, ${sqlStr(a.label)}, ${sqlNum(a.size)}, ${sqlNum(a.cohesion)}, ${sqlNum(a.externalEdges)});`);
    for (const m of a.members) lines.push(`INSERT INTO area_members VALUES (${sqlNum(a.id)}, ${sqlStr(m)});`);
  }

  // facts (+ subjects, evidence) — only with a --deep build.
  if (graph.facts && graph.facts.length) {
    lines.push('CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, kind TEXT, predicate_json TEXT, derived_by TEXT, confidence TEXT);');
    lines.push('CREATE TABLE IF NOT EXISTS fact_subjects (fact_id TEXT, node_id TEXT);');
    lines.push('CREATE TABLE IF NOT EXISTS fact_evidence (fact_id TEXT, file TEXT, span_start INTEGER, span_end INTEGER);');
    for (const f of graph.facts) {
      lines.push(`INSERT INTO facts VALUES (${sqlStr(f.id)}, ${sqlStr(f.kind)}, ${sqlStr(JSON.stringify(f.predicate))}, ${sqlStr(f.derivedBy)}, ${sqlStr(f.confidence)});`);
      for (const s of f.subjectIds) lines.push(`INSERT INTO fact_subjects VALUES (${sqlStr(f.id)}, ${sqlStr(s)});`);
      for (const ev of f.evidence) lines.push(`INSERT INTO fact_evidence VALUES (${sqlStr(f.id)}, ${sqlStr(ev.file)}, ${sqlNum(ev.span.start)}, ${sqlNum(ev.span.end)});`);
    }
  }

  lines.push('COMMIT;');
  return lines.join('\n') + '\n';
}

/** SQL string literal (single quotes doubled) or NULL for absent values. */
function sqlStr(v: string | null | undefined): string {
  if (v == null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}
/** Numeric literal or NULL for absent values. */
function sqlNum(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? 'NULL' : String(v);
}
/** Boolean as 0/1, NULL when unknown (e.g. an unanalyzable node's `tested`). */
function sqlBool(v: boolean | null | undefined): string {
  return v == null ? 'NULL' : v ? '1' : '0';
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
