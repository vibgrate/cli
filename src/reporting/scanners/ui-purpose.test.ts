import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { FileCache } from '../../core-open/index.js';
import { scanUiPurpose } from './ui-purpose.js';

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-uipurpose-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('scanUiPurpose', () => {
  it('extracts route and CTA evidence from next-style app pages', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
        dependencies: { next: '14.0.0', react: '18.0.0', stripe: '15.0.0' },
      }, null, 2));
      await fs.mkdir(path.join(dir, 'app', 'reports'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'app', 'reports', 'page.tsx'),
        '<title>Security Dashboard</title><h1>Reports</h1><button>Generate report</button>',
      );

      const result = await scanUiPurpose(dir, new FileCache(), 50);
      expect(result.detectedFrameworks).toContain('nextjs');
      expect(result.topEvidence.some((e) => e.kind === 'route' && e.value === '/reports')).toBe(true);
      expect(result.topEvidence.some((e) => /generate report/i.test(e.value))).toBe(true);
      expect(result.topEvidence.some((e) => e.kind === 'dependency' && /stripe@15/.test(e.value))).toBe(true);
    });
  });

  it('caps evidence size and reports unknown signals when missing', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '18.0.0' } }));
      await fs.mkdir(path.join(dir, 'src', 'components'), { recursive: true });
      const blocks = Array.from({ length: 80 }, (_, i) => `<div>Alpha signal ${i}</div>`).join('\n');
      await fs.writeFile(path.join(dir, 'src', 'components', 'A.tsx'), blocks);

      const result = await scanUiPurpose(dir, new FileCache(), 20);
      expect(result.topEvidence.length).toBe(20);
      expect(result.capped).toBe(true);
      expect(result.unknownSignals.length).toBeGreaterThan(0);
    });
  });
});
