import { defineConfig } from 'tsup';

// The public Vibgrate CLI (`vg` / `vibgrate`) is Apache-2.0. Unlike the
// proprietary internal CLI we do NOT minify or obfuscate — this code is meant
// to be read. The open base engine lives at src/core-open/ (vendored from
// @vibgrate/core-open by scripts/vendor-core-open.mjs), so it compiles as part
// of the CLI with no external @vibgrate dependency.
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
  //  - yaml's CJS modules call require("process"); bundling into ESM turns that
  //    into a dynamic-require shim that throws at runtime.
  external: ['web-tree-sitter', 'tree-sitter-wasms', 'typescript', 'fastembed', 'onnxruntime-node', 'yaml'],
  minify: false,
  treeshake: true,
  sourcemap: true,
});
