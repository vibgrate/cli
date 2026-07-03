import { configDefaults, defineConfig } from 'vitest/config';

// Suites that build graphs across EVERY supported language, compiling all ~20
// tree-sitter grammar WASMs in-process (`inline: true`). Two of these landing
// in concurrent forks — on top of the ordinary test forks — can exhaust a CI
// runner's memory: V8 aborts with "Fatal process out of memory: Zone" mid
// WASM compilation and the worker dies without reporting. Run them in their
// own pool capped at one fork, so at most one full-grammar-set process exists
// at any time. Isolation (a fresh fork per file) is preserved.
const GRAMMAR_HEAVY = ['test/adversarial-fixtures.test.ts', 'test/new-languages.test.ts'];

export default defineConfig({
  test: {
    // Parsing real grammars + worker pools can exceed the 5s default.
    testTimeout: 30000,
    hookTimeout: 30000,
    // No embedding model is ever downloaded during tests: semantic paths use the
    // injected stub embedder, and the one test that calls the real loader points
    // its cache at an uncreatable dir so it fails fast (offline) without fetching.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...GRAMMAR_HEAVY],
        },
      },
      {
        extends: true,
        test: {
          name: 'grammar-heavy',
          include: GRAMMAR_HEAVY,
          maxWorkers: 1,
        },
      },
    ],
  },
});
