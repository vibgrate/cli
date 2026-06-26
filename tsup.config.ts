import { defineConfig } from 'tsup';

// The public Vibgrate CLI (`vg` / `vibgrate`) is Apache-2.0. Unlike the
// proprietary internal CLI we do NOT minify or obfuscate — this code is meant
// to be read. The open base engine (`@vibgrate/core-open`) is bundled so a
// global `npm i -g @vibgrate/cli` works outside the monorepo.
export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    'parse-worker': 'src/engine/parse-worker.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  // Keep these external so they load from node_modules at runtime:
  //  - web-tree-sitter / tree-sitter-wasms ship their own .wasm assets.
  //  - typescript uses CommonJS require() internally; bundling breaks the resolver.
  //  - fastembed / onnxruntime-node carry native binaries (lazy, optional).
  external: ['web-tree-sitter', 'tree-sitter-wasms', 'typescript', 'fastembed', 'onnxruntime-node'],
  // Bundle the open base engine so the published artifact is self-contained.
  noExternal: ['@vibgrate/core-open'],
  minify: false,
  treeshake: true,
  sourcemap: true,
});
