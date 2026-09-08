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
