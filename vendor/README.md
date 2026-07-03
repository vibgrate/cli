# Vendored grammar builds

Grammar `.wasm` files here OVERRIDE the prebuilt ones from `tree-sitter-wasms`
(see `scripts/bundle-grammars.mjs`). Vendor a grammar only when the prebuilt is
defective; remove the override once upstream ships a good build.

## tree-sitter-swift.wasm

**Why vendored:** the `tree-sitter-wasms` 0.1.13 prebuilt (grammar 0.4.x,
tree-sitter-cli 0.20) crashes V8 on Node.js >= 24: the process aborts with
`Fatal process out of memory: Zone` while compiling the module the first time
real Swift source is parsed (verified on Node 24.13/24.17/24.18/25.9; Node <= 23
unaffected; no V8 flag avoids it). This build from the current grammar does not
trigger the defect and produces identical extraction results.

**Provenance:**

- Source: `tree-sitter-swift@0.7.1` from npm (alex-pinkus/tree-sitter-swift),
  pregenerated `src/parser.c` (LANGUAGE_VERSION 14) + `src/scanner.c`
- Toolchain: emscripten 3.1.6 (`emcc`)
- Command (run inside the unpacked npm package):

  ```sh
  emcc -o tree-sitter-swift.wasm \
    -Os -fno-exceptions -fvisibility=hidden \
    -s WASM=1 -s SIDE_MODULE=2 -s TOTAL_MEMORY=33554432 -s NODEJS_CATCH_EXIT=0 \
    -s EXPORTED_FUNCTIONS='["_tree_sitter_swift"]' \
    -I src src/parser.c src/scanner.c
  ```

**Verified:** loads under `web-tree-sitter` 0.25.10; full adversarial Swift
corpus builds with identical node/def/edge counts to the previous grammar on
Node 22, and without crashing on Node 24.18 and 25.9.
