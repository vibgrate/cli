// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ArchitectureLayer, ArchitectureResult } from '../../types.js';

/** Fixed 10-layer stack — mermaid stays `flowchart TD` over this order. */
export const LAYER_FLOW_ORDER: ArchitectureLayer[] = [
  'presentation', 'routing', 'middleware', 'services', 'domain',
  'data-access', 'infrastructure', 'config', 'shared', 'testing',
];

const LAYER_LABELS: Record<ArchitectureLayer, string> = {
  presentation: 'Presentation',
  routing: 'Routing',
  middleware: 'Middleware',
  services: 'Services',
  domain: 'Domain',
  'data-access': 'Data Access',
  infrastructure: 'Infrastructure',
  config: 'Config',
  shared: 'Shared',
  testing: 'Testing',
};

export function generateLayerFlowMermaid(layers: ArchitectureLayer[]): string {
  if (layers.length === 0) {
    return 'flowchart TD\n  APP["Project"]';
  }

  const ordered = [...layers];
  const lines: string[] = ['flowchart TD'];
  for (let i = 0; i < ordered.length; i++) {
    const layer = ordered[i];
    lines.push(`  L${i}["${LAYER_LABELS[layer]}"]`);
    if (i > 0) lines.push(`  L${i - 1} --> L${i}`);
  }
  return lines.join('\n');
}

/** 10-layer flowchart from an already-computed result — no second walk. */
export function mermaidFromArchitecture(result: ArchitectureResult): string {
  const present = new Set(
    result.layers.filter((l) => l.fileCount > 0).map((l) => l.layer),
  );
  return generateLayerFlowMermaid(LAYER_FLOW_ORDER.filter((l) => present.has(l)));
}
