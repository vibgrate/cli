import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDefaultDeps } from './fallbacks.js';

/**
 * The optional layers are bound with dynamic imports so a missing module
 * degrades to passthrough instead of crashing. That only works in the
 * published bundle when every `import()` carries a *literal* specifier — a
 * runtime string (`import(spec)`, `/* @vite-ignore *\/`) is invisible to the
 * bundler, ships no chunk, and turns the whole shipped listener into a silent
 * passthrough (0% saved) while the same code from source compresses.
 */
describe('loadDefaultDeps stays bundle-safe', () => {
  it.each(['./fallbacks.ts', '../compress/pipeline.ts'])('%s uses only literal import specifiers (no runtime-string dynamic imports)', (file) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const dynamicImports = [...source.matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(dynamicImports.length).toBeGreaterThan(0);
    for (const spec of dynamicImports) {
      expect(spec, `${file}: dynamic import must be a literal path: import(${spec})`).toMatch(/^'[^']+'$/);
    }
    expect(source).not.toMatch(/@vite-ignore/);
  });

  it('binds every compression layer from source', async () => {
    const { bound, missing } = await loadDefaultDeps({ env: process.env });
    expect(missing).toEqual([]);
    expect(bound).toEqual(expect.arrayContaining(['pipeline', 'ccr-store', 'ccr-handler', 'ccr-markers', 'ccr-streaming', 'ledger', 'tokenizers', 'pricing', 'router']));
  });
});
