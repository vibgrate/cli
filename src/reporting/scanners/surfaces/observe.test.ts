import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCache } from '../../../core-open/index.js';
import { observeMcpServers, observeSource } from './observe.js';

/**
 * The observation pass must stay vendor-blind and privacy-safe. These cases
 * cover both halves, and deliberately lead with the negatives: what must NOT
 * be emitted is the part that turns into an incident if it regresses.
 */

/**
 * Credential-shaped values, assembled at runtime. A literal one must not live
 * in the repository even as a fixture (GUARDRAILS §6), but these tests have to
 * put one in a scanned file to prove it never reaches an observation.
 */
const FAKE_STRIPE_KEY = ['sk', 'live', 'a'.repeat(12)].join('_');
const FAKE_STRIPE_KEY_2 = ['sk', 'live', 'b'.repeat(12)].join('_');
const FAKE_OPENAI_KEY = ['sk', 'c'.repeat(12)].join('-');
const FAKE_SLACK_TOKEN = ['xoxb', 'd'.repeat(12)].join('-');

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Build a repo on disk and return its root plus a cache walked over it. */
async function repo(files: Record<string, string>): Promise<{ root: string; cache: FileCache }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-observe-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const cache = new FileCache();
  await cache.walkDir(root);
  return { root, cache };
}

