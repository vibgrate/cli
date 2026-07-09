import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanCodeQuality } from './code-quality.js';

describe('scanCodeQuality', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-code-quality-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('computes function-level quality metrics', async () => {
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'src', 'a.ts'),
      `
      export function used(x: number) {
        if (x > 0 && x < 10) {
          return x;
        }
        return 0;
      }

      function deadThing() {
        return 'never called';
      }
      `,
    );

    const result = await scanCodeQuality(tempDir);

    expect(result.filesAnalyzed).toBe(1);
    expect(result.functionsAnalyzed).toBeGreaterThanOrEqual(2);
    expect(result.avgCyclomaticComplexity).toBeGreaterThan(1);
    expect(result.deadCodePercent).toBeGreaterThan(0);
  });

  it('detects circular dependencies across local imports', async () => {
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'a.ts'), "import './b'; export const a = 1;");
    await fs.writeFile(path.join(tempDir, 'src', 'b.ts'), "import './a'; export const b = 2;");

    const result = await scanCodeQuality(tempDir);

    expect(result.circularDependencies).toBeGreaterThan(0);
  });
});
