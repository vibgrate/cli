import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  findFiles,
  findPackageJsonFiles,
  findCsprojFiles,
  findSolutionFiles,
  readJsonFile,
  readTextFile,
  stripBom,
  pathExists,
  ensureDir,
  writeJsonFile,
  writeTextFile,
  FileCache,
  normalizeGlobForRipgrep,
} from '../utils/fs.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-fs-test-'));
}

describe('fs utils', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('pathExists', () => {
    it('returns true for existing directory', async () => {
      expect(await pathExists(tempDir)).toBe(true);
    });

    it('returns true for existing file', async () => {
      const filePath = path.join(tempDir, 'file.txt');
      await fs.writeFile(filePath, 'hello');
      expect(await pathExists(filePath)).toBe(true);
    });

    it('returns false for non-existent path', async () => {
      expect(await pathExists(path.join(tempDir, 'nope'))).toBe(false);
    });
  });

  describe('ensureDir', () => {
    it('creates a directory', async () => {
      const dir = path.join(tempDir, 'new', 'deep', 'dir');
      await ensureDir(dir);
      expect(await pathExists(dir)).toBe(true);
    });

    it('is idempotent', async () => {
      const dir = path.join(tempDir, 'existing');
      await ensureDir(dir);
      await ensureDir(dir); // should not throw
      expect(await pathExists(dir)).toBe(true);
    });
  });

  describe('readJsonFile / writeJsonFile', () => {
    it('round-trips JSON data', async () => {
      const filePath = path.join(tempDir, 'data.json');
      const data = { name: 'test', count: 42, nested: { ok: true } };
      await writeJsonFile(filePath, data);
      const read = await readJsonFile<typeof data>(filePath);
      expect(read).toEqual(data);
    });

    it('creates parent directories', async () => {
      const filePath = path.join(tempDir, 'a', 'b', 'data.json');
      await writeJsonFile(filePath, { ok: true });
      const read = await readJsonFile<{ ok: boolean }>(filePath);
      expect(read.ok).toBe(true);
    });
  });

  describe('readTextFile / writeTextFile', () => {
    it('round-trips text data', async () => {
      const filePath = path.join(tempDir, 'text.txt');
      await writeTextFile(filePath, 'hello world');
      const read = await readTextFile(filePath);
      expect(read).toBe('hello world');
    });

    it('creates parent directories', async () => {
      const filePath = path.join(tempDir, 'x', 'y', 'text.txt');
      await writeTextFile(filePath, 'deep');
      const read = await readTextFile(filePath);
      expect(read).toBe('deep');
    });
  });

  describe('findFiles', () => {
    it('finds files matching predicate', async () => {
      await fs.writeFile(path.join(tempDir, 'a.txt'), '');
      await fs.writeFile(path.join(tempDir, 'b.json'), '');
      await fs.writeFile(path.join(tempDir, 'c.txt'), '');

      const result = await findFiles(tempDir, (name) => name.endsWith('.txt'));
      expect(result).toHaveLength(2);
      expect(result.map((r) => path.basename(r)).sort()).toEqual(['a.txt', 'c.txt']);
    });

    it('recurses into subdirectories', async () => {
      const sub = path.join(tempDir, 'sub');
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'deep.txt'), '');

      const result = await findFiles(tempDir, (name) => name.endsWith('.txt'));
      expect(result).toHaveLength(1);
      expect(path.basename(result[0]!)).toBe('deep.txt');
    });

    it('skips node_modules', async () => {
      const nm = path.join(tempDir, 'node_modules');
      await fs.mkdir(nm);
      await fs.writeFile(path.join(nm, 'package.json'), '{}');

      const result = await findFiles(tempDir, (name) => name === 'package.json');
      expect(result).toHaveLength(0);
    });

    it('skips .git directory', async () => {
      const git = path.join(tempDir, '.git');
      await fs.mkdir(git);
      await fs.writeFile(path.join(git, 'config'), '');

      const result = await findFiles(tempDir, (name) => name === 'config');
      expect(result).toHaveLength(0);
    });

    it('skips dist directory', async () => {
      const dist = path.join(tempDir, 'dist');
      await fs.mkdir(dist);
      await fs.writeFile(path.join(dist, 'index.js'), '');

      const result = await findFiles(tempDir, (name) => name === 'index.js');
      expect(result).toHaveLength(0);
    });

    it('returns empty for non-existent directory', async () => {
      const result = await findFiles(path.join(tempDir, 'nope'), () => true);
      expect(result).toEqual([]);
    });
  });

  describe('findPackageJsonFiles', () => {
    it('finds package.json files', async () => {
      await fs.writeFile(path.join(tempDir, 'package.json'), '{}');
      const sub = path.join(tempDir, 'sub');
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'package.json'), '{}');

      const result = await findPackageJsonFiles(tempDir);
      expect(result).toHaveLength(2);
    });
  });

  describe('findCsprojFiles', () => {
    it('finds .csproj files', async () => {
      await fs.writeFile(path.join(tempDir, 'App.csproj'), '<Project />');
      const result = await findCsprojFiles(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('App.csproj');
    });
  });

  describe('findSolutionFiles', () => {
    it('finds .sln files', async () => {
      await fs.writeFile(path.join(tempDir, 'My.sln'), '');
      const result = await findSolutionFiles(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('My.sln');
    });
  });

  describe('FileCache maxFileSizeToScan', () => {
    it('reads files within size limit normally', async () => {
      const cache = new FileCache();
      cache.setMaxFileSize(1000);
      const filePath = path.join(tempDir, 'small.txt');
      await fs.writeFile(filePath, 'hello');
      await cache.walkDir(tempDir);

      const content = await cache.readTextFile(filePath);
      expect(content).toBe('hello');
      expect(cache.skippedLargeFiles).toHaveLength(0);
    });

    it('skips files exceeding size limit and records them', async () => {
      const cache = new FileCache();
      cache.setMaxFileSize(10); // 10 bytes
      const filePath = path.join(tempDir, 'big.txt');
      await fs.writeFile(filePath, 'a'.repeat(100)); // 100 bytes > 10
      await cache.walkDir(tempDir);

      const content = await cache.readTextFile(filePath);
      expect(content).toBe('');
      expect(cache.skippedLargeFiles.length).toBeGreaterThan(0);
      expect(cache.skippedLargeFiles.some((f) => f.includes('big.txt'))).toBe(true);
    });

    it('reads files when no size limit is set', async () => {
      const cache = new FileCache();
      // No setMaxFileSize call — default is 0 (unlimited)
      const filePath = path.join(tempDir, 'any.txt');
      await fs.writeFile(filePath, 'a'.repeat(1000));
      await cache.walkDir(tempDir);

      const content = await cache.readTextFile(filePath);
      expect(content).toBe('a'.repeat(1000));
      expect(cache.skippedLargeFiles).toHaveLength(0);
    });
  });

  describe('FileCache addStuckPath', () => {
    it('records and exposes stuck paths', () => {
      const cache = new FileCache();
      cache.addStuckPath('some/dir');
      cache.addStuckPath('another/path');
      expect(cache.stuckPaths).toEqual(['some/dir', 'another/path']);
    });

    it('stuckDirs is an alias for stuckPaths', () => {
      const cache = new FileCache();
      cache.addStuckPath('test/path');
      expect(cache.stuckDirs).toEqual(['test/path']);
    });
  });

  describe('FileCache exclude patterns', () => {
    it('excludes files matching patterns during walk', async () => {
      const cache = new FileCache();
      cache.setExcludePatterns(['secret']);

      const secretDir = path.join(tempDir, 'secret');
      await fs.mkdir(secretDir);
      await fs.writeFile(path.join(secretDir, 'data.txt'), 'hidden');
      await fs.writeFile(path.join(tempDir, 'visible.txt'), 'shown');

      const entries = await cache.walkDir(tempDir);
      const names = entries.filter((e) => e.isFile).map((e) => e.name);
      expect(names).toContain('visible.txt');
      expect(names).not.toContain('data.txt');
    });
  });
});