describe('observeSource', () => {
  it('reduces a URL to its host, dropping path, query and any token in them', async () => {
    const { root, cache } = await repo({
      'src/pay.ts': `const url = "https://api.stripe.com/v1/charges?api_key=${FAKE_STRIPE_KEY}";`,
    });
    const out = await observeSource(root, cache, []);
    expect(out.hosts).toEqual([{ host: 'api.stripe.com', file: 'src/pay.ts', line: 1, project: '.' }]);
    expect(JSON.stringify(out)).not.toContain(FAKE_STRIPE_KEY);
    expect(JSON.stringify(out)).not.toContain('v1/charges');
  });

  it('ignores local, private and placeholder hosts', async () => {
    const { root, cache } = await repo({
      'src/dev.ts': [
        'const a = "http://localhost:3000/api";',
        'const b = "http://127.0.0.1:8080";',
        'const c = "https://queue.internal/jobs";',
        'const d = "https://printer.local";',
        'const e = "https://10.0.0.4:9000";',
        'const f = "https://api.example.com";',
      ].join('\n'),
    });
    expect((await observeSource(root, cache, [])).hosts).toEqual([]);
  });

  it('reads environment variable names, never values', async () => {
    const { root, cache } = await repo({
      '.env.example': 'OPENAI_API_KEY=\nSTRIPE_SECRET_KEY=put-yours-here\n',
      'src/app.ts': 'const k = process.env.ANTHROPIC_API_KEY;\nconst j = process.env["GROQ_API_KEY"];',
      'src/app.py': 'key = os.environ["PINECONE_API_KEY"]',
    });
    const out = await observeSource(root, cache, []);
    expect(out.envKeys.map((e) => e.key).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'GROQ_API_KEY',
      'OPENAI_API_KEY',
      'PINECONE_API_KEY',
      'STRIPE_SECRET_KEY',
    ]);
    expect(JSON.stringify(out.envKeys)).not.toContain('put-yours-here');
  });

  it('never reads a gitignored .env, where the values actually live', async () => {
    const { root, cache } = await repo({
      '.env': `STRIPE_SECRET_KEY=${FAKE_STRIPE_KEY_2}\n`,
      '.env.local': `OPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`,
    });
    const out = await observeSource(root, cache, []);
    expect(out.envKeys).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(FAKE_STRIPE_KEY_2);
    expect(JSON.stringify(out)).not.toContain(FAKE_OPENAI_KEY);
  });

  it('only offers a quoted string as a model id when it sits on a model key', async () => {
    const { root, cache } = await repo({
      'src/ai.ts': [
        'import OpenAI from "openai";',
        'const r = await client.chat.completions.create({ model: "gpt-4o-mini" });',
        'const label = "gpt-4o-mini-lookalike-string";',
        'fetch("https://example.org/gpt-4o-mini");',
      ].join('\n'),
    });
    const out = await observeSource(root, cache, []);
    expect(out.models.map((m) => m.id)).toEqual(['gpt-4o-mini']);
    expect(out.models[0]).toMatchObject({ line: 2, nearSdkImport: true });
  });

  it('marks a model id as unaccompanied when no inference SDK is imported', async () => {
    const { root, cache } = await repo({
      'train.py': 'from sklearn.ensemble import RandomForestClassifier\nconfig = { "model": "RandomForestClassifier" }',
    });
    const out = await observeSource(root, cache, []);
    // Observed, but flagged — the catalog is what decides it is not a vendor.
    expect(out.models).toEqual([
      { id: 'RandomForestClassifier', file: 'train.py', line: 2, project: '.', nearSdkImport: false },
    ]);
  });

  it('picks up pinned vendor API versions', async () => {
    const { root, cache } = await repo({
      'src/pay.ts': `const stripe = new Stripe(key, { "Stripe-Version": "2024-04-10" });`,
    });
    expect((await observeSource(root, cache, [])).apiVersions).toEqual([
      { field: 'Stripe-Version', value: '2024-04-10', file: 'src/pay.ts', line: 1, project: '.' },
    ]);
  });

  it('skips vendored and build output', async () => {
    const { root, cache } = await repo({
      'node_modules/openai/index.js': 'const u = "https://api.openai.com";',
      'dist/bundle.js': 'const u = "https://api.stripe.com";',
      'src/real.ts': 'const u = "https://api.anthropic.com";',
    });
    expect((await observeSource(root, cache, [])).hosts.map((h) => h.host)).toEqual(['api.anthropic.com']);
  });

  it('attributes a file to its deepest project', async () => {
    const { root, cache } = await repo({
      'apps/api/src/pay.ts': 'const u = "https://api.stripe.com";',
    });
    const out = await observeSource(root, cache, ['apps', 'apps/api']);
    expect(out.hosts[0].project).toBe('apps/api');
  });

  it('is deterministic across runs', async () => {
    const { root, cache } = await repo({
      'src/b.ts': 'const u = "https://api.stripe.com";',
      'src/a.ts': 'const u = "https://api.openai.com";',
    });
    const first = JSON.stringify(await observeSource(root, cache, []));
    const second = JSON.stringify(await observeSource(root, cache, []));
    expect(first).toBe(second);
    expect(JSON.parse(first).hosts.map((h: { file: string }) => h.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('observeMcpServers', () => {
  it('reads both community config shapes from repo-scoped files only', async () => {
    const { root, cache } = await repo({
      '.cursor/mcp.json': JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
      }),
      '.vscode/mcp.json': JSON.stringify({
        servers: { postgres: { command: 'uvx', args: ['mcp-server-postgres'] } },
      }),
    });
    const out = await observeMcpServers(root, cache);
    expect(out.map((s) => s.name)).toEqual(['github', 'postgres']);
    expect(out[0]).toMatchObject({ transport: 'stdio', command: 'npx', file: '.cursor/mcp.json' });
  });

  it('lets .vibgrate/code.json win a name collision', async () => {
    const { root, cache } = await repo({
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['theirs'] } } }),
      '.vibgrate/code.json': JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['ours'] } } }),
    });
    const out = await observeMcpServers(root, cache);
    expect(out).toHaveLength(1);
    expect(out[0].args).toEqual(['ours']);
  });

  it('keeps only the host of a remote server URL, never its query tokens', async () => {
    const { root, cache } = await repo({
      '.mcp.json': JSON.stringify({
        mcpServers: { remote: { url: `https://mcp.example.com/sse?access_token=${FAKE_SLACK_TOKEN}`, type: 'sse' } },
      }),
    });
    const out = await observeMcpServers(root, cache);
    expect(out[0]).toMatchObject({ urlHost: 'mcp.example.com', transport: 'sse' });
    expect(JSON.stringify(out)).not.toContain(FAKE_SLACK_TOKEN);
    expect(JSON.stringify(out)).not.toContain('access_token');
  });

  it('tolerates a malformed config instead of failing the scan', async () => {
    const { root, cache } = await repo({ '.mcp.json': '{ this is not json' });
    await expect(observeMcpServers(root, cache)).resolves.toEqual([]);
  });
});
