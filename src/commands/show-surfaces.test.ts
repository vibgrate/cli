import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerShowSurfaces } from './show-surfaces.js';
import type { ExternalSurface } from '../core-open/index.js';

/**
 * `vg show surfaces` reads the stored artifact and prints it. The cases that
 * matter are the honest-reporting ones: `unknown` is not "behind", an absent
 * inventory is not an empty one, and nothing here re-derives a verdict the
 * scan already recorded.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function surface(overrides: Record<string, unknown> = {}): ExternalSurface {
  const { provider, freshness, ...rest } = overrides as Record<string, Record<string, unknown>>;
  return {
    id: 'sid',
    kind: 'saas',
    provider: { id: 'stripe', displayName: 'Stripe', iconId: 'Stripe', category: 'payment', ...provider },
    detectedId: 'stripe',
    displayName: 'Stripe',
    version: null,
    freshness: { status: 'unknown', detected: null, latest: null, alternatives: [], catalogSource: 'module', ...freshness },
    confidence: 'high',
    evidence: [],
    callSites: 0,
    projects: [],
    ...rest,
  } as ExternalSurface;
}

/** Write an artifact and run the command against it, capturing stderr output. */
async function run(args: string[], inventory?: unknown): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-show-surfaces-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.vibgrate', 'scan_result.json'),
    JSON.stringify({ extended: inventory === undefined ? {} : { surfaceInventory: inventory } }),
  );

  return capture(() => parse(['surfaces', '--cwd', root, ...args]));
}

/** `info` writes to stderr and `json` to stdout (GUARDRAILS §3.3) — take both. */
async function capture(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const sink = (s: string | Uint8Array): boolean => {
    chunks.push(String(s));
    return true;
  };
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(sink);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(sink);
  try {
    await run();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return chunks.join('');
}

async function parse(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const show = program.command('show');
  show.exitOverride();
  registerShowSurfaces(show);
  await program.parseAsync(['show', ...args], { from: 'user' });
}

function inventory(surfaces: ExternalSurface[], catalog: Record<string, unknown> = {}): unknown {
  return {
    schema: 'vg-surfaces/1.0',
    generatedAt: '2026-09-11T00:00:00.000Z',
    catalog: { source: 'module', generatedAt: '2026-09-11', stale: false, ...catalog },
    counts: { providers: surfaces.length, apis: 0, models: 0, mcpServers: 0, saas: 0, behind: 0, deprecated: 0, retired: 0, unknown: 0 },
    surfaces,
    unknownHosts: [],
  };
}

describe('vg show surfaces', () => {
  it('groups surfaces under the category the scan assigned', async () => {
    const out = await run(
      [],
      inventory([
        surface({ kind: 'model', detectedId: 'gpt-4o-mini', provider: { id: 'openai', displayName: 'OpenAI', category: 'ai' } }),
        surface(),
      ]),
    );
    expect(out).toContain('AI & inference');
    expect(out).toContain('Payments');
    expect(out).toContain('gpt-4o-mini');
    expect(out).toContain('Stripe');
  });

  it('always discloses which catalog the freshness was measured against', async () => {
    expect(await run([], inventory([surface()]))).toContain('vendor catalog 2026-09-11');
    expect(await run([], inventory([surface()], { stale: true }))).toContain('freshness may lag');
    expect(await run([], inventory([surface()], { generatedAt: undefined }))).toContain('no vendor catalog was available');
  });

  it('prints "unverified", never "current", for a surface the catalog does not cover', async () => {
    const out = await run([], inventory([surface({ kind: 'model', detectedId: 'gpt-4o', freshness: { status: 'unknown' } })]));
    expect(out).toContain('unverified');
    expect(out).not.toContain('current');
  });

  it('prints no freshness word at all for a SaaS package', async () => {
    // A SaaS row carries no vendor verdict. Printing "unverified" on every one
    // of them would drown the models and APIs where the word means something.
    const out = await run([], inventory([surface({ freshness: { status: 'unknown' } })]));
    expect(out).toContain('Stripe');
    expect(out).not.toContain('unverified');
  });

  it('--behind lists only what the vendor said is not current', async () => {
    const inv = inventory([
      surface({ freshness: { status: 'unknown' } }),
      surface({ provider: { id: 'paypal', displayName: 'PayPal' }, freshness: { status: 'current' } }),
      surface({
        kind: 'model',
        detectedId: 'text-davinci-003',
        provider: { id: 'openai', displayName: 'OpenAI', category: 'ai' },
        freshness: { status: 'retired', latest: 'gpt-4o-mini' },
      }),
    ]);
    const out = await run(['--behind'], inv);
    expect(out).toContain('text-davinci-003');
    expect(out).toContain('latest gpt-4o-mini');
    // An uncovered surface is not a finding — absence of data is not drift.
    expect(out).not.toContain('Stripe');
    expect(out).not.toContain('PayPal');
  });

  it('--kind filters to one kind and rejects an unknown one actionably', async () => {
    const inv = inventory([
      surface(),
      surface({ kind: 'mcp', detectedId: '@modelcontextprotocol/server-github', provider: { id: 'github', displayName: 'GitHub', category: 'mcp' } }),
    ]);
    expect(await run(['--kind', 'mcp'], inv)).toContain('@modelcontextprotocol/server-github');
    await expect(run(['--kind', 'telepathy'], inv)).rejects.toThrow(/unknown --kind "telepathy" — use one of: api, model, mcp, saas/);
  });

  it('says so when a filter matches nothing, rather than claiming none were found', async () => {
    const out = await run(['--behind'], inventory([surface()]));
    expect(out).toContain('No surfaces match that filter.');
    expect(out).not.toContain('Detection is static');
  });

  it('reports an empty inventory as "looked and found none"', async () => {
    const out = await run([], inventory([]));
    expect(out).toContain('No external APIs, models, or MCP servers detected');
    expect(out).toContain('Detection is static');
  });

  it('distinguishes an absent inventory from an empty one', async () => {
    await expect(run([], undefined)).rejects.toThrow(/did not inventory external surfaces/);
  });

  it('fails actionably when there is no scan at all', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-show-surfaces-empty-'));
    dirs.push(root);
    await expect(parse(['surfaces', '--cwd', root])).rejects.toThrow(/no scan found at .* — run `vg scan` first/);
  });

  it('--json emits the inventory with the filter applied', async () => {
    const out = await run(
      ['--json', '--kind', 'model'],
      inventory([
        surface(),
        surface({ kind: 'model', detectedId: 'gpt-4o-mini', provider: { id: 'openai', displayName: 'OpenAI', category: 'ai' } }),
      ]),
    );
    const parsed = JSON.parse(out) as { schema: string; surfaces: ExternalSurface[] };
    expect(parsed.schema).toBe('vg-surfaces/1.0');
    expect(parsed.surfaces).toHaveLength(1);
    expect(parsed.surfaces[0].detectedId).toBe('gpt-4o-mini');
  });
});
