import { describe, expect, it } from 'vitest';
import { extraToolsFor } from './server.js';
import { COMPRESS_TOOLS } from './compress-tools.js';
import { HOT_TOOLS, TOOLS } from './tools.js';

const names = (opts: Parameters<typeof extraToolsFor>[0]): string[] => extraToolsFor(opts, '/repo').map((t) => t.name).sort();

describe('what a default `vg serve` advertises', () => {
  it('lists no compression or memory tools at all', () => {
    // FEATURE-DESIGN-PRINCIPLES P2: every advertised schema rides every agent
    // step. A user who never asked for compression must not pay for its
    // schemas, so the gate is at registration, not in the surface filter.
    expect(names({})).toEqual([]);
    expect(names({ compressTools: false, memory: false })).toEqual([]);
  });

  it('adds the compression tools only under --compress', () => {
    expect(names({ compressTools: true })).toEqual(['compress_content', 'compression_stats', 'retrieve_original']);
  });

  it('adds the memory tools only under --memory', () => {
    expect(names({ memory: true })).toEqual(['memory_save', 'memory_search']);
  });

  it('keeps the hot navigation core at four, untouched by either flag', () => {
    expect(HOT_TOOLS).toHaveLength(4);
    const added = new Set(names({ compressTools: true, memory: true }));
    for (const hot of HOT_TOOLS) expect(added.has(hot)).toBe(false);
  });

  it('never shadows a code-map tool', () => {
    const graphTools = new Set(TOOLS.map((t) => t.name));
    for (const name of names({ compressTools: true, memory: true })) {
      expect(graphTools.has(name), name).toBe(false);
    }
  });
});

describe('honesty of the compression tool annotations', () => {
  it('declares the two that write local state as writers', () => {
    // A tool that appends to a ledger or a store is not read-only. Claiming
    // otherwise is how a host ends up auto-approving a write.
    const byName = Object.fromEntries(COMPRESS_TOOLS.map((t) => [t.name, t]));
    expect(byName.compress_content.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.retrieve_original.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.compression_stats.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('answers without a code map, so `--compress-only` can serve them', () => {
    for (const t of COMPRESS_TOOLS) expect(t.graphless, t.name).toBe(true);
  });
});
