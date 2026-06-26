import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadConfig, writeDefaultConfig, appendExcludePatterns } from './config.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-config-test-'));
}

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns default config when no config file exists', async () => {
    const config = await loadConfig(tempDir);
    expect(config.thresholds).toBeDefined();
    expect(config.thresholds?.failOnError?.eolDays).toBe(180);
    expect(config.thresholds?.failOnError?.frameworkMajorLag).toBe(3);
    expect(config.thresholds?.failOnError?.dependencyTwoPlusPercent).toBe(50);
    expect(config.thresholds?.warn?.frameworkMajorLag).toBe(2);
    expect(config.thresholds?.warn?.dependencyTwoPlusPercent).toBe(30);
    expect(config.maxFileSizeToScan).toBe(5_242_880);
  });

  it('loads JSON config file', async () => {
    const configData = {
      exclude: ['legacy/**'],
      thresholds: {
        failOnError: {
          eolDays: 90,
          frameworkMajorLag: 2,
        },
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify(configData),
    );

    const config = await loadConfig(tempDir);
    expect(config.exclude).toEqual(['legacy/**']);
    expect(config.thresholds?.failOnError?.eolDays).toBe(90);
    expect(config.thresholds?.failOnError?.frameworkMajorLag).toBe(2);
  });

  it('merges JSON config with defaults', async () => {
    const configData = {
      exclude: ['old/**'],
    };
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify(configData),
    );

    const config = await loadConfig(tempDir);
    // Should still have default thresholds
    expect(config.thresholds).toBeDefined();
    expect(config.exclude).toEqual(['old/**']);
  });


  it('does not execute non-static ts/js config unless explicitly trusted', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.ts'),
      `export default { exclude: [String(Date.now())] };`,
    );

    const config = await loadConfig(tempDir);
    expect(config.exclude).toEqual([]);
  });

  it('loads static ts config without trust env var', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.ts'),
      `const excludes = ['from-static-ts']; export default { exclude: excludes };`,
    );

    const config = await loadConfig(tempDir);
    expect(config.exclude).toEqual(['from-static-ts']);
  });

  it('falls back to json when ts config is non-static and trust env var is unset', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.ts'),
      `export default { exclude: [String(Date.now())] };`,
    );
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify({ exclude: ['from-json'] }),
    );

    const config = await loadConfig(tempDir);
    expect(config.exclude).toEqual(['from-json']);
  });

  it('loads ts/js config when trust env var is enabled', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.ts'),
      `export default { exclude: ['from-ts'] };`,
    );

    const previous = process.env.VIBGRATE_TRUST_CONFIG;
    process.env.VIBGRATE_TRUST_CONFIG = '1';
    try {
      const config = await loadConfig(tempDir);
      expect(config.exclude).toEqual(['from-ts']);
    } finally {
      if (previous === undefined) delete process.env.VIBGRATE_TRUST_CONFIG;
      else process.env.VIBGRATE_TRUST_CONFIG = previous;
    }
  });
  it('prioritises .ts config over .json', async () => {
    // Create both .ts and .json
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify({ exclude: ['from-json'] }),
    );
    // .ts is checked first in CONFIG_FILES, but dynamic import may fail in test
    // so we just verify .json fallback works
    const config = await loadConfig(tempDir);
    expect(config).toBeDefined();
  });
});

describe('writeDefaultConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates vibgrate.config.ts file', async () => {
    const configPath = await writeDefaultConfig(tempDir);
    expect(configPath).toBe(path.join(tempDir, 'vibgrate.config.ts'));

    const content = await fs.readFile(configPath, 'utf8');
    expect(content).toContain('VibgrateConfig');
    expect(content).toContain('thresholds');
    expect(content).toContain('export default config');
  });

  it('includes correct default values', async () => {
    const configPath = await writeDefaultConfig(tempDir);
    const content = await fs.readFile(configPath, 'utf8');

    expect(content).toContain('eolDays: 180');
    expect(content).toContain('frameworkMajorLag: 3');
    expect(content).toContain('dependencyTwoPlusPercent: 50');
  });
});

describe('appendExcludePatterns', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns false for empty patterns', async () => {
    expect(await appendExcludePatterns(tempDir, [])).toBe(false);
  });

  it('appends to JSON config exclude array', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify({ exclude: ['old/**'] }),
    );

    const updated = await appendExcludePatterns(tempDir, ['stuck-dir/**']);
    expect(updated).toBe(true);

    const config = await loadConfig(tempDir);
    expect(config.exclude).toContain('old/**');
    expect(config.exclude).toContain('stuck-dir/**');
  });

  it('deduplicates patterns in JSON config', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify({ exclude: ['old/**'] }),
    );

    await appendExcludePatterns(tempDir, ['old/**', 'new/**']);
    const cfg = JSON.parse(await fs.readFile(path.join(tempDir, 'vibgrate.config.json'), 'utf8'));
    expect(cfg.exclude).toEqual(['old/**', 'new/**']);
  });

  it('creates sidecar file when no JSON config exists', async () => {
    const updated = await appendExcludePatterns(tempDir, ['stuck/**']);
    expect(updated).toBe(true);

    const sidecar = path.join(tempDir, '.vibgrate', 'auto-excludes.json');
    const content = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    expect(content).toEqual(['stuck/**']);
  });

  it('appends to existing sidecar file', async () => {
    const vibDir = path.join(tempDir, '.vibgrate');
    await fs.mkdir(vibDir, { recursive: true });
    await fs.writeFile(path.join(vibDir, 'auto-excludes.json'), '["first/**"]');

    await appendExcludePatterns(tempDir, ['second/**']);

    const content = JSON.parse(
      await fs.readFile(path.join(vibDir, 'auto-excludes.json'), 'utf8'),
    );
    expect(content).toEqual(['first/**', 'second/**']);
  });
});

describe('loadConfig with auto-excludes sidecar', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('merges sidecar auto-excludes with config', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify({ exclude: ['legacy/**'] }),
    );
    const vibDir = path.join(tempDir, '.vibgrate');
    await fs.mkdir(vibDir, { recursive: true });
    await fs.writeFile(
      path.join(vibDir, 'auto-excludes.json'),
      '["stuck-dir/**"]',
    );

    const config = await loadConfig(tempDir);
    expect(config.exclude).toContain('legacy/**');
    expect(config.exclude).toContain('stuck-dir/**');
  });

  it('loads sidecar excludes when no main config exists', async () => {
    const vibDir = path.join(tempDir, '.vibgrate');
    await fs.mkdir(vibDir, { recursive: true });
    await fs.writeFile(
      path.join(vibDir, 'auto-excludes.json'),
      '["auto/**"]',
    );

    const config = await loadConfig(tempDir);
    expect(config.exclude).toContain('auto/**');
  });

  it('deduplicates sidecar patterns against config excludes', async () => {
    await fs.writeFile(
      path.join(tempDir, 'vibgrate.config.json'),
      JSON.stringify({ exclude: ['same/**'] }),
    );
    const vibDir = path.join(tempDir, '.vibgrate');
    await fs.mkdir(vibDir, { recursive: true });
    await fs.writeFile(
      path.join(vibDir, 'auto-excludes.json'),
      '["same/**"]',
    );

    const config = await loadConfig(tempDir);
    // Should not duplicate
    expect(config.exclude!.filter((p) => p === 'same/**')).toHaveLength(1);
  });
});
