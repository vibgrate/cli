import { stableStringify } from './serialize.js';
import type { VgGraph } from '../schema.js';

/**
 * `graph.html`: self-contained, dependency-free, deterministic overview.
 *
 * For small/medium maps we embed the full graph JSON for tooling.
 * For large maps (default: >5k nodes) we embed only a
 * **hub + area summary** so the HTML stays openable; full data stays in
 * graph.json / graph.db. Interactive WebGL (sigma.js) remains a follow-up.
 */

const EMBED_NODE_LIMIT = 5_000;

export function renderHtml(graph: VgGraph): string {
  const top = graph.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'external')
    .sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, 50);

  const areas = [...graph.areas]
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, 40);

  const rows = top
    .map(
      (n) =>
        `<tr><td><code>${esc(n.qualifiedName)}</code></td><td>${esc(n.kind)}</td>` +
        `<td><code>${esc(n.file)}</code>:${n.span.start}</td><td>${n.importance.toFixed(3)}</td></tr>`,
    )
    .join('\n');

  const areaRows = areas
    .map(
      (a) =>
        `<tr><td>${a.id}</td><td><code>${esc(a.label)}</code></td>` +
        `<td>${a.size}</td><td>${a.cohesion.toFixed(3)}</td><td>${a.externalEdges}</td></tr>`,
    )
    .join('\n');

  const large = graph.meta.counts.nodes > EMBED_NODE_LIMIT;
  const embedPayload = large
    ? {
        schemaVersion: graph.schemaVersion,
        generatedAt: graph.generatedAt,
        provenance: graph.provenance,
        meta: graph.meta,
        hubs: top.map((n) => ({
          id: n.id,
          name: n.qualifiedName,
          kind: n.kind,
          file: n.file,
          line: n.span.start,
          importance: n.importance,
          area: n.area,
        })),
        areas: areas.map((a) => ({
          id: a.id,
          label: a.label,
          size: a.size,
          cohesion: a.cohesion,
          externalEdges: a.externalEdges,
        })),
        note: `Full graph omitted (${graph.meta.counts.nodes} nodes > ${EMBED_NODE_LIMIT}). Use graph.json or .vibgrate/cache/graph.db.`,
      }
    : graph;

  const embedded = stableStringify(embedPayload, 0);
  const tier = graph.meta.analysisTier ?? 'full';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vg · code graph</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8884; }
  td:last-child, th:last-child { text-align: right; }
  .meta { color: #888; } code { font-size: 0.9em; }
  .banner { background: #8882; padding: 0.6rem 0.8rem; border-radius: 6px; margin: 1rem 0; }
</style>
</head>
<body>
<h1>vg · code graph</h1>
<p class="meta">${graph.meta.counts.nodes} nodes · ${graph.meta.counts.edges} edges ·
${graph.meta.counts.areas} areas · ${esc(graph.meta.languages.join(', ') || '—')} ·
clustering: ${esc(graph.meta.cluster)} · tier: ${esc(tier)} · vg ${esc(graph.provenance.version)}</p>
${
  large
    ? `<p class="banner">Large map (${graph.meta.counts.nodes} nodes): HTML shows hubs + areas only.
Full graph remains in <code>graph.json</code> / <code>.vibgrate/cache/graph.db</code> (query via <code>vg serve</code>).</p>`
    : ''
}
<h2>Areas (subsystems)</h2>
<table>
<thead><tr><th>Id</th><th>Label</th><th>Size</th><th>Cohesion</th><th>External</th></tr></thead>
<tbody>
${areaRows || '<tr><td colspan="5" class="meta">no areas</td></tr>'}
</tbody>
</table>
<h2>Most-connected definitions (hubs)</h2>
<table>
<thead><tr><th>Symbol</th><th>Kind</th><th>Location</th><th>Importance</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="meta">${large ? 'Summary payload' : 'Full graph'} embedded below for tooling.</p>
<script type="application/json" id="vg-graph">
${embedded}
</script>
</body>
</html>
`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
