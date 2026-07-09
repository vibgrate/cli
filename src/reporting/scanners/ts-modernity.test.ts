import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanTsModernity } from './ts-modernity.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-tsmod-test-'));
}

describe('scanTsModernity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns nulls for empty directory', async () => {
    const result = await scanTsModernity(tempDir);
    expect(result.typescriptVersion).toBeNull();
    expect(result.strict).toBeNull();
    expect(result.module).toBeNull();
    expect(result.target).toBeNull();
    expect(result.moduleType).toBeNull();
    expect(result.exportsField).toBe(false);
  });

  it('extracts TypeScript version from devDependencies', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        devDependencies: { typescript: '^5.4.5' },
      }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.typescriptVersion).toBe('5.4.5');
  });

  it('extracts TypeScript version from dependencies', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        dependencies: { typescript: '~4.9.0' },
      }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.typescriptVersion).toBe('4.9.0');
  });

  it('strips range prefixes from TS version', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        devDependencies: { typescript: '>=5.0.0' },
      }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.typescriptVersion).toBe('5.0.0');
  });

  // ── tsconfig parsing ──

  it('reads strict flag from tsconfig', async () => {
    await fs.writeFile(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.strict).toBe(true);
  });

  it('reads multiple compiler options', async () => {
    await fs.writeFile(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noImplicitAny: true,
          strictNullChecks: false,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
        },
      }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.strict).toBe(true);
    expect(result.noImplicitAny).toBe(true);
    expect(result.strictNullChecks).toBe(false);
    expect(result.module).toBe('NodeNext');
    expect(result.moduleResolution).toBe('NodeNext');
    expect(result.target).toBe('ES2022');
  });

  it('handles tsconfig with comments', async () => {
    const tsconfigWithComments = `{
      // This is a comment
      "compilerOptions": {
        "strict": true, // inline comment
        /* block comment */
        "target": "ES2020"
      }
    }`;
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), tsconfigWithComments);
    const result = await scanTsModernity(tempDir);
    expect(result.strict).toBe(true);
    expect(result.target).toBe('ES2020');
  });

  it('handles tsconfig with trailing commas', async () => {
    const tsconfig = `{
      "compilerOptions": {
        "strict": true,
        "target": "ES2021",
      },
    }`;
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), tsconfig);
    const result = await scanTsModernity(tempDir);
    expect(result.strict).toBe(true);
    expect(result.target).toBe('ES2021');
  });

  it('handles malformed tsconfig gracefully', async () => {
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{ not valid json');
    const result = await scanTsModernity(tempDir);
    expect(result.strict).toBeNull();
  });

  // ── Module type detection ──

  it('detects ESM when package.json has type: module', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', type: 'module' }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.moduleType).toBe('esm');
  });

  it('detects CJS when package.json has type: commonjs', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', type: 'commonjs' }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.moduleType).toBe('cjs');
  });

  it('defaults to CJS when type field is omitted', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test' }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.moduleType).toBe('cjs');
  });

  it('detects mixed module types across packages', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', type: 'module' }),
    );
    const subDir = path.join(tempDir, 'sub');
    await fs.mkdir(subDir);
    await fs.writeFile(
      path.join(subDir, 'package.json'),
      JSON.stringify({ name: 'sub', type: 'commonjs' }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.moduleType).toBe('mixed');
  });

  // ── Exports field ──

  it('detects exports field presence', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        exports: { '.': './dist/index.js' },
      }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.exportsField).toBe(true);
  });

  it('exports field is false when not present', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', main: './index.js' }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.exportsField).toBe(false);
  });

  // ── Combined behavior ──

  it('reads both package.json and tsconfig in one scan', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'combined',
        type: 'module',
        devDependencies: { typescript: '^5.3.0' },
        exports: { '.': './dist/index.js' },
      }),
    );
    await fs.writeFile(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'NodeNext',
          target: 'ES2022',
        },
      }),
    );
    const result = await scanTsModernity(tempDir);
    expect(result.typescriptVersion).toBe('5.3.0');
    expect(result.moduleType).toBe('esm');
    expect(result.exportsField).toBe(true);
    expect(result.strict).toBe(true);
    expect(result.module).toBe('NodeNext');
    expect(result.target).toBe('ES2022');
  });
});
