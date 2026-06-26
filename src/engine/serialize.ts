import type { VgGraph } from '../schema.js';

/**
 * Deterministic serialization of `graph.json`.
 *
 * Object keys are sorted recursively and arrays are emitted in the (already
 * stable) order the engine produced them, so two runs over identical content
 * yield byte-identical output — the determinism contract (VG-CLI-SPEC §1.3).
 * Pretty-printed (2-space) and newline-terminated so the committed artifact is
 * human-diffable and plays well with the union merge driver.
 */
export function serializeGraph(graph: VgGraph): string {
  return `${stableStringify(graph, 2)}\n`;
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v === undefined) continue; // omit undefined for stable output
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function parseGraph(json: string): VgGraph {
  return JSON.parse(json) as VgGraph;
}
