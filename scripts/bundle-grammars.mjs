#!/usr/bin/env node
// Copy the pre-compiled tree-sitter grammar .wasm files for vg's first-wave
// languages from `tree-sitter-wasms` into ./grammars, so they ship inside the
// published package (offline-first; `vg build --grammars` can still override).
// Grammars present in ./vendor take precedence over the tree-sitter-wasms
// prebuilts — see vendor/README.md for why each one exists.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

// Keep in sync with src/engine/languages.ts.
const GRAMMARS = [
  'tree-sitter-typescript',
  'tree-sitter-tsx',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-rust',
  'tree-sitter-c_sharp',
  'tree-sitter-ruby',
  'tree-sitter-php',
  'tree-sitter-kotlin',
  'tree-sitter-swift',
  'tree-sitter-scala',
  'tree-sitter-dart',
  'tree-sitter-lua',
  'tree-sitter-elixir',
  'tree-sitter-bash',
  'tree-sitter-zig',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-objc',
  'tree-sitter-ocaml',
  'tree-sitter-rescript',
  'tree-sitter-solidity',
];

// Toolchain grammars used by src/engine/toolchain/ for the infrastructure/CI
// corpus. These do NOT live in tree-sitter-wasms, and their npm packages carry
// a native `install` script (node-gyp-build) we must never run on an end user's
// machine — so each is a *devDependency* whose prebuilt .wasm is copied into
// ./grammars at build time and shipped inside the published tarball. Users get
// the grammar file; they never install the grammar package.
// Keep in sync with src/engine/toolchain/grammars.ts.
const TOOLCHAIN_GRAMMARS = [
  { wasm: 'tree-sitter-hcl', from: '@tree-sitter-grammars/tree-sitter-hcl' },
];

const outDir = path.dirname(require.resolve('tree-sitter-wasms/package.json')) + '/out';
const vendorDir = path.join(pkgRoot, 'vendor');
const dest = path.join(pkgRoot, 'grammars');
fs.mkdirSync(dest, { recursive: true });

let copied = 0;
let vendored = 0;
const missing = [];
for (const g of GRAMMARS) {
  const vendorSrc = path.join(vendorDir, `${g}.wasm`);
  const src = fs.existsSync(vendorSrc) ? vendorSrc : path.join(outDir, `${g}.wasm`);
  if (!fs.existsSync(src)) {
    missing.push(g);
    continue;
  }
  fs.copyFileSync(src, path.join(dest, `${g}.wasm`));
  copied++;
  if (src === vendorSrc) vendored++;
}

// Toolchain grammars: a vendor/ override still wins (same rule as above), then
// the devDependency's own prebuilt .wasm.
for (const { wasm, from } of TOOLCHAIN_GRAMMARS) {
  const vendorSrc = path.join(vendorDir, `${wasm}.wasm`);
  let src = fs.existsSync(vendorSrc) ? vendorSrc : null;
  if (!src) {
    try {
      src = path.join(path.dirname(require.resolve(`${from}/package.json`)), `${wasm}.wasm`);
    } catch {
      src = null;
    }
  }
  if (!src || !fs.existsSync(src)) {
    missing.push(`${wasm} (from ${from})`);
    continue;
  }
  fs.copyFileSync(src, path.join(dest, `${wasm}.wasm`));
  copied++;
  if (src === vendorSrc) vendored++;
}

if (missing.length) {
  console.error(`bundle-grammars: missing grammars: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(
  `bundle-grammars: copied ${copied} grammar(s) → ${path.relative(pkgRoot, dest)}/` +
    (vendored ? ` (${vendored} from vendor/)` : ''),
);
