import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Parsing real grammars + worker pools can exceed the 5s default.
    testTimeout: 30000,
    hookTimeout: 30000,
    // No embedding model is ever downloaded during tests: semantic paths use the
    // injected stub embedder, and the one test that calls the real loader points
    // its cache at an uncreatable dir so it fails fast (offline) without fetching.
  },
});
