import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerModels } from './models.js';

/** Run `vg <args…>` against a fresh program, capturing JSON written to stdout. */
async function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on error
  registerModels(program);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  });
  try {
    await program.parseAsync(args, { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  const out = chunks.join('');
  return out.trim() ? JSON.parse(out) : undefined;
}

afterEach(() => vi.restoreAllMocks());

describe('vg models rm', () => {
  it('prints a dry-run plan and removes nothing without --yes', async () => {
    const res = (await run(['models', 'rm', 'qwen2.5-coder:7b', '--json'])) as {
      command: string;
      willRemove: boolean;
      removed?: boolean;
    };
    expect(res.command).toBe('ollama rm qwen2.5-coder:7b');
    expect(res.willRemove).toBe(false);
    expect(res.removed).toBeUndefined(); // never ran the removal
  });

  it('rejects a non-ollama runtime', async () => {
    await expect(run(['models', 'rm', 'x', '--runtime', 'lmstudio', '--json'])).rejects.toBeTruthy();
  });
});

describe('vg models catalog', () => {
  it('emits a grouped catalog offline (cache or curated fallback — never the network)', async () => {
    const res = (await run(['models', 'catalog', '--offline', '--json'])) as {
      providers: { id: string; label: string; models: unknown[] }[];
      source: string;
    };
    expect(Array.isArray(res.providers)).toBe(true);
    expect(res.providers.length).toBeGreaterThan(0);
    expect(['cache', 'fallback']).toContain(res.source); // offline never hits the network
  });
});
