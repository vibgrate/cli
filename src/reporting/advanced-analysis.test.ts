import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { runCoreScan } from '../core-open/index.js';
import { loadAdvancedScanHook } from './advanced-hook.js';

/**
 * The public advanced-analysis hook must populate the structured `extended`
 * block (tech stack, services, build/deploy, security posture, dependency
 * graph/risk, TS modernity, file hotspots, breaking change, architecture, code
 * quality) — but must NEVER emit the former raw-line `requirements-scanners`
 * family. Those regex-scraped whole source lines (auth hints, tokens,
 * connection strings, license text) into the artifact, a data-quality and
 * secret-exposure risk that this port deliberately drops.
 */
const FORBIDDEN_EXTENDED_FIELDS = [
  'runtimeConfiguration',
  'dataStores',
  'apiSurface',
  'operationalResilience',
  'ossGovernance',
  'assetBranding',
] as const;

async function scanFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vg-adv-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: {
        react: '^18.2.0',
        next: '^14.0.0',
        stripe: '^14.0.0',
        pg: '^8.11.0',
        ioredis: '^5.3.0',
      },
      devDependencies: { typescript: '^5.4.0', vite: '^5.0.0', jest: '^29.0.0' },
    }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages: {} }), 'utf8');
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n.env\n', 'utf8');
  const advanced = await loadAdvancedScanHook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artifact = await runCoreScan(dir, { path: dir } as any, advanced);
  await fs.rm(dir, { recursive: true, force: true });
  return artifact;
}

describe('public advanced-analysis hook', () => {
  it('populates the structured extended block', async () => {
    const artifact = await scanFixture();
    const ext = artifact.extended ?? {};
    expect(Object.keys(ext).length).toBeGreaterThan(0);
    // Tech Stack: React + Next detected from package.json deps.
    expect(ext.toolingInventory).toBeDefined();
    const frontendNames = (ext.toolingInventory?.frontend ?? []).map((t) => t.name);
    expect(frontendNames).toContain('React');
    // Services & Integrations: Stripe (payment) + Postgres/Redis (databases).
    expect(ext.serviceDependencies).toBeDefined();
    const paymentNames = (ext.serviceDependencies?.payment ?? []).map((s) => s.name);
    expect(paymentNames).toContain('Stripe');
    // Security posture is computed from the lockfile + .gitignore.
    expect(ext.securityPosture).toBeDefined();
  }, 30_000);

  it('never emits the dropped raw-line requirements-scanner fields', async () => {
    const artifact = await scanFixture();
    const ext = artifact.extended ?? {};
    for (const field of FORBIDDEN_EXTENDED_FIELDS) {
      expect(ext, `extended must not contain "${field}"`).not.toHaveProperty(field);
    }
  }, 30_000);
});
