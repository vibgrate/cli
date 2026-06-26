import { stableStringify } from './serialize.js';
import type { VgGraph } from '../schema.js';

/**
 * Phase-0 `graph.html`: a self-contained, dependency-free, deterministic
 * overview (summary + most-connected definitions + per-file breakdown), with the
 * full graph embedded as JSON for tooling. The interactive WebGL view (sigma.js
 * over a ForceAtlas2 layout, scaling past ~5k nodes — VG-ENGINE-TEARDOWN §3.12)
 * lands in Phase 1; this keeps the artifact present, honest, and byte-stable now.
 */
export function renderHtml(graph: VgGraph): string {
  const top = graph.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'external')
    .sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, 50);

  const rows = top
    .map(
      (n) =>
        `<tr><td><code>${esc(n.qualifiedName)}</code></td><td>${esc(n.kind)}</td>` +
        `<td><code>${esc(n.file)}</code>:${n.span.start}</td><td>${n.importance.toFixed(3)}</td></tr>`,
    )
    .join('\n');

  const embedded = stableStringify(graph, 0);

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
</style>
</head>
<body>
<h1>vg · code graph</h1>
<p class="meta">${graph.meta.counts.nodes} nodes · ${graph.meta.counts.edges} edges ·
${graph.meta.counts.areas} areas · ${esc(graph.meta.languages.join(', ') || '—')} ·
clustering: ${esc(graph.meta.cluster)} · vg ${esc(graph.provenance.version)}</p>
<h2>Most-connected definitions</h2>
<table>
<thead><tr><th>Symbol</th><th>Kind</th><th>Location</th><th>Importance</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="meta">Interactive WebGL view arrives in Phase 1. The full graph is embedded below for tooling.</p>
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
