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

describe('vg models status / resolve', () => {
  it('emits Code Modes status JSON', async () => {
    const res = (await run(['models', 'status', '--json'])) as {
      schemaVersion: string;
      modes: { mode: string; packId: string; fit: string }[];
      recommended: string;
    };
    expect(res.schemaVersion).toMatch(/model-orchestrator/);
    expect(res.modes.length).toBe(3);
    expect(['spark', 'flow', 'forge']).toContain(res.recommended);
  });

  it('resolves a mode without downloading', async () => {
    const res = (await run(['models', 'resolve', 'spark', '--json'])) as {
      mode: string;
      pack: { packId: string };
      underlying: { weightsRef: string };
      fit: { label: string };
    };
    expect(res.mode).toBe('spark');
    expect(res.pack.packId).toMatch(/^spark@/);
    expect(res.underlying.weightsRef).toBeTruthy();
    expect(res.fit.label).toBeTruthy();
  });

  it('ensure without --yes is a dry-run plan', async () => {
    const res = (await run(['models', 'ensure', 'spark', '--json'])) as {
      willDownload?: boolean;
      installed?: boolean;
      note?: string;
      mode?: string;
      ok?: boolean;
      reason?: string;
      resolved?: { mode: string };
    };
    // Either already installed, dry-run plan, or will_not_fit — never silently downloads.
    if (res.reason === 'will_not_fit') {
      expect(res.ok).toBe(false);
      expect(res.resolved?.mode).toBe('spark');
    } else if (res.installed) {
      expect(res.mode).toBe('spark');
      expect(res.willDownload).not.toBe(true);
    } else {
      expect(res.willDownload ?? false).toBe(false);
      expect(String(res.note ?? '')).toMatch(/dry-run|--yes|already/i);
    }
  });
});

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
