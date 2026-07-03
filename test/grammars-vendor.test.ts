import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { resolvedGrammarFiles } from '../src/engine/grammars.js';

/**
 * The tree-sitter-wasms prebuilt of tree-sitter-swift crashes V8 on
 * Node.js >= 24 ("Fatal process out of memory: Zone" while compiling the
 * module). A rebuilt grammar is vendored in vendor/ and must always win the
 * resolution — whether served from the vendor overlay directly (dev) or via
 * the bundled grammars/ copy (after `pnpm build`). See vendor/README.md.
 */
describe('vendored grammar overrides', () => {
  it('resolves Swift to the vendored build, never the defective prebuilt', () => {
    const swift = resolvedGrammarFiles().find((g) => g.fileName === 'tree-sitter-swift.wasm');
    expect(swift).toBeDefined();
    const vendored = fs.readFileSync(new URL('../vendor/tree-sitter-swift.wasm', import.meta.url));
    expect(fs.readFileSync(swift!.absPath).equals(vendored)).toBe(true);
  });

  it('resolves a grammar file for every registered language', () => {
    const files = resolvedGrammarFiles();
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const f of files) expect(fs.existsSync(f.absPath)).toBe(true);
  });
});