describe('normalizeGlobForRipgrep', () => {
  it('normalizes windows separators to forward slashes', () => {
    expect(normalizeGlobForRipgrep('apps\\api\\**\\*.ts')).toBe('apps/api/**/*.ts');
  });

  it('leaves POSIX-style globs unchanged', () => {
    expect(normalizeGlobForRipgrep('apps/api/**/*.ts')).toBe('apps/api/**/*.ts');
  });
});

describe('stripBom', () => {
  it('removes a UTF-8 BOM so BOM-saved manifests still parse', () => {
    expect(stripBom('\uFEFF{"name":"app"}')).toBe('{"name":"app"}');
    expect(stripBom('{"name":"app"}')).toBe('{"name":"app"}');
    expect(stripBom('')).toBe('');
  });
});

describe('vendored dependency trees', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('readJsonFile parses a BOM-prefixed package.json', async () => {
    const p = path.join(tempDir, 'package.json');
    await fs.writeFile(p, '\uFEFF{"name":"bom-app","version":"1.0.0"}');
    const parsed = await readJsonFile<{ name: string }>(p);
    expect(parsed.name).toBe('bom-app');
  });

  it('walkDir skips vendor/ so vendored manifests are not detected as projects', async () => {
    await fs.mkdir(path.join(tempDir, 'vendor', 'github.com', 'x', 'strutil'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'vendor', 'github.com', 'x', 'strutil', 'go.mod'), 'module strutil\ngo 1.21\n');
    await fs.writeFile(path.join(tempDir, 'go.mod'), 'module app\ngo 1.25\n');

    const cache = new FileCache();
    const entries = await cache.walkDir(tempDir);
    const goMods = entries.filter((e) => e.name === 'go.mod');
    expect(goMods).toHaveLength(1);
    expect(goMods[0].relPath).toBe('go.mod');
  });
});
