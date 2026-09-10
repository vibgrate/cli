import { describe, expect, it, vi } from 'vitest';
import { BYTE_EXACT_TOOLS, createToolOutputCompressor, shouldCompress } from './compress-tool-output.js';

const big = (n = 8000): string => 'x'.repeat(n);
const shrink = (): { content: string; tokensSaved: number } => ({ content: 'small', tokensSaved: 100 });

describe('what the vg code loop will and will not compress', () => {
  it('leaves a result an edit could be computed from byte-exact, however large', () => {
    for (const tool of BYTE_EXACT_TOOLS) {
      expect(shouldCompress(tool, big(1_000_000), {}, 4000), tool).toBe(false);
    }
  });

  it('leaves a failed result whole — that is what the model needs to recover', () => {
    expect(shouldCompress('run_command', big(), { failed: true }, 4000)).toBe(false);
  });

  it('compresses bulky output from the tools that produce it', () => {
    for (const tool of ['run_command', 'search_code', 'web_fetch', 'library_docs', 'list_files']) {
      expect(shouldCompress(tool, big(), {}, 4000), tool).toBe(true);
    }
  });

  it('leaves small results alone — the round trip would cost more than it saves', () => {
    expect(shouldCompress('run_command', 'ok\n', {}, 4000)).toBe(false);
    expect(shouldCompress('run_command', big(3999), {}, 4000)).toBe(false);
    expect(shouldCompress('run_command', big(4000), {}, 4000)).toBe(true);
  });
});

describe('the in-loop compressor', () => {
  it('is off when VG_CODE_COMPRESS says so, and then never calls the engine', () => {
    const compress = vi.fn(shrink);
    const c = createToolOutputCompressor({ compress, env: { VG_CODE_COMPRESS: '0' } as NodeJS.ProcessEnv });
    expect(c.compress('run_command', big(), {})).toBe(big());
    expect(compress).not.toHaveBeenCalled();
    expect(c.saved).toBe(0);
  });

  it('is on by default — an agent loop is the case the layer exists for', () => {
    const c = createToolOutputCompressor({ compress: shrink, env: {} as NodeJS.ProcessEnv });
    expect(c.compress('run_command', big(), {})).toBe('small');
    expect(c.saved).toBe(100);
  });

  it('passes the tool’s output shape to the router so it picks the right compressor', () => {
    const compress = vi.fn(shrink);
    const c = createToolOutputCompressor({ compress, env: {} as NodeJS.ProcessEnv });
    c.compress('run_command', big(), { query: 'why is the build red' });
    expect(compress).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Bash', query: 'why is the build red' }));
    c.compress('search_code', big(), {});
    expect(compress).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: 'Grep' }));
  });

  it('keeps the original when the engine throws — compression never breaks a session', () => {
    const c = createToolOutputCompressor({
      compress: () => {
        throw new Error('router exploded');
      },
      env: {} as NodeJS.ProcessEnv,
    });
    const content = big();
    expect(c.compress('run_command', content, {})).toBe(content);
    expect(c.saved).toBe(0);
  });

  it('keeps the original when "compression" did not actually shrink anything', () => {
    const content = big(5000);
    const c = createToolOutputCompressor({ compress: () => ({ content: content + 'more', tokensSaved: 0 }), env: {} as NodeJS.ProcessEnv });
    expect(c.compress('run_command', content, {})).toBe(content);
    const empty = createToolOutputCompressor({ compress: () => ({ content: '', tokensSaved: 9 }), env: {} as NodeJS.ProcessEnv });
    expect(empty.compress('run_command', content, {})).toBe(content);
    expect(empty.saved).toBe(0);
  });

  it('accumulates what it saved across a session', () => {
    const c = createToolOutputCompressor({ compress: shrink, env: {} as NodeJS.ProcessEnv });
    c.compress('run_command', big(), {});
    c.compress('web_fetch', big(), {});
    expect(c.saved).toBe(200);
  });

  it('respects a raised floor', () => {
    const compress = vi.fn(shrink);
    const c = createToolOutputCompressor({ compress, env: { VG_CODE_COMPRESS_MIN_CHARS: '100000' } as NodeJS.ProcessEnv });
    expect(c.compress('run_command', big(), {})).toBe(big());
    expect(compress).not.toHaveBeenCalled();
  });
});

describe('the retrieve seam and the ledger', () => {
  it('advertises vg_retrieve only when a store is bound, and answers calls from it', () => {
    const without = createToolOutputCompressor({ compress: shrink, env: {} as NodeJS.ProcessEnv });
    expect(without.toolSpec).toBeNull();
    expect(without.retrieve({ hash: 'abc' })).toBeNull();
    const retrieve = vi.fn((args: Record<string, unknown>) => ({ content: JSON.stringify({ hash: args.hash, original_content: 'the whole log' }), found: true }));
    const c = createToolOutputCompressor({ compress: shrink, retrieve, env: {} as NodeJS.ProcessEnv });
    expect(c.toolSpec).toMatchObject({ name: 'vg_retrieve' });
    expect((c.toolSpec!.parameters as { required: string[] }).required).toEqual(['hash']);
    expect(c.retrieve({ hash: 'deadbeefdeadbeef', grep: 'ERROR' })).toMatchObject({ found: true });
    expect(retrieve).toHaveBeenCalledWith({ hash: 'deadbeefdeadbeef', grep: 'ERROR' });
    expect(c.stats.retrievals).toBe(1);
  });

  it('a retrieval that throws becomes an error result, never a crashed session', () => {
    const c = createToolOutputCompressor({
      compress: shrink,
      retrieve: () => {
        throw new Error('store unreadable');
      },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(c.retrieve({ hash: 'x' })).toMatchObject({ found: false });
    expect(c.retrieve({ hash: 'x' })!.content).toContain('store unreadable');
  });

  it('keeps before/after totals and writes one ledger row for the session under the vg-code client', () => {
    const rows: unknown[] = [];
    const c = createToolOutputCompressor({
      compress: () => ({ content: 'small', tokensSaved: 900, tokensBefore: 1000, tokensAfter: 100 }),
      ledger: { append: (ev) => (rows.push(ev), true), usdSaved: (model, tokens) => (model === 'claude-sonnet-5' ? tokens * 0.000002 : 0) },
      env: {} as NodeJS.ProcessEnv,
      now: () => 1234,
    });
    expect(c.record({ model: 'claude-sonnet-5' })).toBe(false); // nothing saved yet → nothing written
    c.compress('run_command', big(), {});
    c.compress('web_fetch', big(), {});
    expect(c.stats).toMatchObject({ results: 2, tokensBefore: 2000, tokensAfter: 200, tokensSaved: 1800 });
    expect(c.record({ model: 'claude-sonnet-5', project: 'repo' })).toBe(true);
    expect(rows).toEqual([
      { ts: 1234, source: 'cli', model: 'claude-sonnet-5', client: 'vg-code', project: 'repo', tokensBefore: 2000, tokensAfter: 200, tokensSaved: 1800, usdSaved: 0.0036, transforms: ['code:tool_output'], ccrHashes: 2 },
    ]);
  });

  it('is inert end to end when compression is off', () => {
    const c = createToolOutputCompressor({ compress: shrink, retrieve: () => ({ content: '', found: true }), ledger: { append: () => true, usdSaved: () => 1 }, env: { VG_CODE_COMPRESS: '0' } as NodeJS.ProcessEnv });
    expect(c.enabled).toBe(false);
    expect(c.toolSpec).toBeNull();
    expect(c.record({ model: 'm' })).toBe(false);
  });
});
