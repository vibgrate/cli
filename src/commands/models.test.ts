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

  it('install --dry-run is a plan only (never downloads)', async () => {
    const res = (await run(['models', 'install', 'spark', '--dry-run', '--json'])) as {
      willDownload?: string[];
      ready?: boolean;
      note?: string;
      mode?: string;
      ok?: boolean;
      reason?: string;
      resolved?: { mode: string };
      schemaVersion?: string;
    };
    // Either already installed, dry-run plan, or will_not_fit — never downloads with --dry-run.
    if (res.reason === 'will_not_fit') {
      expect(res.ok).toBe(false);
      expect(res.resolved?.mode).toBe('spark');
    } else if (res.ready) {
      expect(res.mode).toBe('spark');
      expect(res.willDownload ?? []).toEqual([]);
    } else {
      expect(res.schemaVersion).toMatch(/model-install-plan/);
      expect(String(res.note ?? '')).toMatch(/dry-run/i);
    }
  });
});

describe('vg models pull', () => {
  it('pull --dry-run prints the plan and does not download', async () => {
    const res = (await run(['models', 'pull', 'qwen2.5-coder:7b', '--dry-run', '--json'])) as {
      willDownload?: string[];
      note?: string;
      pulledWeights?: string[];
      schemaVersion?: string;
      ready?: boolean;
    };
    if (res.ready) {
      expect(res.willDownload ?? []).toEqual([]);
    } else {
      expect(res.schemaVersion).toMatch(/model-install-plan/);
      expect(String(res.note ?? '')).toMatch(/dry-run/i);
      expect(res.pulledWeights).toBeUndefined();
    }
  });
});

describe('vg models uninstall', () => {
  it('uninstall --dry-run prints the plan and removes nothing', async () => {
    const res = (await run(['models', 'uninstall', 'qwen2.5-coder:7b', '--dry-run', '--json'])) as {
      command: string;
      willRemove: boolean;
      removed?: boolean;
      runtime?: string;
    };
    expect(res.command).toBe('ollama rm qwen2.5-coder:7b');
    expect(res.runtime).toBe('ollama');
    expect(res.willRemove).toBe(false);
    expect(res.removed).toBeUndefined();
  });

  it('uninstall without --yes refuses non-interactively (no TTY in tests)', async () => {
    await expect(run(['models', 'uninstall', 'qwen2.5-coder:7b', '--json'])).rejects.toBeTruthy();
  });

  it('rejects an unknown --runtime value', async () => {
    await expect(run(['models', 'uninstall', 'x', '--runtime', 'not-a-runtime', '--json'])).rejects.toBeTruthy();
  });

  it('reports not found for a missing file-backed model', async () => {
    await expect(
      run(['models', 'uninstall', 'definitely-not-installed-xyz.gguf', '--runtime', 'gguf', '--dry-run', '--json']),
    ).rejects.toBeTruthy();
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

describe('vg models mode --apply-recommend', () => {
  it('pins recommended mode when no default is set', async () => {
    // Ensure auto-fit first so apply-recommend can pin.
    await run(['models', 'mode', '--auto', '--json']);
    const res = (await run(['models', 'mode', '--apply-recommend', '--json'])) as {
      applied: boolean;
      mode: string;
    };
    expect(res.applied).toBe(true);
    expect(['spark', 'flow', 'forge']).toContain(res.mode);
    // Second call should no-op.
    const again = (await run(['models', 'mode', '--apply-recommend', '--json'])) as { applied: boolean };
    expect(again.applied).toBe(false);
  });
});

describe('vg models host-bench', () => {
  it('dry-run lists arms without executing', async () => {
    const res = (await run(['models', 'host-bench', '--dry-run', '--json'])) as {
      dryRun: boolean;
      mode: string;
      arms: { id: string }[];
    };
    expect(res.dryRun).toBe(true);
    expect(res.mode).toBe('simulate');
    expect(res.arms.length).toBeGreaterThanOrEqual(5);
  });

  it('mock + gate returns ok gates', async () => {
    const res = (await run(['models', 'host-bench', '--mock', '--gate', '--json'])) as {
      mode: string;
      report: { arms: unknown[] };
      gates: { ok: boolean; hardFailed: number };
    };
    expect(res.mode).toBe('mock');
    expect(res.report.arms.length).toBeGreaterThan(0);
    expect(res.gates.ok).toBe(true);
    expect(res.gates.hardFailed).toBe(0);
  });
});

describe('vg models coding-metrics', () => {
  it('mock + skip-fusion returns coding-metrics/0 JSON', async () => {
    const res = (await run([
      'models',
      'coding-metrics',
      '--mock',
      '--skip-fusion',
      '--gate',
      '--json',
      '--version',
      '0.0.0-test',
    ])) as {
      schemaVersion: string;
      component: string;
      cliVersion: string;
      hostGates: { ok: boolean };
      headline: { hostGatesOk: number };
    };
    expect(res.schemaVersion).toBe('coding-metrics/0');
    expect(res.component).toBe('cli-coding');
    expect(res.cliVersion).toBe('0.0.0-test');
    expect(res.hostGates.ok).toBe(true);
    expect(res.headline.hostGatesOk).toBe(1);
  });
});
