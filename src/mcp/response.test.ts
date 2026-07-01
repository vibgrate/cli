import { describe, it, expect } from 'vitest';
import { countTokens } from '../engine/tokens.js';
import {
  toolResult,
  asStructured,
  boundList,
  NODE_EDGE_CAP,
  compactResult,
  clampToBudget,
  renderToolResult,
} from './response.js';

/** The serialised text block (narrowed from the MCP content union). */
function textOf(result: unknown): string {
  const block = toolResult(result).content[0];
  return block.type === 'text' ? block.text : '';
}

/**
 * These tests double as the *proof* that compact serialisation reduces tokens:
 * they measure pretty-printed vs compact output with the same cl100k_base
 * counter the CLI budgets against, and assert the reduction is real and lossless.
 */

// A response shaped like the heavier local tools (get_graph_summary + get_node):
// nested objects and arrays of qualified names / file paths — the realistic case.
function representativeResult() {
  return {
    mode: 'semantic (bge-small-en-v1.5)',
    counts: { nodes: 1843, edges: 7211, files: 412, areas: 23 },
    languages: { typescript: 0.82, javascript: 0.11, json: 0.07 },
    topHubs: Array.from({ length: 10 }, (_, i) => ({
      name: `src/engine/module${i}.ts:Service${i}.handle`,
      kind: 'function',
      file: `src/engine/module${i}.ts`,
      importance: 0.9 - i * 0.03,
    })),
    matches: Array.from({ length: 12 }, (_, i) => ({
      name: `src/reporting/commands/scan${i}.ts:runScan${i}`,
      kind: 'function',
      file: `src/reporting/commands/scan${i}.ts`,
      line: 40 + i,
      score: 0.77 - i * 0.02,
    })),
  };
}

describe('toolResult (compact, lossless serialisation)', () => {
  it('emits compact JSON in the text block (no pretty-print whitespace)', () => {
    const text = textOf(representativeResult());
    // Compact JSON for a multi-key object never contains the ",\n" / "{\n"
    // sequences that pretty-printing introduces.
    expect(text).not.toContain('\n');
    // Round-trips to exactly the same value — nothing the model reads changed.
    expect(JSON.parse(text)).toEqual(representativeResult());
  });

  it('is byte-for-byte lossless: structuredContent equals the source object', () => {
    const result = representativeResult();
    const out = toolResult(result);
    expect(out.structuredContent).toEqual(result);
  });

  it('reduces tokens vs pretty-printed output (the measured saving)', () => {
    const result = representativeResult();
    const pretty = countTokens(JSON.stringify(result, null, 2));
    const compact = countTokens(textOf(result));
    const reductionPct = ((pretty - compact) / pretty) * 100;
    // Surface the number in test output so the saving is auditable in CI.
    console.log(`compact serialisation: ${pretty} → ${compact} tokens (-${reductionPct.toFixed(1)}%)`);
    expect(compact).toBeLessThan(pretty);
    expect(reductionPct).toBeGreaterThan(10);
  });

  it('wraps arrays/primitives so structuredContent is always an object', () => {
    expect(asStructured([1, 2, 3])).toEqual({ result: [1, 2, 3] });
    expect(asStructured('x')).toEqual({ result: 'x' });
    expect(asStructured({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('boundList (honest truncation)', () => {
  it('returns everything and the true total when under the cap', () => {
    expect(boundList([1, 2, 3], 10)).toEqual({ items: [1, 2, 3], total: 3 });
  });

  it('caps items but always reports the real total', () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const bounded = boundList(items, NODE_EDGE_CAP);
    expect(bounded.items).toHaveLength(NODE_EDGE_CAP);
    expect(bounded.items[0]).toBe(0); // deterministic prefix
    expect(bounded.total).toBe(200);
  });

  it('treats an exact-cap list as un-truncated', () => {
    const items = Array.from({ length: NODE_EDGE_CAP }, (_, i) => i);
    expect(boundList(items, NODE_EDGE_CAP)).toEqual({ items, total: NODE_EDGE_CAP });
  });
});

describe('compactResult (drop empty/absent fields)', () => {
  it('drops null/undefined/empty fields but keeps meaningful falsy values', () => {
    const out = compactResult({
      a: 1,
      b: null,
      c: '',
      d: [],
      e: {},
      f: false,
      g: 0,
      h: [1],
      keep: 'x',
    });
    expect(out).toEqual({ a: 1, f: false, g: 0, h: [1], keep: 'x' });
  });

  it('prunes recursively and removes objects that become empty', () => {
    expect(compactResult({ a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
    expect(compactResult({ a: { b: null } })).toEqual({});
  });
});

describe('clampToBudget (token ceiling)', () => {
  it('returns small results unchanged', () => {
    const v = { a: 1, items: [1, 2, 3] };
    expect(clampToBudget(v, 25_000)).toBe(v);
  });

  it('trims the heaviest array and records what was elided', () => {
    const big = { items: Array.from({ length: 1000 }, (_, i) => `item-number-${i}-with-some-padding`) };
    const clamped = clampToBudget(big, 200) as { items: string[]; _truncated?: Record<string, { shown: number; total: number }> };
    expect(clamped.items.length).toBeLessThan(1000);
    expect(clamped._truncated?.items.total).toBe(1000);
    expect(countTokens(JSON.stringify(clamped))).toBeLessThanOrEqual(200);
  });

  it('passes array-rooted results through (they are bounded elsewhere)', () => {
    const arr = [1, 2, 3];
    expect(clampToBudget(arr, 1)).toBe(arr);
  });
});

describe('renderToolResult (compact → clamp → serialise)', () => {
  it('produces compact, budget-bounded output in one step', () => {
    const big = { note: 'hi', empty: null, items: Array.from({ length: 1000 }, (_, i) => `x${i}`) };
    const out = renderToolResult(big, 150);
    const block = out.content[0];
    const text = block.type === 'text' ? block.text : '';
    expect(text).not.toContain('\n'); // compact
    expect(JSON.parse(text).empty).toBeUndefined(); // compacted
    expect(countTokens(text)).toBeLessThanOrEqual(150); // clamped
  });
});
