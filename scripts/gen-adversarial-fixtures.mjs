#!/usr/bin/env node
/**
 * gen-adversarial-fixtures.mjs — deterministic ADVERSARIAL test-repo generator.
 *
 * Generates, per language, a small repo full of constructs that stress the
 * code-graph engine: name collisions with delegation (self-loop bait), deep
 * nesting, unicode/weird identifiers, recursion + mutual-recursion cycles,
 * a huge single file, 5k+ char minified lines, generated-code patterns
 * (numbered handlers + dispatch tables), code-like content inside strings and
 * comments, empty/tiny/comment-only/BOM/CRLF files, import cycles (where the
 * language allows), a python package layout, and ts/js barrel files.
 *
 * Determinism contract: NO Date.now(), NO Math.random(). All variability comes
 * from a mulberry32 PRNG with a fixed seed (seeded per language, so `--langs`
 * subsets emit byte-identical files). Identical args → byte-identical output.
 *
 * Naming contract for tests: every function that (directly or mutually)
 * recurses is named with a `recur` prefix — the adversarial vitest suite
 * asserts that any call self-loop (src === dst) points at a `recur*` symbol.
 *
 * Usage:
 *   node scripts/gen-adversarial-fixtures.mjs --out /tmp/x --langs ts,py --scale 1
 *
 * Defaults: --out test/fixtures/adversarial (relative to the package root),
 * --langs all, --scale 1 (≈30–60 files per language; scale N multiplies the
 * scaled file/function counts for perf testing).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — the only source of "randomness".
// ---------------------------------------------------------------------------

const SEED = 0x5eedad5e; // fixed forever; never derived from time or env

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string — used only to derive a per-language PRNG seed. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const int = (rng, n) => Math.floor(rng() * n);
const small = (rng) => int(rng, 90) + 1; // 1..90, keeps literals boring but varied
const pad = (n, w = 4) => String(n).padStart(w, '0');
const j = (lines) => `${lines.join('\n')}\n`;
const BOM = '﻿';

// Scaled counts. Scale 1 lands ≈35–45 files per language.
function counts(scale) {
  return {
    collide: 8 * scale, // files that all define the same short names
    mixed: 10 * scale, // small caller files
    generatedFiles: 2 * scale, // numbered-handler dispatch files
    handlers: 40, // handlers per generated file
    hugeFns: 500 * scale + 12, // functions in the huge single file
    longVars: 780, // assignments on the 5k+ char minified line
    blobLen: 1200, // elements in the one-line array literal
    nestDepth: 8, // closure/class nesting depth
  };
}

// ---------------------------------------------------------------------------
// Shared snippet builders
// ---------------------------------------------------------------------------

/** One-line var chain like `a0=1,a1=7,...` (or custom item renderer). */
function chain(rng, n, render, sep) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(render(i, small(rng)));
  return parts.join(sep);
}

/** `0,5,3,...` — blob literal elements. */
function blob(rng, n) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(String(int(rng, 1000)));
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Per-language generators. Each returns [{ rel, content }].
// All languages cover the same adversarial dimensions, adapted idiomatically.
// ---------------------------------------------------------------------------

function genTs(scale, rng, ext = 'ts') {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  // Name collisions + delegation chain (self-loop bait): create() calls other.create().
  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const lines = [];
    if (hasNext) lines.push(`import * as other from './collide_${pad(i + 1, 2)}';`, '');
    lines.push(
      '// Adversarial: every collide_* module defines the same short names.',
      'export function create(): number {',
      hasNext ? '  return other.create() + 1;' : `  return ${small(rng)};`,
      '}',
      '',
      'export function get(): number {',
      `  return ${small(rng)};`,
      '}',
      '',
      'export function process(): number {',
      '  return get() + create();',
      '}',
      '',
      `export function trigger_${pad(i, 2)}(): number {`,
      '  return process();',
      '}',
    );
    push(`collide_${pad(i, 2)}.${ext}`, j(lines));
  }

  // Barrel re-export files.
  push(`barrel/alpha.${ext}`, j([
    'export function barrelAlpha(): number {',
    `  return ${small(rng)};`,
    '}',
  ]));
  push(`barrel/beta.${ext}`, j([
    'export function barrelBeta(): number {',
    `  return ${small(rng)};`,
    '}',
    '',
    'export function create(): number {',
    '  return barrelBeta();',
    '}',
  ]));
  push(`barrel/index.${ext}`, j([
    "export * from './alpha';",
    "export { barrelBeta as renamedBeta, create } from './beta';",
  ]));

  // Deep nesting: closures 8 deep, and class → method → class expression → arrow.
  push(`nesting_a.${ext}`, j(tsNestedClosures(c.nestDepth)));
  push(`nesting_b.${ext}`, j([
    'export class Outer {',
    '  method(): number {',
    '    class Inner {',
    '      inner(): number {',
    '        const f = (): number => {',
    '          const g = (): number => {',
    '            const h = (): number => 6;',
    '            return h();',
    '          };',
    '          return g();',
    '        };',
    '        return f();',
    '      }',
    '    }',
    '    return new Inner().inner();',
    '  }',
    '}',
  ]));

  // Unicode + weird identifiers.
  push(`unicode.${ext}`, j([
    'export const π = 3.14159;',
    '',
    'export function café(): number {',
    `  return ${small(rng)};`,
    '}',
    '',
    'export function 名前(): number {',
    '  return café() + 1;',
    '}',
    '',
    'export function $$get$$(): number {',
    `  return ${small(rng)};`,
    '}',
    '',
    'export function $_$(): number {',
    '  return $$get$$();',
    '}',
    '',
    'export function _(): number {',
    '  return 1;',
    '}',
    '',
    'export function x(): number {',
    '  return 2;',
    '}',
    '',
    '// Differs from x() only by case.',
    'export function X(): number {',
    '  return x() + _();',
    '}',
    '',
    'export function __severely__underscored__name__(): number {',
    '  return X();',
    '}',
  ]));

  // Recursion + mutual recursion across 3 files (also an import cycle — allowed in TS/JS).
  push(`recur_a.${ext}`, j([
    "import { recurBeta } from './recur_b';",
    '',
    'export function recurFact(n: number): number {',
    '  return n <= 1 ? 1 : n * recurFact(n - 1);',
    '}',
    '',
    'export function recurAlpha(n: number): number {',
    '  return n <= 0 ? 0 : recurBeta(n - 1);',
    '}',
  ].map((l) => (ext === 'js' ? l.replace(/: number/g, '').replace(/\(n: number\)/g, '(n)') : l))));
  push(`recur_b.${ext}`, j([
    "import { recurGamma } from './recur_c';",
    '',
    'export function recurSelfB(n: number): number {',
    '  return n <= 0 ? 0 : recurSelfB(n - 1);',
    '}',
    '',
    'export function recurBeta(n: number): number {',
    '  return n <= 0 ? 1 : recurGamma(n - 1);',
    '}',
  ].map((l) => (ext === 'js' ? l.replace(/: number/g, '').replace(/\(n: number\)/g, '(n)') : l))));
  push(`recur_c.${ext}`, j([
    "import { recurAlpha } from './recur_a';",
    '',
    'export function recurGamma(n: number): number {',
    '  return n <= 0 ? 2 : recurAlpha(n - 1);',
    '}',
  ].map((l) => (ext === 'js' ? l.replace(/: number/g, '').replace(/\(n: number\)/g, '(n)') : l))));

  // Huge single file.
  {
    const lines = ['// Generated: one huge file with many tiny functions.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `export function f_${pad(i)}(): number {`,
        callsPrev ? `  return f_${pad(i - 1)}() + ${small(rng)};` : `  return ${small(rng)};`,
        '}',
      );
    }
    push(`huge.${ext}`, j(lines));
  }

  // Minified-style long lines (5k+ chars).
  push(`minified.${ext}`, j([
    `export function longLine(): number { var ${chain(rng, c.longVars, (i, v) => `a${i}=${v}`, ',')}; return a0 + a${c.longVars - 1}; }`,
    `export const BLOB = [${blob(rng, c.blobLen)}];`,
  ]));

  // Generated-code patterns: numbered handlers + switch + dispatch table.
  for (let g = 0; g < c.generatedFiles; g++) {
    const lines = ['// Auto-generated style: numbered symbols and a dispatch table.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`function handler_${pad(h)}(): number { return ${int(rng, 10)}; }`);
    }
    lines.push('', `export function dispatch_${pad(g, 2)}(k: number): number {`, '  switch (k) {');
    for (let h = 0; h < c.handlers; h++) lines.push(`    case ${h}: return handler_${pad(h)}();`);
    lines.push('    default: return -1;', '  }', '}');
    lines.push(
      '',
      `export const TABLE_${pad(g, 2)}: Record<number, () => number> = {`,
      ...Array.from({ length: 8 }, (_, h) => `  ${h}: handler_${pad(h)},`),
      '};',
    );
    push(`generated_${pad(g, 2)}.${ext}`, j(ext === 'js'
      ? lines.map((l) => l
          .replace(/\(k: number\)/, '(k)')
          .replace(/\(\): number/g, '()')
          .replace(/: Record<number, \(\) => number>/, ''))
      : lines));
  }

  // String/comment traps.
  push(`traps.${ext}`, j([
    'export const FAKE_FN = "function fake() { return 1; }";',
    "export const FAKE_CLASS = 'class Fake { constructor() { this.x = 1; } }';",
    'export const UNBALANCED = "if (x) { while (true) {";',
    'export const TEMPLATE = `function tmplFake(a) {',
    '  if (a) { return { nested: "}" }; }',
    '  return 0;',
    '}`;',
    '',
    '// function commentFake() { return 2; }',
    '/* class CommentClass { method() { return "brace }"; } } */',
    '// stray close marker in a line comment: */',
    '',
    'export function realAfterTraps(): number {',
    '  return FAKE_FN.length + UNBALANCED.length;',
    '}',
  ].map((l) => (ext === 'js' ? l.replace('realAfterTraps(): number', 'realAfterTraps()') : l))));

  // Empty / tiny / comment-only / BOM / CRLF.
  push(`empty.${ext}`, '');
  push(`tiny.${ext}`, `export const one = 1;\n`);
  push(`comments_only.${ext}`, j([
    '// This file contains only comments.',
    '/* Even this block comment mentions function nothingHere() {} */',
  ]));
  push(`bom.${ext}`, `${BOM}export function bomFn(): number {\n  return 1;\n}\n`);
  push(`crlf.${ext}`, 'export function crlfFn(): number {\n  return 2;\n}\n'.replace(/\n/g, '\r\n'));

  // Explicit import cycle (allowed in ES modules).
  push(`cycle_a.${ext}`, j([
    "import { recurCycleB } from './cycle_b';",
    'export function recurCycleA(n: number): number {',
    '  return n <= 0 ? 0 : recurCycleB(n - 1);',
    '}',
  ].map((l) => (ext === 'js' ? l.replace('(n: number): number', '(n)') : l))));
  push(`cycle_b.${ext}`, j([
    "import { recurCycleC } from './cycle_c';",
    'export function recurCycleB(n: number): number {',
    '  return n <= 0 ? 1 : recurCycleC(n - 1);',
    '}',
  ].map((l) => (ext === 'js' ? l.replace('(n: number): number', '(n)') : l))));
  push(`cycle_c.${ext}`, j([
    "import { recurCycleA } from './cycle_a';",
    'export function recurCycleC(n: number): number {',
    '  return n <= 0 ? 2 : recurCycleA(n - 1);',
    '}',
  ].map((l) => (ext === 'js' ? l.replace('(n: number): number', '(n)') : l))));

  // Mixed small callers.
  for (let m = 0; m < c.mixed; m++) {
    const target = pad(m % c.collide, 2);
    push(`mixed_${pad(m, 2)}.${ext}`, j([
      `import * as c${target} from './collide_${target}';`,
      '',
      `export function use_${pad(m, 2)}(): number {`,
      `  return c${target}.get() + helper_${pad(m, 2)}();`,
      '}',
      '',
      `function helper_${pad(m, 2)}(): number {`,
      `  return ${small(rng)};`,
      '}',
    ].map((l) => (ext === 'js' ? l.replace(/\(\): number/g, '()') : l))));
  }

  // Bonus: a TSX variant under the ts tree.
  if (ext === 'ts') {
    push('widget.tsx', j([
      'export function Widget(props: { label: string }): unknown {',
      '  const inner = <span data-x="{ not: code }">{props.label}</span>;',
      '  return <div className="w">{inner}</div>;',
      '}',
      '',
      'export function WidgetList(): unknown {',
      '  return (',
      '    <div>',
      '      <Widget label="a" />',
      '      <Widget label="}" />',
      '    </div>',
      '  );',
      '}',
    ]));
  }

  return files;
}

/** TS/JS closure nesting, depth levels of named inner functions. */
function tsNestedClosures(depth) {
  const lines = ['export function outermost(): number {'];
  for (let d = 1; d <= depth; d++) lines.push(`${'  '.repeat(d)}function level${d}(): number {`);
  lines.push(`${'  '.repeat(depth + 1)}return ${depth};`);
  for (let d = depth; d >= 1; d--) {
    lines.push(`${'  '.repeat(d)}}`);
    lines.push(`${'  '.repeat(d)}return level${d}();`);
  }
  lines.push('}');
  return lines;
}

function genJs(scale, rng) {
  // Reuse the TS generator with type annotations stripped where it matters.
  const files = genTs(scale, rng, 'js');
  // Strip remaining TS-only syntax from the shared nesting/class files.
  return files.map(({ rel, content }) => ({
    rel,
    content: content
      .replace(/: number/g, '')
      .replace(/: unknown/g, '')
      .replace(/\(props: \{ label: string \}\)/g, '(props)')
      .replace(/const (f|g|h) = \(\)/g, 'const $1 = ()'),
  }));
}

function genPy(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const lines = [];
    if (hasNext) lines.push(`import collide_${pad(i + 1, 2)} as other`, '');
    lines.push(
      '# Adversarial: every collide_* module defines the same short names.',
      'def create():',
      hasNext ? '    return other.create() + 1' : `    return ${small(rng)}`,
      '',
      '',
      'def get():',
      `    return ${small(rng)}`,
      '',
      '',
      'def process():',
      '    return get() + create()',
      '',
      '',
      `def trigger_${pad(i, 2)}():`,
      '    return process()',
    );
    push(`collide_${pad(i, 2)}.py`, j(lines));
  }

  // __init__.py package layout with re-exports.
  push('pkg/__init__.py', j([
    'from .core import create, get',
    'from .sub.leaf import leaf_value',
    '',
    "__all__ = ['create', 'get', 'leaf_value']",
  ]));
  push('pkg/core.py', j([
    'def create():',
    `    return ${small(rng)}`,
    '',
    '',
    'def get():',
    '    return create() + 1',
  ]));
  push('pkg/sub/__init__.py', j(['from .leaf import leaf_value']));
  push('pkg/sub/leaf.py', j([
    'def leaf_value():',
    `    return ${small(rng)}`,
  ]));

  // Deep nesting: def-in-def, class-in-class.
  {
    const lines = ['def outermost():'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'    '.repeat(d)}def level${d}():`);
    lines.push(`${'    '.repeat(c.nestDepth + 1)}return ${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) lines.push(`${'    '.repeat(d)}return level${d}()`);
    push('nesting_a.py', j(lines));
  }
  {
    const lines = [];
    for (let d = 0; d < 6; d++) lines.push(`${'    '.repeat(d)}class Level${d + 1}:`);
    lines.push(`${'    '.repeat(6)}def deepest(self):`);
    lines.push(`${'    '.repeat(7)}return 6`);
    lines.push('', '', 'def touch_nested():');
    lines.push('    return Level1.Level2.Level3.Level4.Level5.Level6');
    push('nesting_b.py', j(lines));
  }

  push('unicode.py', j([
    'π = 3.14159',
    '',
    '',
    'def café():',
    `    return ${small(rng)}`,
    '',
    '',
    'def 名前():',
    '    return café() + 1',
    '',
    '',
    'def _():',
    '    return 1',
    '',
    '',
    'def x():',
    '    return 2',
    '',
    '',
    'def X():',
    '    # differs from x() only by case',
    '    return x() + _()',
    '',
    '',
    'def __severely__underscored__():',
    '    return X()',
  ]));

  push('recur_a.py', j([
    'import recur_b',
    '',
    '',
    'def recur_fact(n):',
    '    return 1 if n <= 1 else n * recur_fact(n - 1)',
    '',
    '',
    'def recur_alpha(n):',
    '    return 0 if n <= 0 else recur_b.recur_beta(n - 1)',
  ]));
  push('recur_b.py', j([
    'import recur_c',
    '',
    '',
    'def recur_self_b(n):',
    '    return 0 if n <= 0 else recur_self_b(n - 1)',
    '',
    '',
    'def recur_beta(n):',
    '    return 1 if n <= 0 else recur_c.recur_gamma(n - 1)',
  ]));
  push('recur_c.py', j([
    'import recur_a',
    '',
    '',
    'def recur_gamma(n):',
    '    return 2 if n <= 0 else recur_a.recur_alpha(n - 1)',
  ]));

  {
    const lines = ['# Generated: one huge file with many tiny functions.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `def f_${pad(i)}():`,
        callsPrev ? `    return f_${pad(i - 1)}() + ${small(rng)}` : `    return ${small(rng)}`,
        '',
        '',
      );
    }
    push('huge.py', j(lines));
  }

  push('minified.py', j([
    `def long_line(): ${chain(rng, c.longVars, (i, v) => `a${i}=${v}`, '; ')}; return a0 + a${c.longVars - 1}`,
    '',
    '',
    `BLOB = [${blob(rng, c.blobLen)}]`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const lines = ['# Auto-generated style: numbered symbols and a dispatch table.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`def handler_${pad(h)}():`, `    return ${int(rng, 10)}`, '', '');
    }
    lines.push(`DISPATCH_${pad(g, 2)} = {`);
    for (let h = 0; h < c.handlers; h++) lines.push(`    ${h}: handler_${pad(h)},`);
    lines.push('}', '', '');
    lines.push(`def dispatch_${pad(g, 2)}(k):`);
    lines.push(`    if k in DISPATCH_${pad(g, 2)}:`);
    lines.push(`        return DISPATCH_${pad(g, 2)}[k]()`);
    lines.push('    return -1');
    push(`generated_${pad(g, 2)}.py`, j(lines));
  }

  push('traps.py', j([
    'FAKE_DEF = "def fake():\\n    return 1"',
    "FAKE_CLASS = '''",
    'class FakeClass:',
    '    def method(self):',
    '        return "def another_fake(): pass"',
    "'''",
    'UNBALANCED = "def broken(:  # not code"',
    '',
    '# def comment_fake(): return 2',
    '# } unbalanced brace in a comment',
    '',
    '',
    'def real_after_traps():',
    '    return len(FAKE_DEF) + len(FAKE_CLASS)',
  ]));

  push('empty.py', '');
  push('tiny.py', 'ONE = 1\n');
  push('comments_only.py', j([
    '# This file contains only comments.',
    '# def nothing_here(): pass',
  ]));
  push('bom.py', `${BOM}def bom_fn():\n    return 1\n`);
  push('crlf.py', 'def crlf_fn():\n    return 2\n'.replace(/\n/g, '\r\n'));

  push('cycle_a.py', j([
    'import cycle_b',
    '',
    '',
    'def recur_cycle_a(n):',
    '    return 0 if n <= 0 else cycle_b.recur_cycle_b(n - 1)',
  ]));
  push('cycle_b.py', j([
    'import cycle_c',
    '',
    '',
    'def recur_cycle_b(n):',
    '    return 1 if n <= 0 else cycle_c.recur_cycle_c(n - 1)',
  ]));
  push('cycle_c.py', j([
    'import cycle_a',
    '',
    '',
    'def recur_cycle_c(n):',
    '    return 2 if n <= 0 else cycle_a.recur_cycle_a(n - 1)',
  ]));

  for (let m = 0; m < c.mixed; m++) {
    const target = pad(m % c.collide, 2);
    push(`mixed_${pad(m, 2)}.py`, j([
      `import collide_${target}`,
      '',
      '',
      `def use_${pad(m, 2)}():`,
      `    return collide_${target}.get() + helper_${pad(m, 2)}()`,
      '',
      '',
      `def helper_${pad(m, 2)}():`,
      `    return ${small(rng)}`,
    ]));
  }

  return files;
}

function genGo(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  // Collisions live in per-directory packages (Go forbids same-name funcs in one
  // package). Delegation is a chain, not a ring — a ring would be an import
  // cycle, which Go forbids.
  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const pkg = `collide${pad(i, 2)}`;
    const next = `collide${pad(i + 1, 2)}`;
    const lines = [`package ${pkg}`, ''];
    if (hasNext) lines.push(`import next "adv/${next}"`, '');
    lines.push(
      '// Adversarial: every collide package exports the same short names.',
      'func Create() int {',
      hasNext ? '\treturn next.Create() + 1' : `\treturn ${small(rng)}`,
      '}',
      '',
      'func Get() int {',
      `\treturn ${small(rng)}`,
      '}',
      '',
      'func Process() int {',
      '\treturn Get() + Create()',
      '}',
    );
    push(`${pkg}/${pkg}.go`, j(lines));
  }

  {
    const lines = ['package misc', '', 'func Outermost() int {'];
    for (let d = 1; d <= c.nestDepth; d++) {
      lines.push(`${'\t'.repeat(d)}level${d} := func() int {`);
    }
    lines.push(`${'\t'.repeat(c.nestDepth + 1)}return ${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'\t'.repeat(d)}}`);
      lines.push(`${'\t'.repeat(d)}return level${d}()`);
    }
    lines.push('}');
    push('misc/nesting.go', j(lines));
  }

  push('misc/unicode.go', j([
    'package misc',
    '',
    'var π = 3.14159',
    '',
    'func café() int {',
    `\treturn ${small(rng)}`,
    '}',
    '',
    'func Δelta() int {',
    '\treturn café() + 1',
    '}',
    '',
    'func x() int {',
    '\treturn 2',
    '}',
    '',
    '// Differs from x only by case.',
    'func X() int {',
    '\treturn x() + 1',
    '}',
    '',
    'func __underscored__() int {',
    '\treturn X()',
    '}',
  ]));

  push('recur/a.go', j([
    'package recur',
    '',
    'func recurFact(n int) int {',
    '\tif n <= 1 {',
    '\t\treturn 1',
    '\t}',
    '\treturn n * recurFact(n-1)',
    '}',
    '',
    'func recurAlpha(n int) int {',
    '\tif n <= 0 {',
    '\t\treturn 0',
    '\t}',
    '\treturn recurBeta(n - 1)',
    '}',
  ]));
  push('recur/b.go', j([
    'package recur',
    '',
    'func recurSelfB(n int) int {',
    '\tif n <= 0 {',
    '\t\treturn 0',
    '\t}',
    '\treturn recurSelfB(n - 1)',
    '}',
    '',
    'func recurBeta(n int) int {',
    '\tif n <= 0 {',
    '\t\treturn 1',
    '\t}',
    '\treturn recurGamma(n - 1)',
    '}',
  ]));
  push('recur/c.go', j([
    'package recur',
    '',
    'func recurGamma(n int) int {',
    '\tif n <= 0 {',
    '\t\treturn 2',
    '\t}',
    '\treturn recurAlpha(n - 1)',
    '}',
  ]));

  {
    const lines = ['package huge', ''];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `func f${pad(i)}() int {`,
        callsPrev ? `\treturn f${pad(i - 1)}() + ${small(rng)}` : `\treturn ${small(rng)}`,
        '}',
        '',
      );
    }
    push('huge/huge.go', j(lines));
  }

  // Go requires every local to be used, so the long line returns the sum of all.
  {
    const decls = chain(rng, c.longVars, (i, v) => `a${i} := ${v}`, '; ');
    const sum = Array.from({ length: c.longVars }, (_, i) => `a${i}`).join(' + ');
    push('minified/minified.go', j([
      'package minified',
      '',
      `func LongLine() int { ${decls}; return ${sum} }`,
      '',
      `var Blob = []int{${blob(rng, c.blobLen)}}`,
    ]));
  }

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = ['package gen', ''];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`func h${fp}x${pad(h)}() int { return ${int(rng, 10)} }`);
    }
    lines.push('', `func Dispatch${fp}(k int) int {`, '\tswitch k {');
    for (let h = 0; h < c.handlers; h++) lines.push(`\tcase ${h}:`, `\t\treturn h${fp}x${pad(h)}()`);
    lines.push('\tdefault:', '\t\treturn -1', '\t}', '}');
    push(`gen/generated_${fp}.go`, j(lines));
  }

  push('traps/traps.go', j([
    'package traps',
    '',
    'const fakeFunc = "func fake() int { return 1 }"',
    '',
    'const rawFake = `func rawFake() int {',
    '\treturn 2 // } stray brace and "quote inside a raw string',
    '}`',
    '',
    '// func commentFake() int { return 3 }',
    '/* func blockFake() int { return 4 } */',
    '',
    'func realAfterTraps() int {',
    '\treturn len(fakeFunc) + len(rawFake)',
    '}',
  ]));

  // A truly empty .go file is not valid Go — package clause only.
  push('emptyish/empty.go', 'package emptyish\n');
  push('tiny/tiny.go', 'package tiny\n\nvar One = 1\n');
  push('commentsonly/comments.go', j([
    '// This file is only a package clause and comments.',
    '// func nothingHere() int { return 0 }',
    'package commentsonly',
  ]));
  push('bomdir/bom.go', `${BOM}package bomdir\n\nfunc BomFn() int {\n\treturn 1\n}\n`);
  push('crlfdir/crlf.go', 'package crlfdir\n\nfunc CrlfFn() int {\n\treturn 2\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const target = pad(m % c.collide, 2);
    push(`mixed/mixed_${pad(m, 2)}.go`, j([
      'package mixed',
      '',
      `import c${target} "adv/collide${target}"`,
      '',
      `func Use${pad(m, 2)}() int {`,
      `\treturn c${target}.Get() + local${pad(m, 2)}()`,
      '}',
      '',
      `func local${pad(m, 2)}() int {`,
      `\treturn ${small(rng)}`,
      '}',
    ]));
  }

  return files;
}

function genJava(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const cls = `Collide${pad(i, 2)}`;
    const next = `Collide${pad(i + 1, 2)}`;
    push(`${cls}.java`, j([
      'package adv;',
      '',
      '// Adversarial: every Collide class defines the same short method names.',
      `public class ${cls} {`,
      '    static int create() {',
      hasNext ? `        return ${next}.create() + 1;` : `        return ${small(rng)};`,
      '    }',
      '',
      '    static int get() {',
      `        return ${small(rng)};`,
      '    }',
      '',
      '    static int process() {',
      '        return get() + create();',
      '    }',
      '}',
    ]));
  }

  {
    const lines = ['package adv;', '', 'public class NestingA {'];
    for (let d = 1; d <= 6; d++) lines.push(`${'    '.repeat(d)}static class L${d} {`);
    lines.push(`${'    '.repeat(7)}static int deep() {`);
    lines.push(`${'    '.repeat(8)}return 6;`);
    lines.push(`${'    '.repeat(7)}}`);
    for (let d = 6; d >= 1; d--) lines.push(`${'    '.repeat(d)}}`);
    lines.push('');
    lines.push('    static int outermost() {');
    lines.push(`        return L1.${Array.from({ length: 5 }, (_, k) => `L${k + 2}`).join('.')}.deep();`);
    lines.push('    }');
    lines.push('}');
    push('NestingA.java', j(lines));
  }
  {
    const depth = c.nestDepth;
    const lines = [
      'package adv;',
      '',
      'import java.util.function.Supplier;',
      '',
      'public class NestingB {',
      '    static int outermost() {',
    ];
    for (let d = 1; d <= depth; d++) {
      lines.push(`${'    '.repeat(d + 1)}Supplier<Integer> level${d} = () -> {`);
    }
    lines.push(`${'    '.repeat(depth + 2)}return ${depth};`);
    for (let d = depth; d >= 1; d--) {
      lines.push(`${'    '.repeat(d + 1)}};`);
      lines.push(`${'    '.repeat(d + 1)}return level${d}.get();`);
    }
    lines.push('    }');
    lines.push('}');
    push('NestingB.java', j(lines));
  }

  push('UnicodeIds.java', j([
    'package adv;',
    '',
    'public class UnicodeIds {',
    '    static int café() {',
    `        return ${small(rng)};`,
    '    }',
    '',
    '    static int 名前() {',
    '        return café() + 1;',
    '    }',
    '',
    '    static int $get$() {',
    `        return ${small(rng)};`,
    '    }',
    '',
    '    static int $_$() {',
    '        return $get$();',
    '    }',
    '',
    '    static int x() {',
    '        return 2;',
    '    }',
    '',
    '    // Differs from x only by case.',
    '    static int X() {',
    '        return x() + 1;',
    '    }',
    '}',
  ]));

  push('RecurA.java', j([
    'package adv;',
    '',
    'public class RecurA {',
    '    static int recurFact(int n) {',
    '        return n <= 1 ? 1 : n * recurFact(n - 1);',
    '    }',
    '',
    '    static int recurAlpha(int n) {',
    '        return n <= 0 ? 0 : RecurB.recurBeta(n - 1);',
    '    }',
    '}',
  ]));
  push('RecurB.java', j([
    'package adv;',
    '',
    'public class RecurB {',
    '    static int recurSelfB(int n) {',
    '        return n <= 0 ? 0 : recurSelfB(n - 1);',
    '    }',
    '',
    '    static int recurBeta(int n) {',
    '        return n <= 0 ? 1 : RecurC.recurGamma(n - 1);',
    '    }',
    '}',
  ]));
  push('RecurC.java', j([
    'package adv;',
    '',
    'public class RecurC {',
    '    static int recurGamma(int n) {',
    '        return n <= 0 ? 2 : RecurA.recurAlpha(n - 1);',
    '    }',
    '}',
  ]));

  {
    const lines = ['package adv;', '', 'public class Huge {'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `    static int f${pad(i)}() {`,
        callsPrev ? `        return f${pad(i - 1)}() + ${small(rng)};` : `        return ${small(rng)};`,
        '    }',
      );
    }
    lines.push('}');
    push('Huge.java', j(lines));
  }

  push('Minified.java', j([
    'package adv;',
    '',
    `public class Minified { static int longLine() { int ${chain(rng, c.longVars, (i, v) => `a${i}=${v}`, ',')}; return a0 + a${c.longVars - 1}; } static int[] blob() { return new int[]{${blob(rng, c.blobLen)}}; } }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const cls = `Generated${pad(g, 2)}`;
    const lines = ['package adv;', '', `public class ${cls} {`];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`    static int handler${pad(h)}() { return ${int(rng, 10)}; }`);
    }
    lines.push('', '    static int dispatch(int k) {', '        switch (k) {');
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`            case ${h}: return handler${pad(h)}();`);
    }
    lines.push('            default: return -1;', '        }', '    }', '}');
    push(`${cls}.java`, j(lines));
  }

  push('Traps.java', j([
    'package adv;',
    '',
    'public class Traps {',
    '    static final String FAKE_FN = "int fake() { return 1; }";',
    '    static final String FAKE_CLASS = "class Fake { void m() {} }";',
    '    static final String UNBALANCED = "if (x) { while (true) {";',
    '',
    '    // int commentFake() { return 2; }',
    '    /* class CommentClass { int m() { return 3; } } */',
    '',
    '    static int realAfterTraps() {',
    '        return FAKE_FN.length() + UNBALANCED.length();',
    '    }',
    '}',
  ]));

  push('Empty.java', '');
  push('Tiny.java', 'package adv;\n\nclass Tiny {}\n');
  push('CommentsOnly.java', j([
    '// This file contains only comments.',
    '/* class NothingHere { int m() { return 0; } } */',
  ]));
  // NOTE: javac rejects a BOM ("illegal character"), so unlike the other
  // languages the Java tree gets no BOM prefix — Bom.java is BOM-free.
  push('Bom.java', 'package adv;\n\npublic class Bom {\n    static int bomFn() {\n        return 1;\n    }\n}\n');
  push('Crlf.java', 'package adv;\n\npublic class Crlf {\n    static int crlfFn() {\n        return 2;\n    }\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const cls = `Mixed${pad(m, 2)}`;
    const target = `Collide${pad(m % c.collide, 2)}`;
    push(`${cls}.java`, j([
      'package adv;',
      '',
      `public class ${cls} {`,
      `    static int use${pad(m, 2)}() {`,
      `        return ${target}.get() + local${pad(m, 2)}();`,
      '    }',
      '',
      `    static int local${pad(m, 2)}() {`,
      `        return ${small(rng)};`,
      '    }',
      '}',
    ]));
  }

  return files;
}

function genRust(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });
  const mods = [];
  const mod = (rel) => mods.push(rel.replace(/\.rs$/, '').replace(/\//g, '::'));

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const rel = `collide_${pad(i, 2)}.rs`;
    mod(rel);
    push(rel, j([
      '// Adversarial: every collide_* module defines the same short names.',
      'pub fn create() -> i32 {',
      hasNext ? `    crate::collide_${pad(i + 1, 2)}::create() + 1` : `    ${small(rng)}`,
      '}',
      '',
      'pub fn get() -> i32 {',
      `    ${small(rng)}`,
      '}',
      '',
      'pub fn process() -> i32 {',
      '    get() + create()',
      '}',
    ]));
  }

  {
    const lines = ['pub fn outermost() -> i32 {'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'    '.repeat(d)}fn level${d}() -> i32 {`);
    lines.push(`${'    '.repeat(c.nestDepth + 1)}${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'    '.repeat(d)}}`);
      lines.push(`${'    '.repeat(d)}${d === 1 ? 'level1()' : `return level${d}();`}`);
    }
    lines.push('}');
    mod('nesting_a.rs');
    push('nesting_a.rs', j(lines));
  }
  {
    const lines = [];
    for (let d = 1; d <= 6; d++) lines.push(`${'    '.repeat(d - 1)}pub mod m${d} {`);
    lines.push(`${'    '.repeat(6)}pub fn deep() -> i32 {`);
    lines.push(`${'    '.repeat(7)}6`);
    lines.push(`${'    '.repeat(6)}}`);
    for (let d = 6; d >= 1; d--) lines.push(`${'    '.repeat(d - 1)}}`);
    lines.push('');
    lines.push('pub fn touch_nested() -> i32 {');
    lines.push(`    m1::m2::m3::m4::m5::m6::deep()`);
    lines.push('}');
    mod('nesting_b.rs');
    push('nesting_b.rs', j(lines));
  }

  mod('unicode.rs');
  push('unicode.rs', j([
    'pub fn café() -> i32 {',
    `    ${small(rng)}`,
    '}',
    '',
    'pub fn δelta() -> i32 {',
    '    café() + 1',
    '}',
    '',
    'pub fn x() -> i32 {',
    '    2',
    '}',
    '',
    '#[allow(non_snake_case)]',
    'pub fn X() -> i32 {',
    '    x() + 1',
    '}',
    '',
    'pub fn __severely__underscored__() -> i32 {',
    '    X()',
    '}',
  ]));

  mod('recur_a.rs');
  push('recur_a.rs', j([
    'pub fn recur_fact(n: i32) -> i32 {',
    '    if n <= 1 { 1 } else { n * recur_fact(n - 1) }',
    '}',
    '',
    'pub fn recur_alpha(n: i32) -> i32 {',
    '    if n <= 0 { 0 } else { crate::recur_b::recur_beta(n - 1) }',
    '}',
  ]));
  mod('recur_b.rs');
  push('recur_b.rs', j([
    'pub fn recur_self_b(n: i32) -> i32 {',
    '    if n <= 0 { 0 } else { recur_self_b(n - 1) }',
    '}',
    '',
    'pub fn recur_beta(n: i32) -> i32 {',
    '    if n <= 0 { 1 } else { crate::recur_c::recur_gamma(n - 1) }',
    '}',
  ]));
  mod('recur_c.rs');
  push('recur_c.rs', j([
    'pub fn recur_gamma(n: i32) -> i32 {',
    '    if n <= 0 { 2 } else { crate::recur_a::recur_alpha(n - 1) }',
    '}',
  ]));

  {
    const lines = ['// Generated: one huge file with many tiny functions.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `pub fn f_${pad(i)}() -> i32 {`,
        callsPrev ? `    f_${pad(i - 1)}() + ${small(rng)}` : `    ${small(rng)}`,
        '}',
      );
    }
    mod('huge.rs');
    push('huge.rs', j(lines));
  }

  mod('minified.rs');
  push('minified.rs', j([
    `pub fn long_line() -> i32 { ${chain(rng, c.longVars, (i, v) => `let a${i} = ${v};`, ' ')} a0 + a${c.longVars - 1} }`,
    `pub const BLOB: [i32; ${c.blobLen}] = [${blob(rng, c.blobLen)}];`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = ['// Auto-generated style: numbered symbols and a match dispatch.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`fn handler_${pad(h)}() -> i32 { ${int(rng, 10)} }`);
    }
    lines.push('', `pub fn dispatch_${fp}(k: i32) -> i32 {`, '    match k {');
    for (let h = 0; h < c.handlers; h++) lines.push(`        ${h} => handler_${pad(h)}(),`);
    lines.push('        _ => -1,', '    }', '}');
    mod(`generated_${fp}.rs`);
    push(`generated_${fp}.rs`, j(lines));
  }

  mod('traps.rs');
  push('traps.rs', j([
    'pub const FAKE_FN: &str = "fn fake() -> i32 { 1 }";',
    'pub const RAW: &str = r#"fn raw_fake() -> i32 { "quoted } brace"; 2 }"#;',
    'pub const UNBALANCED: &str = "fn broken( {{";',
    '',
    '// fn comment_fake() -> i32 { 3 }',
    '/* outer /* nested block comments are valid in rust: fn nested_fake() {} */ still a comment */',
    '',
    'pub fn real_after_traps() -> usize {',
    '    FAKE_FN.len() + RAW.len()',
    '}',
  ]));

  mod('empty.rs');
  push('empty.rs', '');
  mod('tiny.rs');
  push('tiny.rs', 'pub const ONE: i32 = 1;\n');
  mod('comments_only.rs');
  push('comments_only.rs', j([
    '// This file contains only comments.',
    '/* fn nothing_here() -> i32 { 0 } */',
  ]));
  mod('bom.rs');
  push('bom.rs', `${BOM}pub fn bom_fn() -> i32 {\n    1\n}\n`);
  mod('crlf.rs');
  push('crlf.rs', 'pub fn crlf_fn() -> i32 {\n    2\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    mod(`mixed_${fp}.rs`);
    push(`mixed_${fp}.rs`, j([
      `pub fn use_${fp}() -> i32 {`,
      `    crate::collide_${target}::get() + local_${fp}()`,
      '}',
      '',
      `fn local_${fp}() -> i32 {`,
      `    ${small(rng)}`,
      '}',
    ]));
  }

  // Crate root declaring every module, so the tree is an honest crate.
  push('lib.rs', j([
    '#![allow(dead_code, unused_variables, mixed_script_confusables, uncommon_codepoints)]',
    '',
    ...mods.sort().map((m) => `pub mod ${m};`),
  ]));

  return files;
}

function genCs(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });
  const wrap = (cls, body) => j([
    'namespace AdvFix',
    '{',
    `    public static class ${cls}`,
    '    {',
    ...body.map((l) => (l === '' ? '' : `        ${l}`)),
    '    }',
    '}',
  ]);

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const cls = `Collide${pad(i, 2)}`;
    push(`${cls}.cs`, wrap(cls, [
      '// Adversarial: every Collide class defines the same short method names.',
      'public static int Create()',
      '{',
      hasNext ? `    return Collide${pad(i + 1, 2)}.Create() + 1;` : `    return ${small(rng)};`,
      '}',
      '',
      'public static int Get()',
      '{',
      `    return ${small(rng)};`,
      '}',
      '',
      'public static int Process()',
      '{',
      '    return Get() + Create();',
      '}',
    ]));
  }

  {
    const body = [];
    for (let d = 1; d <= 6; d++) body.push(`${'    '.repeat(d - 1)}public static class L${d}`, `${'    '.repeat(d - 1)}{`);
    body.push(`${'    '.repeat(6)}public static int Deep() { return 6; }`);
    for (let d = 6; d >= 1; d--) body.push(`${'    '.repeat(d - 1)}}`);
    body.push('');
    body.push('public static int Outermost()');
    body.push('{');
    body.push('    return L1.L2.L3.L4.L5.L6.Deep();');
    body.push('}');
    push('NestingA.cs', wrap('NestingA', body));
  }
  {
    const depth = c.nestDepth;
    const body = ['public static int Outermost()', '{'];
    for (let d = 1; d <= depth; d++) {
      body.push(`${'    '.repeat(d)}System.Func<int> level${d} = () =>`, `${'    '.repeat(d)}{`);
    }
    body.push(`${'    '.repeat(depth + 1)}return ${depth};`);
    for (let d = depth; d >= 1; d--) {
      body.push(`${'    '.repeat(d)}};`);
      body.push(`${'    '.repeat(d)}return level${d}();`);
    }
    body.push('}');
    push('NestingB.cs', wrap('NestingB', body));
  }

  push('UnicodeIds.cs', wrap('UnicodeIds', [
    'public static int Café()',
    '{',
    `    return ${small(rng)};`,
    '}',
    '',
    'public static int 名前()',
    '{',
    '    return Café() + 1;',
    '}',
    '',
    'public static int _x()',
    '{',
    '    return 2;',
    '}',
    '',
    '// Differs from _x only by case.',
    'public static int _X()',
    '{',
    '    return _x() + 1;',
    '}',
    '',
    'public static int __Severely__Underscored__()',
    '{',
    '    return _X();',
    '}',
  ]));

  push('RecurA.cs', wrap('RecurA', [
    'public static int recurFact(int n)',
    '{',
    '    return n <= 1 ? 1 : n * recurFact(n - 1);',
    '}',
    '',
    'public static int recurAlpha(int n)',
    '{',
    '    return n <= 0 ? 0 : RecurB.recurBeta(n - 1);',
    '}',
  ]));
  push('RecurB.cs', wrap('RecurB', [
    'public static int recurSelfB(int n)',
    '{',
    '    return n <= 0 ? 0 : recurSelfB(n - 1);',
    '}',
    '',
    'public static int recurBeta(int n)',
    '{',
    '    return n <= 0 ? 1 : RecurC.recurGamma(n - 1);',
    '}',
  ]));
  push('RecurC.cs', wrap('RecurC', [
    'public static int recurGamma(int n)',
    '{',
    '    return n <= 0 ? 2 : RecurA.recurAlpha(n - 1);',
    '}',
  ]));

  {
    const body = [];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      body.push(
        `public static int F${pad(i)}() { return ${callsPrev ? `F${pad(i - 1)}() + ${small(rng)}` : small(rng)}; }`,
      );
    }
    push('Huge.cs', wrap('Huge', body));
  }

  push('Minified.cs', j([
    `namespace AdvFix { public static class Minified { public static int LongLine() { int ${chain(rng, c.longVars, (i, v) => `a${i}=${v}`, ',')}; return a0 + a${c.longVars - 1}; } public static int[] Blob() { return new int[]{${blob(rng, c.blobLen)}}; } } }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const cls = `Generated${pad(g, 2)}`;
    const body = [];
    for (let h = 0; h < c.handlers; h++) {
      body.push(`static int Handler${pad(h)}() { return ${int(rng, 10)}; }`);
    }
    body.push('', 'public static int Dispatch(int k)', '{', '    switch (k)', '    {');
    for (let h = 0; h < c.handlers; h++) body.push(`        case ${h}: return Handler${pad(h)}();`);
    body.push('        default: return -1;', '    }', '}');
    push(`${cls}.cs`, wrap(cls, body));
  }

  push('Traps.cs', wrap('Traps', [
    'const string FakeFn = "int Fake() { return 1; }";',
    'const string Verbatim = @"class Fake { int M() { return ""quoted } brace""; } }";',
    'const string Unbalanced = "if (x) { while (true) {";',
    '',
    '// int CommentFake() { return 2; }',
    '/* class CommentClass { int M() { return 3; } } */',
    '',
    'public static int RealAfterTraps()',
    '{',
    '    return FakeFn.Length + Unbalanced.Length;',
    '}',
  ]));

  push('Empty.cs', '');
  push('Tiny.cs', 'namespace AdvFix { public static class Tiny { public const int One = 1; } }\n');
  push('CommentsOnly.cs', j([
    '// This file contains only comments.',
    '/* class NothingHere { int M() { return 0; } } */',
  ]));
  push('Bom.cs', `${BOM}namespace AdvFix\n{\n    public static class Bom\n    {\n        public static int BomFn()\n        {\n            return 1;\n        }\n    }\n}\n`);
  push('Crlf.cs', 'namespace AdvFix\n{\n    public static class Crlf\n    {\n        public static int CrlfFn()\n        {\n            return 2;\n        }\n    }\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const cls = `Mixed${pad(m, 2)}`;
    const target = `Collide${pad(m % c.collide, 2)}`;
    push(`${cls}.cs`, wrap(cls, [
      `public static int Use${pad(m, 2)}()`,
      '{',
      `    return ${target}.Get() + Local${pad(m, 2)}();`,
      '}',
      '',
      `static int Local${pad(m, 2)}()`,
      '{',
      `    return ${small(rng)};`,
      '}',
    ]));
  }

  return files;
}

function genRb(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const mod = `Collide${pad(i, 2)}`;
    const lines = [];
    if (hasNext) lines.push(`require_relative 'collide_${pad(i + 1, 2)}'`, '');
    lines.push(
      '# Adversarial: every Collide module defines the same short method names.',
      `module ${mod}`,
      '  def self.create',
      hasNext ? `    Collide${pad(i + 1, 2)}.create + 1` : `    ${small(rng)}`,
      '  end',
      '',
      '  def self.get',
      `    ${small(rng)}`,
      '  end',
      '',
      '  def self.process',
      '    get + create',
      '  end',
      'end',
    );
    push(`collide_${pad(i, 2)}.rb`, j(lines));
  }

  {
    const lines = ['def outermost'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'  '.repeat(d)}level${d} = lambda do`);
    lines.push(`${'  '.repeat(c.nestDepth + 1)}${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'  '.repeat(d)}end`);
      lines.push(`${'  '.repeat(d)}${d === 1 ? 'level1.call' : `return level${d}.call`}`);
    }
    lines.push('end');
    push('nesting_a.rb', j(lines));
  }
  {
    const lines = [];
    for (let d = 1; d <= 6; d++) lines.push(`${'  '.repeat(d - 1)}class Level${d}`);
    lines.push(`${'  '.repeat(6)}def deepest`);
    lines.push(`${'  '.repeat(7)}6`);
    lines.push(`${'  '.repeat(6)}end`);
    for (let d = 6; d >= 1; d--) lines.push(`${'  '.repeat(d - 1)}end`);
    push('nesting_b.rb', j(lines));
  }

  push('unicode.rb', j([
    'def café',
    `  ${small(rng)}`,
    'end',
    '',
    'def 名前',
    '  café + 1',
    'end',
    '',
    'def _',
    '  1',
    'end',
    '',
    'def x',
    '  2',
    'end',
    '',
    '# Method names differing only by trailing punctuation.',
    'def x!',
    '  x + 1',
    'end',
    '',
    'def x?',
    '  x! > 0',
    'end',
    '',
    'def __severely__underscored__',
    '  _ + x',
    'end',
  ]));

  push('recur_a.rb', j([
    "require_relative 'recur_b'",
    '',
    'module RecurA',
    '  def self.recur_fact(n)',
    '    n <= 1 ? 1 : n * recur_fact(n - 1)',
    '  end',
    '',
    '  def self.recur_alpha(n)',
    '    n <= 0 ? 0 : RecurB.recur_beta(n - 1)',
    '  end',
    'end',
  ]));
  push('recur_b.rb', j([
    "require_relative 'recur_c'",
    '',
    'module RecurB',
    '  def self.recur_self_b(n)',
    '    n <= 0 ? 0 : recur_self_b(n - 1)',
    '  end',
    '',
    '  def self.recur_beta(n)',
    '    n <= 0 ? 1 : RecurC.recur_gamma(n - 1)',
    '  end',
    'end',
  ]));
  push('recur_c.rb', j([
    "require_relative 'recur_a'",
    '',
    'module RecurC',
    '  def self.recur_gamma(n)',
    '    n <= 0 ? 2 : RecurA.recur_alpha(n - 1)',
    '  end',
    'end',
  ]));

  {
    const lines = ['# Generated: one huge file with many tiny methods.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `def f_${pad(i)}`,
        callsPrev ? `  f_${pad(i - 1)} + ${small(rng)}` : `  ${small(rng)}`,
        'end',
        '',
      );
    }
    push('huge.rb', j(lines));
  }

  push('minified.rb', j([
    `def long_line; ${chain(rng, c.longVars, (i, v) => `a${i}=${v}`, '; ')}; a0 + a${c.longVars - 1}; end`,
    '',
    `BLOB = [${blob(rng, c.blobLen)}].freeze`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = ['# Auto-generated style: numbered symbols and a case dispatch.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`def handler_${fp}_${pad(h)}`, `  ${int(rng, 10)}`, 'end', '');
    }
    lines.push(`def dispatch_${fp}(k)`, '  case k');
    for (let h = 0; h < c.handlers; h++) lines.push(`  when ${h} then handler_${fp}_${pad(h)}`);
    lines.push('  else -1', '  end', 'end');
    push(`generated_${fp}.rb`, j(lines));
  }

  push('traps.rb', j([
    'FAKE_DEF = "def fake; 1; end"',
    'HEREDOC = <<~CODE',
    '  def heredoc_fake(x)',
    '    x + 1',
    '  end',
    'CODE',
    "UNBALANCED = 'def broken(  # not code'",
    '',
    '=begin',
    'def block_comment_fake',
    '  :nope',
    'end',
    '=end',
    '# def comment_fake; 2; end',
    '',
    'def real_after_traps',
    '  FAKE_DEF.length + HEREDOC.length',
    'end',
  ]));

  push('empty.rb', '');
  push('tiny.rb', 'ONE = 1\n');
  push('comments_only.rb', j([
    '# This file contains only comments.',
    '# def nothing_here; 0; end',
  ]));
  push('bom.rb', `${BOM}def bom_fn\n  1\nend\n`);
  push('crlf.rb', 'def crlf_fn\n  2\nend\n'.replace(/\n/g, '\r\n'));

  push('cycle_a.rb', j([
    "require_relative 'cycle_b'",
    '',
    'module CycleA',
    '  def self.recur_cycle_a(n)',
    '    n <= 0 ? 0 : CycleB.recur_cycle_b(n - 1)',
    '  end',
    'end',
  ]));
  push('cycle_b.rb', j([
    "require_relative 'cycle_c'",
    '',
    'module CycleB',
    '  def self.recur_cycle_b(n)',
    '    n <= 0 ? 1 : CycleC.recur_cycle_c(n - 1)',
    '  end',
    'end',
  ]));
  push('cycle_c.rb', j([
    "require_relative 'cycle_a'",
    '',
    'module CycleC',
    '  def self.recur_cycle_c(n)',
    '    n <= 0 ? 2 : CycleA.recur_cycle_a(n - 1)',
    '  end',
    'end',
  ]));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = `Collide${pad(m % c.collide, 2)}`;
    push(`mixed_${fp}.rb`, j([
      `require_relative 'collide_${pad(m % c.collide, 2)}'`,
      '',
      `def use_${fp}`,
      `  ${target}.get + helper_${fp}`,
      'end',
      '',
      `def helper_${fp}`,
      `  ${small(rng)}`,
      'end',
    ]));
  }

  return files;
}

// --- Languages below are generated but not yet wired into the engine ---------

function genPhp(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });
  const head = (ns) => [`<?php`, '', `namespace Adv\\${ns};`, ''];

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    push(`collide_${pad(i, 2)}.php`, j([
      ...head(`Collide${pad(i, 2)}`),
      '// Adversarial: every collide namespace defines the same short names.',
      'function create(): int',
      '{',
      hasNext ? `    return \\Adv\\Collide${pad(i + 1, 2)}\\create() + 1;` : `    return ${small(rng)};`,
      '}',
      '',
      'function get(): int',
      '{',
      `    return ${small(rng)};`,
      '}',
      '',
      'function process(): int',
      '{',
      '    return get() + create();',
      '}',
    ]));
  }

  {
    const lines = [...head('Nesting'), 'function outermost(): int', '{'];
    for (let d = 1; d <= c.nestDepth; d++) {
      lines.push(`${'    '.repeat(d)}$level${d} = function (): int {`);
    }
    lines.push(`${'    '.repeat(c.nestDepth + 1)}return ${c.nestDepth};`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'    '.repeat(d)}};`);
      lines.push(`${'    '.repeat(d)}return $level${d}();`);
    }
    lines.push('}');
    push('nesting_a.php', j(lines));
  }

  push('unicode.php', j([
    ...head('Unicode'),
    'function café(): int',
    '{',
    `    return ${small(rng)};`,
    '}',
    '',
    'function déjà_vu(): int',
    '{',
    '    return café() + 1;',
    '}',
    '',
    'function x(): int',
    '{',
    '    $_ = 1;',
    '    $__weird__ = 2;',
    '    $_0 = 3;',
    '    return $_ + $__weird__ + $_0;',
    '}',
  ]));

  push('recur_a.php', j([
    ...head('RecurA'),
    'function recur_fact(int $n): int',
    '{',
    '    return $n <= 1 ? 1 : $n * recur_fact($n - 1);',
    '}',
    '',
    'function recur_alpha(int $n): int',
    '{',
    '    return $n <= 0 ? 0 : \\Adv\\RecurB\\recur_beta($n - 1);',
    '}',
  ]));
  push('recur_b.php', j([
    ...head('RecurB'),
    'function recur_beta(int $n): int',
    '{',
    '    return $n <= 0 ? 1 : \\Adv\\RecurC\\recur_gamma($n - 1);',
    '}',
  ]));
  push('recur_c.php', j([
    ...head('RecurC'),
    'function recur_gamma(int $n): int',
    '{',
    '    return $n <= 0 ? 2 : \\Adv\\RecurA\\recur_alpha($n - 1);',
    '}',
  ]));

  {
    const lines = [...head('Huge')];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `function f_${pad(i)}(): int`,
        '{',
        callsPrev ? `    return f_${pad(i - 1)}() + ${small(rng)};` : `    return ${small(rng)};`,
        '}',
      );
    }
    push('huge.php', j(lines));
  }

  push('minified.php', j([
    '<?php',
    '',
    'namespace Adv\\Minified;',
    '',
    `function long_line(): int { ${chain(rng, c.longVars, (i, v) => `$a${i}=${v};`, ' ')} return $a0 + $a${c.longVars - 1}; }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = [...head(`Gen${fp}`)];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`function handler_${pad(h)}(): int { return ${int(rng, 10)}; }`);
    }
    lines.push('', 'function dispatch(int $k): int', '{', '    switch ($k) {');
    for (let h = 0; h < c.handlers; h++) lines.push(`        case ${h}: return handler_${pad(h)}();`);
    lines.push('        default: return -1;', '    }', '}');
    push(`generated_${fp}.php`, j(lines));
  }

  push('traps.php', j([
    ...head('Traps'),
    "$fakeFn = 'function fake() { return 1; }';",
    '$heredoc = <<<\'CODE\'',
    'function heredoc_fake() {',
    '    return 1;',
    '}',
    'CODE;',
    '$unbalanced = "if ($x) { while (true) {";',
    '',
    '// function comment_fake() { return 2; }',
    '/* class CommentClass { function m() { return 3; } } */',
    '# function hash_comment_fake() { return 4; }',
    '',
    'function real_after_traps(): int',
    '{',
    "    return strlen('function fake() { return 1; }');",
    '}',
  ]));

  push('empty.php', '');
  push('tiny.php', '<?php\n\nconst ONE = 1;\n');
  push('comments_only.php', '<?php\n\n// This file contains only comments.\n/* function nothing_here() {} */\n');
  push('bom.php', `${BOM}<?php\n\nfunction bom_fn(): int\n{\n    return 1;\n}\n`);
  push('crlf.php', '<?php\n\nfunction crlf_fn(): int\n{\n    return 2;\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    push(`mixed_${fp}.php`, j([
      ...head(`Mixed${fp}`),
      `function use_${fp}(): int`,
      '{',
      `    return \\Adv\\Collide${target}\\get() + helper_${fp}();`,
      '}',
      '',
      `function helper_${fp}(): int`,
      '{',
      `    return ${small(rng)};`,
      '}',
    ]));
  }

  return files;
}

function genKotlin(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    push(`collide_${pad(i, 2)}.kt`, j([
      `package adv.collide${pad(i, 2)}`,
      '',
      '// Adversarial: every collide package defines the same top-level names.',
      'fun create(): Int =',
      hasNext ? `    adv.collide${pad(i + 1, 2)}.create() + 1` : `    ${small(rng)}`,
      '',
      `fun get(): Int = ${small(rng)}`,
      '',
      'fun process(): Int = get() + create()',
    ]));
  }

  {
    const lines = ['package adv.nesting', '', 'fun outermost(): Int {'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'    '.repeat(d)}fun level${d}(): Int {`);
    lines.push(`${'    '.repeat(c.nestDepth + 1)}return ${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'    '.repeat(d)}}`);
      lines.push(`${'    '.repeat(d)}return level${d}()`);
    }
    lines.push('}');
    push('nesting_a.kt', j(lines));
  }

  push('unicode.kt', j([
    'package adv.unicode',
    '',
    'val π = 3.14159',
    '',
    `fun café(): Int = ${small(rng)}`,
    '',
    'fun 名前(): Int = café() + 1',
    '',
    'fun `weird name with spaces`(): Int = 1',
    '',
    'fun `when`(): Int = `weird name with spaces`() + 1',
    '',
    'fun x(): Int = 2',
    '',
    'fun X(): Int = x() + 1',
  ]));

  push('recur_a.kt', j([
    'package adv.recura',
    '',
    'fun recurFact(n: Int): Int = if (n <= 1) 1 else n * recurFact(n - 1)',
    '',
    'fun recurAlpha(n: Int): Int = if (n <= 0) 0 else adv.recurb.recurBeta(n - 1)',
  ]));
  push('recur_b.kt', j([
    'package adv.recurb',
    '',
    'fun recurSelfB(n: Int): Int = if (n <= 0) 0 else recurSelfB(n - 1)',
    '',
    'fun recurBeta(n: Int): Int = if (n <= 0) 1 else adv.recurc.recurGamma(n - 1)',
  ]));
  push('recur_c.kt', j([
    'package adv.recurc',
    '',
    'fun recurGamma(n: Int): Int = if (n <= 0) 2 else adv.recura.recurAlpha(n - 1)',
  ]));

  {
    const lines = ['package adv.huge', ''];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(`fun f${pad(i)}(): Int = ${callsPrev ? `f${pad(i - 1)}() + ${small(rng)}` : small(rng)}`);
    }
    push('huge.kt', j(lines));
  }

  push('minified.kt', j([
    'package adv.minified',
    '',
    `fun longLine(): Int { ${chain(rng, c.longVars, (i, v) => `val a${i}=${v};`, ' ')} return a0 + a${c.longVars - 1} }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = [`package adv.gen${fp}`, ''];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`private fun handler${pad(h)}(): Int = ${int(rng, 10)}`);
    }
    lines.push('', 'fun dispatch(k: Int): Int = when (k) {');
    for (let h = 0; h < c.handlers; h++) lines.push(`    ${h} -> handler${pad(h)}()`);
    lines.push('    else -> -1', '}');
    push(`generated_${fp}.kt`, j(lines));
  }

  push('traps.kt', j([
    'package adv.traps',
    '',
    'const val FAKE_FN = "fun fake(): Int { return 1 }"',
    'val RAW = """',
    '    fun rawFake(): Int {',
    '        return 2 // } stray brace',
    '    }',
    '""".trimIndent()',
    '',
    '// fun commentFake(): Int = 2',
    '/* outer /* nested block comments are valid in kotlin: fun nestedFake() {} */ still comment */',
    '',
    'fun realAfterTraps(): Int = FAKE_FN.length + RAW.length',
  ]));

  push('empty.kt', '');
  push('tiny.kt', 'package adv.tiny\n\nconst val ONE = 1\n');
  push('comments_only.kt', '// This file contains only comments.\n/* fun nothingHere(): Int = 0 */\n');
  push('bom.kt', `${BOM}package adv.bom\n\nfun bomFn(): Int = 1\n`);
  push('crlf.kt', 'package adv.crlf\n\nfun crlfFn(): Int = 2\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    push(`mixed_${fp}.kt`, j([
      `package adv.mixed${fp}`,
      '',
      `fun use${fp}(): Int = adv.collide${target}.get() + helper${fp}()`,
      '',
      `private fun helper${fp}(): Int = ${small(rng)}`,
    ]));
  }

  return files;
}

function genSwift(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const en = `Collide${pad(i, 2)}`;
    push(`collide_${pad(i, 2)}.swift`, j([
      '// Adversarial: every Collide enum defines the same short method names.',
      `enum ${en} {`,
      '    static func create() -> Int {',
      hasNext ? `        return Collide${pad(i + 1, 2)}.create() + 1` : `        return ${small(rng)}`,
      '    }',
      '',
      '    static func get() -> Int {',
      `        return ${small(rng)}`,
      '    }',
      '',
      '    static func process() -> Int {',
      '        return get() + create()',
      '    }',
      '}',
    ]));
  }

  {
    const lines = ['enum NestingA {', '    static func outermost() -> Int {'];
    for (let d = 1; d <= c.nestDepth; d++) {
      lines.push(`${'    '.repeat(d + 1)}func level${d}() -> Int {`);
    }
    lines.push(`${'    '.repeat(c.nestDepth + 2)}return ${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'    '.repeat(d + 1)}}`);
      lines.push(`${'    '.repeat(d + 1)}return level${d}()`);
    }
    lines.push('    }', '}');
    push('nesting_a.swift', j(lines));
  }

  push('unicode.swift', j([
    'enum UnicodeIds {',
    '    static let π = 3.14159',
    '',
    '    static func café() -> Int {',
    `        return ${small(rng)}`,
    '    }',
    '',
    '    static func déjàVu() -> Int {',
    '        return café() + 1',
    '    }',
    '',
    '    static func x() -> Int {',
    '        return 2',
    '    }',
    '',
    '    // Differs from x only by case.',
    '    static func X() -> Int {',
    '        return x() + 1',
    '    }',
    '',
    '    static func `default`() -> Int {',
    '        return X()',
    '    }',
    '}',
  ]));

  push('recur_a.swift', j([
    'enum RecurA {',
    '    static func recurFact(_ n: Int) -> Int {',
    '        return n <= 1 ? 1 : n * recurFact(n - 1)',
    '    }',
    '',
    '    static func recurAlpha(_ n: Int) -> Int {',
    '        return n <= 0 ? 0 : RecurB.recurBeta(n - 1)',
    '    }',
    '}',
  ]));
  push('recur_b.swift', j([
    'enum RecurB {',
    '    static func recurSelfB(_ n: Int) -> Int {',
    '        return n <= 0 ? 0 : recurSelfB(n - 1)',
    '    }',
    '',
    '    static func recurBeta(_ n: Int) -> Int {',
    '        return n <= 0 ? 1 : RecurC.recurGamma(n - 1)',
    '    }',
    '}',
  ]));
  push('recur_c.swift', j([
    'enum RecurC {',
    '    static func recurGamma(_ n: Int) -> Int {',
    '        return n <= 0 ? 2 : RecurA.recurAlpha(n - 1)',
    '    }',
    '}',
  ]));

  {
    const lines = ['enum Huge {'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `    static func f${pad(i)}() -> Int { return ${callsPrev ? `f${pad(i - 1)}() + ${small(rng)}` : small(rng)} }`,
      );
    }
    lines.push('}');
    push('huge.swift', j(lines));
  }

  push('minified.swift', j([
    `enum Minified { static func longLine() -> Int { ${chain(rng, c.longVars, (i, v) => `let a${i} = ${v};`, ' ')} return a0 + a${c.longVars - 1} } }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const en = `Generated${pad(g, 2)}`;
    const lines = [`enum ${en} {`];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`    static func handler${pad(h)}() -> Int { return ${int(rng, 10)} }`);
    }
    lines.push('', '    static func dispatch(_ k: Int) -> Int {', '        switch k {');
    for (let h = 0; h < c.handlers; h++) lines.push(`        case ${h}: return handler${pad(h)}()`);
    lines.push('        default: return -1', '        }', '    }', '}');
    push(`generated_${pad(g, 2)}.swift`, j(lines));
  }

  push('traps.swift', j([
    'enum Traps {',
    '    static let fakeFn = "func fake() -> Int { return 1 }"',
    '    static let multi = """',
    '        func multilineFake() -> Int {',
    '            return 2 // } stray brace',
    '        }',
    '        """',
    '',
    '    // func commentFake() -> Int { return 3 }',
    '    /* outer /* nested block comments are valid in swift: func nestedFake() {} */ still comment */',
    '',
    '    static func realAfterTraps() -> Int {',
    '        return fakeFn.count + multi.count',
    '    }',
    '}',
  ]));

  push('empty.swift', '');
  push('tiny.swift', 'let one = 1\n');
  push('comments_only.swift', '// This file contains only comments.\n/* func nothingHere() -> Int { return 0 } */\n');
  push('bom.swift', `${BOM}enum Bom {\n    static func bomFn() -> Int {\n        return 1\n    }\n}\n`);
  push('crlf.swift', 'enum Crlf {\n    static func crlfFn() -> Int {\n        return 2\n    }\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = `Collide${pad(m % c.collide, 2)}`;
    push(`mixed_${fp}.swift`, j([
      `enum Mixed${fp} {`,
      `    static func use${fp}() -> Int {`,
      `        return ${target}.get() + helper${fp}()`,
      '    }',
      '',
      `    static func helper${fp}() -> Int {`,
      `        return ${small(rng)}`,
      '    }',
      '}',
    ]));
  }

  return files;
}

function genScala(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const obj = `Collide${pad(i, 2)}`;
    push(`collide_${pad(i, 2)}.scala`, j([
      'package adv',
      '',
      '// Adversarial: every Collide object defines the same short method names.',
      `object ${obj} {`,
      '  def create(): Int =',
      hasNext ? `    Collide${pad(i + 1, 2)}.create() + 1` : `    ${small(rng)}`,
      '',
      `  def get(): Int = ${small(rng)}`,
      '',
      '  def process(): Int = get() + create()',
      '}',
    ]));
  }

  {
    const lines = ['package adv', '', 'object NestingA {', '  def outermost(): Int = {'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'  '.repeat(d + 1)}def level${d}(): Int = {`);
    lines.push(`${'  '.repeat(c.nestDepth + 2)}${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'  '.repeat(d + 1)}}`);
      lines.push(`${'  '.repeat(d + 1)}level${d}()`);
    }
    lines.push('  }', '}');
    push('nesting_a.scala', j(lines));
  }

  push('unicode.scala', j([
    'package adv',
    '',
    'object UnicodeIds {',
    '  val π = 3.14159',
    '',
    `  def café(): Int = ${small(rng)}`,
    '',
    '  def déjàVu(): Int = café() + 1',
    '',
    '  def `weird name with spaces`(): Int = 1',
    '',
    '  def x(): Int = 2',
    '',
    '  // Differs from x only by case.',
    '  def X(): Int = x() + 1',
    '}',
  ]));

  push('recur_a.scala', j([
    'package adv',
    '',
    'object RecurA {',
    '  def recurFact(n: Int): Int = if (n <= 1) 1 else n * recurFact(n - 1)',
    '',
    '  def recurAlpha(n: Int): Int = if (n <= 0) 0 else RecurB.recurBeta(n - 1)',
    '}',
  ]));
  push('recur_b.scala', j([
    'package adv',
    '',
    'object RecurB {',
    '  def recurSelfB(n: Int): Int = if (n <= 0) 0 else recurSelfB(n - 1)',
    '',
    '  def recurBeta(n: Int): Int = if (n <= 0) 1 else RecurC.recurGamma(n - 1)',
    '}',
  ]));
  push('recur_c.scala', j([
    'package adv',
    '',
    'object RecurC {',
    '  def recurGamma(n: Int): Int = if (n <= 0) 2 else RecurA.recurAlpha(n - 1)',
    '}',
  ]));

  {
    const lines = ['package adv', '', 'object Huge {'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(`  def f${pad(i)}(): Int = ${callsPrev ? `f${pad(i - 1)}() + ${small(rng)}` : small(rng)}`);
    }
    lines.push('}');
    push('huge.scala', j(lines));
  }

  push('minified.scala', j([
    'package adv',
    '',
    `object Minified { def longLine(): Int = { ${chain(rng, c.longVars, (i, v) => `val a${i} = ${v};`, ' ')} a0 + a${c.longVars - 1} } }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const obj = `Generated${pad(g, 2)}`;
    const lines = ['package adv', '', `object ${obj} {`];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`  private def handler${pad(h)}(): Int = ${int(rng, 10)}`);
    }
    lines.push('', '  def dispatch(k: Int): Int = k match {');
    for (let h = 0; h < c.handlers; h++) lines.push(`    case ${h} => handler${pad(h)}()`);
    lines.push('    case _ => -1', '  }', '}');
    push(`generated_${pad(g, 2)}.scala`, j(lines));
  }

  push('traps.scala', j([
    'package adv',
    '',
    'object Traps {',
    '  val fakeFn = "def fake(): Int = 1"',
    '  val triple = """',
    '    def tripleFake(): Int = {',
    '      2 // } stray brace',
    '    }',
    '  """',
    '',
    '  // def commentFake(): Int = 2',
    '  /* outer /* nested block comments are valid in scala: def nestedFake() = 0 */ still comment */',
    '',
    '  def realAfterTraps(): Int = fakeFn.length + triple.length',
    '}',
  ]));

  push('empty.scala', '');
  push('tiny.scala', 'package adv\n\nobject Tiny { val one = 1 }\n');
  push('comments_only.scala', '// This file contains only comments.\n/* def nothingHere(): Int = 0 */\n');
  push('bom.scala', `${BOM}package adv\n\nobject Bom {\n  def bomFn(): Int = 1\n}\n`);
  push('crlf.scala', 'package adv\n\nobject Crlf {\n  def crlfFn(): Int = 2\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = `Collide${pad(m % c.collide, 2)}`;
    push(`mixed_${fp}.scala`, j([
      'package adv',
      '',
      `object Mixed${fp} {`,
      `  def use${fp}(): Int = ${target}.get() + helper${fp}()`,
      '',
      `  private def helper${fp}(): Int = ${small(rng)}`,
      '}',
    ]));
  }

  return files;
}

function genDart(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  // NOTE: `get` is a built-in identifier in Dart (getter syntax), so the
  // collision trio here is create/fetch/process.
  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const lines = [];
    if (hasNext) lines.push(`import 'collide_${pad(i + 1, 2)}.dart' as other;`, '');
    lines.push(
      '// Adversarial: every collide_* library defines the same short names.',
      hasNext ? 'int create() => other.create() + 1;' : `int create() => ${small(rng)};`,
      '',
      `int fetch() => ${small(rng)};`,
      '',
      'int process() => fetch() + create();',
    );
    push(`collide_${pad(i, 2)}.dart`, j(lines));
  }

  {
    const lines = ['int outermost() {'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'  '.repeat(d)}int level${d}() {`);
    lines.push(`${'  '.repeat(c.nestDepth + 1)}return ${c.nestDepth};`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'  '.repeat(d)}}`);
      lines.push(`${'  '.repeat(d)}return level${d}();`);
    }
    lines.push('}');
    push('nesting_a.dart', j(lines));
  }

  push('weird_ids.dart', j([
    '// Dart identifiers are ASCII + $ + _ only, so this file leans on $/_ names.',
    `int \$get\$() => ${small(rng)};`,
    '',
    'int \$_\$() => \$get\$() + 1;',
    '',
    'int __severely__underscored__() => \$_\$();',
    '',
    'int x() => 2;',
    '',
    '// Differs from x only by case.',
    'int X() => x() + 1;',
  ]));

  push('recur_a.dart', j([
    "import 'recur_b.dart' as rb;",
    '',
    'int recurFact(int n) => n <= 1 ? 1 : n * recurFact(n - 1);',
    '',
    'int recurAlpha(int n) => n <= 0 ? 0 : rb.recurBeta(n - 1);',
  ]));
  push('recur_b.dart', j([
    "import 'recur_c.dart' as rc;",
    '',
    'int recurSelfB(int n) => n <= 0 ? 0 : recurSelfB(n - 1);',
    '',
    'int recurBeta(int n) => n <= 0 ? 1 : rc.recurGamma(n - 1);',
  ]));
  push('recur_c.dart', j([
    "import 'recur_a.dart' as ra;",
    '',
    'int recurGamma(int n) => n <= 0 ? 2 : ra.recurAlpha(n - 1);',
  ]));

  {
    const lines = ['// Generated: one huge file with many tiny functions.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(`int f${pad(i)}() => ${callsPrev ? `f${pad(i - 1)}() + ${small(rng)}` : small(rng)};`);
    }
    push('huge.dart', j(lines));
  }

  push('minified.dart', j([
    `int longLine() { var ${chain(rng, c.longVars, (i, v) => `a${i} = ${v}`, ', ')}; return a0 + a${c.longVars - 1}; }`,
    `const blobList = [${blob(rng, c.blobLen)}];`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = ['// Auto-generated style: numbered symbols and a switch dispatch.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`int handler${fp}x${pad(h)}() => ${int(rng, 10)};`);
    }
    lines.push('', `int dispatch${fp}(int k) {`, '  switch (k) {');
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`    case ${h}:`, `      return handler${fp}x${pad(h)}();`);
    }
    lines.push('    default:', '      return -1;', '  }', '}');
    push(`generated_${fp}.dart`, j(lines));
  }

  push('traps.dart', j([
    "const fakeFn = 'int fake() { return 1; }';",
    'const fakeClass = "class Fake { int m() => 1; }";',
    "const unbalanced = 'if (x) { while (true) {';",
    "const multi = '''",
    'int multilineFake() {',
    '  return 2; // } stray brace',
    '}',
    "''';",
    '',
    '// int commentFake() => 2;',
    '/* class CommentClass { int m() => 3; } */',
    '',
    'int realAfterTraps() => fakeFn.length + multi.length;',
  ]));

  push('empty.dart', '');
  push('tiny.dart', 'const one = 1;\n');
  push('comments_only.dart', '// This file contains only comments.\n/* int nothingHere() => 0; */\n');
  push('bom.dart', `${BOM}int bomFn() => 1;\n`);
  push('crlf.dart', 'int crlfFn() => 2;\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    push(`mixed_${fp}.dart`, j([
      `import 'collide_${target}.dart' as c${target};`,
      '',
      `int use${fp}() => c${target}.fetch() + _helper${fp}();`,
      '',
      `int _helper${fp}() => ${small(rng)};`,
    ]));
  }

  return files;
}

function genLua(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const lines = [];
    if (hasNext) lines.push(`local other = require("collide_${pad(i + 1, 2)}")`, '');
    lines.push(
      '-- Adversarial: every collide_* module exports the same short names.',
      'local M = {}',
      '',
      'function M.create()',
      hasNext ? '  return other.create() + 1' : `  return ${small(rng)}`,
      'end',
      '',
      'function M.get()',
      `  return ${small(rng)}`,
      'end',
      '',
      'function M.process()',
      '  return M.get() + M.create()',
      'end',
      '',
      'return M',
    );
    push(`collide_${pad(i, 2)}.lua`, j(lines));
  }

  {
    const lines = ['local function outermost()'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'  '.repeat(d)}local function level${d}()`);
    lines.push(`${'  '.repeat(c.nestDepth + 1)}return ${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'  '.repeat(d)}end`);
      lines.push(`${'  '.repeat(d)}return level${d}()`);
    }
    lines.push('end', '', 'return outermost');
    push('nesting_a.lua', j(lines));
  }

  push('weird_ids.lua', j([
    '-- Lua identifiers are ASCII-only; this file leans on _ and case games.',
    'local _ = 1',
    'local __severely__underscored__ = 2',
    '',
    'local function x()',
    '  return 2',
    'end',
    '',
    '-- Differs from x only by case.',
    'local function X()',
    '  return x() + _ + __severely__underscored__',
    'end',
    '',
    'return { x = x, X = X }',
  ]));

  push('recur_a.lua', j([
    'local rb = require("recur_b")',
    '',
    'local M = {}',
    '',
    'local function recur_fact(n)',
    '  if n <= 1 then',
    '    return 1',
    '  end',
    '  return n * recur_fact(n - 1)',
    'end',
    '',
    'function M.recur_alpha(n)',
    '  if n <= 0 then',
    '    return 0',
    '  end',
    '  return rb.recur_beta(n - 1)',
    'end',
    '',
    'M.recur_fact = recur_fact',
    'return M',
  ]));
  push('recur_b.lua', j([
    'local rc = require("recur_c")',
    '',
    'local M = {}',
    '',
    'local function recur_self_b(n)',
    '  if n <= 0 then',
    '    return 0',
    '  end',
    '  return recur_self_b(n - 1)',
    'end',
    '',
    'function M.recur_beta(n)',
    '  if n <= 0 then',
    '    return 1',
    '  end',
    '  return rc.recur_gamma(n - 1)',
    'end',
    '',
    'M.recur_self_b = recur_self_b',
    'return M',
  ]));
  push('recur_c.lua', j([
    '-- NOTE: no require("recur_a") here — a lua require cycle recurses at',
    '-- runtime, so the third hop resolves lazily inside the function.',
    'local M = {}',
    '',
    'function M.recur_gamma(n)',
    '  if n <= 0 then',
    '    return 2',
    '  end',
    '  return require("recur_a").recur_alpha(n - 1)',
    'end',
    '',
    'return M',
  ]));

  {
    const lines = ['-- Generated: one huge file with many tiny functions.', 'local M = {}', ''];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `function M.f_${pad(i)}()`,
        callsPrev ? `  return M.f_${pad(i - 1)}() + ${small(rng)}` : `  return ${small(rng)}`,
        'end',
      );
    }
    lines.push('', 'return M');
    push('huge.lua', j(lines));
  }

  push('minified.lua', j([
    `local function long_line() ${chain(rng, c.longVars, (i, v) => `local a${i}=${v}`, ' ')} return a0 + a${c.longVars - 1} end`,
    `local blob_list = {${blob(rng, c.blobLen)}}`,
    'return { long_line = long_line, blob_list = blob_list }',
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = ['-- Auto-generated style: numbered symbols and a dispatch table.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`local function handler_${pad(h)}()`, `  return ${int(rng, 10)}`, 'end');
    }
    lines.push('', 'local handlers = {');
    for (let h = 0; h < c.handlers; h++) lines.push(`  [${h}] = handler_${pad(h)},`);
    lines.push('}', '');
    lines.push(`local function dispatch_${fp}(k)`);
    lines.push('  local h = handlers[k]');
    lines.push('  if h then');
    lines.push('    return h()');
    lines.push('  end');
    lines.push('  return -1');
    lines.push('end', '');
    lines.push(`return { dispatch = dispatch_${fp} }`);
    push(`generated_${fp}.lua`, j(lines));
  }

  push('traps.lua', j([
    'local fake_fn = "function fake() return 1 end"',
    "local fake_class = 'local Fake = {} function Fake.m() return 1 end'",
    'local block = [[',
    'function long_bracket_fake()',
    '  return 2 -- ]] does not close because of the leveled bracket below',
    ']]',
    'local leveled = [==[',
    'contains ]] and --[[ inside a level-2 long bracket',
    ']==]',
    '',
    '-- function comment_fake() return 3 end',
    '--[[ function block_comment_fake()',
    '  return 4',
    'end ]]',
    '--[==[ nested-looking --[[ markers ]] inside a leveled comment ]==]',
    '',
    'local function real_after_traps()',
    '  return #fake_fn + #block + #leveled + #fake_class',
    'end',
    '',
    'return { real_after_traps = real_after_traps }',
  ]));

  push('empty.lua', '');
  push('tiny.lua', 'return 1\n');
  push('comments_only.lua', '-- This file contains only comments.\n--[[ function nothing_here() return 0 end ]]\n');
  push('bom.lua', `${BOM}local function bom_fn()\n  return 1\nend\n\nreturn bom_fn\n`);
  push('crlf.lua', 'local function crlf_fn()\n  return 2\nend\n\nreturn crlf_fn\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    push(`mixed_${fp}.lua`, j([
      `local c${target} = require("collide_${target}")`,
      '',
      `local function helper_${fp}()`,
      `  return ${small(rng)}`,
      'end',
      '',
      `local function use_${fp}()`,
      `  return c${target}.get() + helper_${fp}()`,
      'end',
      '',
      `return { use_${fp} = use_${fp} }`,
    ]));
  }

  return files;
}

function genElixir(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const mod = `Adv.Collide${pad(i, 2)}`;
    push(`collide_${pad(i, 2)}.ex`, j([
      '# Adversarial: every Collide module defines the same short names.',
      `defmodule ${mod} do`,
      '  def create do',
      hasNext ? `    Adv.Collide${pad(i + 1, 2)}.create() + 1` : `    ${small(rng)}`,
      '  end',
      '',
      '  def get do',
      `    ${small(rng)}`,
      '  end',
      '',
      '  def process do',
      '    get() + create()',
      '  end',
      'end',
    ]));
  }

  {
    const lines = ['defmodule Adv.Nesting do', '  def outermost do'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'  '.repeat(d + 1)}level${d} = fn ->`);
    lines.push(`${'  '.repeat(c.nestDepth + 2)}${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'  '.repeat(d + 1)}end`);
      lines.push(`${'  '.repeat(d + 1)}level${d}.()`);
    }
    lines.push('  end', '', '  defmodule Inner do', '    defmodule Deeper do',
      '      def deep do', '        6', '      end', '    end', '  end', 'end');
    push('nesting_a.ex', j(lines));
  }

  push('unicode.ex', j([
    'defmodule Adv.Unicode do',
    '  def café do',
    `    ${small(rng)}`,
    '  end',
    '',
    '  def déjà_vu do',
    '    café() + 1',
    '  end',
    '',
    '  def x do',
    '    2',
    '  end',
    '',
    '  def __severely__underscored__ do',
    '    x() + 1',
    '  end',
    'end',
  ]));

  push('recur_a.ex', j([
    'defmodule Adv.RecurA do',
    '  def recur_fact(n) when n <= 1, do: 1',
    '  def recur_fact(n), do: n * recur_fact(n - 1)',
    '',
    '  def recur_alpha(n) when n <= 0, do: 0',
    '  def recur_alpha(n), do: Adv.RecurB.recur_beta(n - 1)',
    'end',
  ]));
  push('recur_b.ex', j([
    'defmodule Adv.RecurB do',
    '  def recur_self_b(n) when n <= 0, do: 0',
    '  def recur_self_b(n), do: recur_self_b(n - 1)',
    '',
    '  def recur_beta(n) when n <= 0, do: 1',
    '  def recur_beta(n), do: Adv.RecurC.recur_gamma(n - 1)',
    'end',
  ]));
  push('recur_c.ex', j([
    'defmodule Adv.RecurC do',
    '  def recur_gamma(n) when n <= 0, do: 2',
    '  def recur_gamma(n), do: Adv.RecurA.recur_alpha(n - 1)',
    'end',
  ]));

  {
    const lines = ['defmodule Adv.Huge do'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(`  def f_${pad(i)}, do: ${callsPrev ? `f_${pad(i - 1)}() + ${small(rng)}` : small(rng)}`);
    }
    lines.push('end');
    push('huge.ex', j(lines));
  }

  {
    const sum = chain(rng, c.longVars, (_i, v) => String(v), ' + ');
    push('minified.ex', j([
      'defmodule Adv.Minified do',
      `  def long_line, do: ${sum}`,
      `  def blob_list, do: [${blob(rng, c.blobLen)}]`,
      'end',
    ]));
  }

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = [`defmodule Adv.Generated${fp} do`];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`  defp handler_${pad(h)}, do: ${int(rng, 10)}`);
    }
    lines.push('', '  def dispatch(k) do', '    case k do');
    for (let h = 0; h < c.handlers; h++) lines.push(`      ${h} -> handler_${pad(h)}()`);
    lines.push('      _ -> -1', '    end', '  end', 'end');
    push(`generated_${fp}.ex`, j(lines));
  }

  push('traps.ex', j([
    'defmodule Adv.Traps do',
    '  @fake_def "def fake, do: 1"',
    '  @heredoc """',
    '  def heredoc_fake(x) do',
    '    x + 1',
    '  end',
    '  """',
    '  @sigil ~S(def sigil_fake, do: "no interpolation #{here}")',
    '',
    '  # def comment_fake, do: 2',
    '  # end of nothing',
    '',
    '  def real_after_traps do',
    '    String.length(@fake_def) + String.length(@heredoc) + String.length(@sigil)',
    '  end',
    'end',
  ]));

  push('empty.ex', '');
  push('tiny.ex', 'defmodule Adv.Tiny do\n  @one 1\n  def one, do: @one\nend\n');
  push('comments_only.ex', '# This file contains only comments.\n# def nothing_here, do: 0\n');
  push('bom.ex', `${BOM}defmodule Adv.Bom do\n  def bom_fn, do: 1\nend\n`);
  push('crlf.ex', 'defmodule Adv.Crlf do\n  def crlf_fn, do: 2\nend\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = `Adv.Collide${pad(m % c.collide, 2)}`;
    push(`mixed_${fp}.ex`, j([
      `defmodule Adv.Mixed${fp} do`,
      `  def use_${fp} do`,
      `    ${target}.get() + helper_${fp}()`,
      '  end',
      '',
      `  defp helper_${fp}, do: ${small(rng)}`,
      'end',
    ]));
  }

  return files;
}

function genBash(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });
  const shebang = '#!/usr/bin/env bash';

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const lines = [shebang, '# Adversarial: every collide_* script defines the same function names.'];
    if (hasNext) {
      lines.push(
        `# shellcheck source=collide_${pad(i + 1, 2)}.sh`,
        `source "$(dirname "$0")/collide_${pad(i + 1, 2)}.sh"`,
        '',
      );
    }
    lines.push(
      'create() {',
      hasNext ? '  create_downstream' : `  printf '%s\\n' ${small(rng)}`,
      '}',
      '',
    );
    if (hasNext) {
      lines.push('create_downstream() {', `  printf '%s\\n' ${small(rng)}`, '}', '');
    }
    lines.push(
      'get() {',
      `  printf '%s\\n' ${small(rng)}`,
      '}',
      '',
      'process() {',
      '  get',
      '  create',
      '}',
    );
    push(`collide_${pad(i, 2)}.sh`, j(lines));
  }

  {
    const lines = [shebang, 'outermost() {'];
    for (let d = 1; d <= c.nestDepth; d++) lines.push(`${'  '.repeat(d)}level${d}() {`);
    lines.push(`${'  '.repeat(c.nestDepth + 1)}printf '%s\\n' ${c.nestDepth}`);
    for (let d = c.nestDepth; d >= 1; d--) {
      lines.push(`${'  '.repeat(d)}}`);
      lines.push(`${'  '.repeat(d)}level${d}`);
    }
    lines.push('}');
    push('nesting_a.sh', j(lines));
  }

  push('weird_ids.sh', j([
    shebang,
    '# Bash function names here stick to portable ASCII + underscores.',
    '_() {',
    "  printf '%s\\n' 1",
    '}',
    '',
    'x() {',
    "  printf '%s\\n' 2",
    '}',
    '',
    '# Differs from x only by case.',
    'X() {',
    '  x',
    '}',
    '',
    '__severely__underscored__() {',
    '  X',
    '  _',
    '}',
  ]));

  push('recur_a.sh', j([
    shebang,
    'recur_count() {',
    '  if [ "$1" -le 0 ]; then',
    "    printf '%s\\n' 0",
    '  else',
    '    recur_count $(( $1 - 1 ))',
    '  fi',
    '}',
    '',
    'recur_alpha() {',
    '  recur_beta "$1"',
    '}',
  ]));
  push('recur_b.sh', j([
    shebang,
    'recur_beta() {',
    '  recur_gamma "$1"',
    '}',
  ]));
  push('recur_c.sh', j([
    shebang,
    'recur_gamma() {',
    '  if [ "$1" -le 0 ]; then',
    "    printf '%s\\n' 2",
    '  else',
    '    recur_alpha $(( $1 - 1 ))',
    '  fi',
    '}',
  ]));

  {
    const lines = [shebang, '# Generated: one huge file with many tiny functions.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `f_${pad(i)}() {`,
        callsPrev ? `  f_${pad(i - 1)}` : `  printf '%s\\n' ${small(rng)}`,
        '}',
      );
    }
    push('huge.sh', j(lines));
  }

  push('minified.sh', j([
    shebang,
    `long_line() { ${chain(rng, c.longVars, (i, v) => `a${i}=${v};`, ' ')} printf '%s\\n' "$(( a0 + a${c.longVars - 1} ))"; }`,
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = [shebang];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`handler_${fp}_${pad(h)}() { printf '%s\\n' ${int(rng, 10)}; }`);
    }
    // NOTE: an if/elif chain, not `case`: the bundled tree-sitter-bash wasm
    // crashes web-tree-sitter 0.25.x ("resolved is not a function") on any
    // `case ... esac`, so a case dispatch would abort the parse outright.
    lines.push('', `dispatch_${fp}() {`);
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`  ${h === 0 ? 'if' : 'elif'} [ "$1" -eq ${h} ]; then`, `    handler_${fp}_${pad(h)}`);
    }
    lines.push('  else', "    printf '%s\\n' -1", '  fi', '}');
    push(`generated_${fp}.sh`, j(lines));
  }

  push('traps.sh', j([
    shebang,
    'FAKE_FN=\'function fake() {\'',
    'SNIPPET=$(cat <<\'EOF\'',
    'function heredoc_fake() {',
    '  echo "}"',
    '}',
    'EOF',
    ')',
    'UNBALANCED="if [ x ]; then {"',
    '',
    '# function comment_fake() { echo 2; }',
    '# } stray brace in a comment',
    '',
    'real_after_traps() {',
    '  printf \'%s\\n\' "${#FAKE_FN} ${#SNIPPET} ${#UNBALANCED}"',
    '}',
  ]));

  push('empty.sh', '');
  push('tiny.sh', 'ONE=1\n');
  push('comments_only.sh', '# This file contains only comments.\n# nothing_here() { :; }\n');
  push('bom.sh', `${BOM}bom_fn() {\n  printf '%s\\n' 1\n}\n`);
  // NOTE: bash rejects CRLF around control-flow tokens, so the CRLF file is
  // limited to comments and a plain assignment (the \r lands in the value).
  push('crlf.sh', '# CRLF-terminated bash file: only comments and assignments are CRLF-safe.\nCRLF_ONE=1\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    push(`mixed_${fp}.sh`, j([
      shebang,
      `use_${fp}() {`,
      '  get',
      `  helper_${fp}`,
      '}',
      '',
      `helper_${fp}() {`,
      `  printf '%s\\n' ${small(rng)}`,
      '}',
    ]));
  }

  return files;
}

function genZig(scale, rng) {
  const c = counts(scale);
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const lines = ['// Adversarial: every collide_* file exports the same short names.'];
    if (hasNext) lines.push(`const other = @import("collide_${pad(i + 1, 2)}.zig");`, '');
    lines.push(
      'pub fn create() i32 {',
      hasNext ? '    return other.create() + 1;' : `    return ${small(rng)};`,
      '}',
      '',
      'pub fn get() i32 {',
      `    return ${small(rng)};`,
      '}',
      '',
      'pub fn process() i32 {',
      '    return get() + create();',
      '}',
    );
    push(`collide_${pad(i, 2)}.zig`, j(lines));
  }

  {
    // Zig has no nested functions; nest structs instead.
    const lines = [];
    for (let d = 1; d <= 6; d++) lines.push(`${'    '.repeat(d - 1)}pub const L${d} = struct {`);
    lines.push(`${'    '.repeat(6)}pub fn deep() i32 {`);
    lines.push(`${'    '.repeat(7)}return 6;`);
    lines.push(`${'    '.repeat(6)}}`);
    for (let d = 6; d >= 1; d--) lines.push(`${'    '.repeat(d - 1)}};`);
    lines.push('');
    lines.push('pub fn outermost() i32 {');
    lines.push('    return L1.L2.L3.L4.L5.L6.deep();');
    lines.push('}');
    push('nesting_a.zig', j(lines));
  }

  push('weird_ids.zig', j([
    '// Zig identifiers are ASCII, but @"..." quoting allows anything.',
    'pub fn @"weird name with spaces"() i32 {',
    '    return 1;',
    '}',
    '',
    'pub fn @"café quoted"() i32 {',
    '    return @"weird name with spaces"() + 1;',
    '}',
    '',
    'pub fn x() i32 {',
    '    return 2;',
    '}',
    '',
    '// Differs from x only by case.',
    'pub fn X() i32 {',
    '    return x() + 1;',
    '}',
  ]));

  push('recur_a.zig', j([
    'const rb = @import("recur_b.zig");',
    '',
    'pub fn recurFact(n: i32) i32 {',
    '    if (n <= 1) return 1;',
    '    return n * recurFact(n - 1);',
    '}',
    '',
    'pub fn recurAlpha(n: i32) i32 {',
    '    if (n <= 0) return 0;',
    '    return rb.recurBeta(n - 1);',
    '}',
  ]));
  push('recur_b.zig', j([
    'const rc = @import("recur_c.zig");',
    '',
    'pub fn recurSelfB(n: i32) i32 {',
    '    if (n <= 0) return 0;',
    '    return recurSelfB(n - 1);',
    '}',
    '',
    'pub fn recurBeta(n: i32) i32 {',
    '    if (n <= 0) return 1;',
    '    return rc.recurGamma(n - 1);',
    '}',
  ]));
  push('recur_c.zig', j([
    'const ra = @import("recur_a.zig");',
    '',
    'pub fn recurGamma(n: i32) i32 {',
    '    if (n <= 0) return 2;',
    '    return ra.recurAlpha(n - 1);',
    '}',
  ]));

  {
    const lines = ['// Generated: one huge file with many tiny functions.'];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `pub fn f${pad(i)}() i32 {`,
        callsPrev ? `    return f${pad(i - 1)}() + ${small(rng)};` : `    return ${small(rng)};`,
        '}',
      );
    }
    push('huge.zig', j(lines));
  }

  {
    // Zig errors on unused locals, so the long line is one giant expression.
    const sum = chain(rng, c.longVars, (_i, v) => String(v), ' + ');
    push('minified.zig', j([
      `pub fn longLine() i32 { return ${sum}; }`,
      `pub const blob = [_]i32{${blob(rng, c.blobLen)}};`,
    ]));
  }

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = ['// Auto-generated style: numbered symbols and a switch dispatch.'];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`fn handler${pad(h)}() i32 { return ${int(rng, 10)}; }`);
    }
    lines.push('', `pub fn dispatch${fp}(k: i32) i32 {`, '    return switch (k) {');
    for (let h = 0; h < c.handlers; h++) lines.push(`        ${h} => handler${pad(h)}(),`);
    lines.push('        else => -1,', '    };', '}');
    push(`generated_${fp}.zig`, j(lines));
  }

  push('traps.zig', j([
    'pub const fake_fn = "pub fn fake() i32 { return 1; }";',
    'pub const multi =',
    '    \\\\pub fn multilineFake() i32 {',
    '    \\\\    return 2; // } stray brace',
    '    \\\\}',
    ';',
    '',
    '// pub fn commentFake() i32 { return 3; } (zig has line comments only)',
    '',
    'pub fn realAfterTraps() usize {',
    '    return fake_fn.len + multi.len;',
    '}',
  ]));

  push('empty.zig', '');
  push('tiny.zig', 'pub const one: i32 = 1;\n');
  push('comments_only.zig', '// This file contains only comments.\n// pub fn nothingHere() i32 { return 0; }\n');
  push('bom.zig', `${BOM}pub fn bomFn() i32 {\n    return 1;\n}\n`);
  push('crlf.zig', 'pub fn crlfFn() i32 {\n    return 2;\n}\n'.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    push(`mixed_${fp}.zig`, j([
      `const c${target} = @import("collide_${target}.zig");`,
      '',
      `pub fn use${fp}() i32 {`,
      `    return c${target}.get() + helper${fp}();`,
      '}',
      '',
      `fn helper${fp}() i32 {`,
      `    return ${small(rng)};`,
      '}',
    ]));
  }

  return files;
}

function genC(scale, rng, cpp = false) {
  const c = counts(scale);
  const ext = cpp ? 'cpp' : 'c';
  const files = [];
  const push = (rel, content) => files.push({ rel, content });

  for (let i = 0; i < c.collide; i++) {
    const hasNext = i < c.collide - 1;
    const fp = pad(i, 2);
    if (cpp) {
      const lines = ['// Adversarial: every collide namespace defines the same short names.'];
      if (hasNext) {
        lines.push(`namespace collide${pad(i + 1, 2)} { int create(); }`, '');
      }
      lines.push(
        `namespace collide${fp} {`,
        '',
        'int get() {',
        `    return ${small(rng)};`,
        '}',
        '',
        'int create() {',
        hasNext ? `    return collide${pad(i + 1, 2)}::create() + 1;` : `    return ${small(rng)};`,
        '}',
        '',
        'int process() {',
        '    return get() + create();',
        '}',
        '',
        `}  // namespace collide${fp}`,
      );
      push(`collide_${fp}.${ext}`, j(lines));
    } else {
      const lines = [
        '/* Adversarial: every collide_* file defines the same static names. */',
      ];
      if (hasNext) lines.push(`int collide_${pad(i + 1, 2)}_entry(void);`, '');
      lines.push(
        'static int get(void) {',
        `    return ${small(rng)};`,
        '}',
        '',
        'static int create(void) {',
        hasNext ? `    return collide_${pad(i + 1, 2)}_entry() + 1;` : `    return ${small(rng)};`,
        '}',
        '',
        'static int process(void) {',
        '    return get() + create();',
        '}',
        '',
        `int collide_${fp}_entry(void) {`,
        '    return process();',
        '}',
      );
      push(`collide_${fp}.${ext}`, j(lines));
    }
  }

  if (cpp) {
    const depth = c.nestDepth;
    const lines = ['namespace nesting {', '', 'int outermost() {'];
    for (let d = 1; d <= depth; d++) lines.push(`${'    '.repeat(d)}auto level${d} = [&]() -> int {`);
    lines.push(`${'    '.repeat(depth + 1)}return ${depth};`);
    for (let d = depth; d >= 1; d--) {
      lines.push(`${'    '.repeat(d)}};`);
      lines.push(`${'    '.repeat(d)}return level${d}();`);
    }
    lines.push('}', '', '}  // namespace nesting');
    push(`nesting_a.${ext}`, j(lines));
    const cls = ['namespace nesting_cls {', ''];
    for (let d = 1; d <= 6; d++) cls.push(`${'    '.repeat(d - 1)}struct L${d} {`);
    cls.push(`${'    '.repeat(6)}static int deep() { return 6; }`);
    for (let d = 6; d >= 1; d--) cls.push(`${'    '.repeat(d - 1)}};`);
    cls.push('', 'int touch_nested() {', '    return L1::L2::L3::L4::L5::L6::deep();', '}', '', '}  // namespace nesting_cls');
    push(`nesting_b.${ext}`, j(cls));
  } else {
    // Standard C has no nested functions — nest structs and blocks instead.
    const lines = ['/* C has no nested functions; nested structs and blocks instead. */'];
    for (let d = 1; d <= 6; d++) lines.push(`${'    '.repeat(d - 1)}struct L${d} {`);
    lines.push(`${'    '.repeat(6)}int value;`);
    for (let d = 6; d >= 1; d--) lines.push(`${'    '.repeat(d - 1)}}${d === 1 ? ';' : ` l${d}_field;`}`);
    lines.push('');
    lines.push('static int outermost(void) {');
    lines.push('    int acc = 0;');
    lines.push('    { { { { { { acc += 6; } } } } } }');
    lines.push('    return acc;');
    lines.push('}');
    lines.push('');
    lines.push('int nesting_entry(void) {');
    lines.push('    struct L1 deep_struct;');
    lines.push('    deep_struct.l2_field.l3_field.l4_field.l5_field.l6_field.value = 1;');
    lines.push('    return outermost() + deep_struct.l2_field.l3_field.l4_field.l5_field.l6_field.value;');
    lines.push('}');
    push(`nesting_a.${ext}`, j(lines));
  }

  push(`weird_ids.${ext}`, j(cpp ? [
    '// C/C++ fixtures stay ASCII-only for identifier portability.',
    'namespace weird {',
    '',
    'int _(void) { return 1; }',
    'int __severely__underscored__(void) { return 2; }',
    'int x(void) { return 3; }',
    '// Differs from x only by case.',
    'int X(void) { return x() + 1; }',
    '',
    '}  // namespace weird',
  ] : [
    '/* C fixtures stay ASCII-only for identifier portability. */',
    'static int __severely__underscored__(void) { return 2; }',
    'static int x(void) { return 3; }',
    '/* Differs from x only by case. */',
    'static int X(void) { return x() + 1; }',
    '',
    'int weird_ids_entry(void) {',
    '    return __severely__underscored__() + X();',
    '}',
  ]));

  const q = cpp ? '::' : '_';
  push(`recur_a.${ext}`, j(cpp ? [
    'namespace recur_b { int recurBeta(int n); }',
    '',
    'namespace recur_a {',
    '',
    'int recurFact(int n) {',
    '    return n <= 1 ? 1 : n * recurFact(n - 1);',
    '}',
    '',
    'int recurAlpha(int n) {',
    `    return n <= 0 ? 0 : recur_b${q}recurBeta(n - 1);`,
    '}',
    '',
    '}  // namespace recur_a',
  ] : [
    'int recur_beta(int n);',
    '',
    'int recur_fact(int n) {',
    '    return n <= 1 ? 1 : n * recur_fact(n - 1);',
    '}',
    '',
    'int recur_alpha(int n) {',
    '    return n <= 0 ? 0 : recur_beta(n - 1);',
    '}',
  ]));
  push(`recur_b.${ext}`, j(cpp ? [
    'namespace recur_c { int recurGamma(int n); }',
    '',
    'namespace recur_b {',
    '',
    'int recurSelfB(int n) {',
    '    return n <= 0 ? 0 : recurSelfB(n - 1);',
    '}',
    '',
    'int recurBeta(int n) {',
    `    return n <= 0 ? 1 : recur_c${q}recurGamma(n - 1);`,
    '}',
    '',
    '}  // namespace recur_b',
  ] : [
    'int recur_gamma(int n);',
    '',
    'static int recur_self_b(int n) {',
    '    return n <= 0 ? 0 : recur_self_b(n - 1);',
    '}',
    '',
    'int recur_beta(int n) {',
    '    return n <= 0 ? recur_self_b(1) + 1 : recur_gamma(n - 1);',
    '}',
  ]));
  push(`recur_c.${ext}`, j(cpp ? [
    'namespace recur_a { int recurAlpha(int n); }',
    '',
    'namespace recur_c {',
    '',
    'int recurGamma(int n) {',
    `    return n <= 0 ? 2 : recur_a${q}recurAlpha(n - 1);`,
    '}',
    '',
    '}  // namespace recur_c',
  ] : [
    'int recur_alpha(int n);',
    '',
    'int recur_gamma(int n) {',
    '    return n <= 0 ? 2 : recur_alpha(n - 1);',
    '}',
  ]));

  {
    const ns = cpp ? ['namespace huge {', ''] : [];
    const lines = [...ns];
    for (let i = 0; i < c.hugeFns; i++) {
      const callsPrev = i > 0 && i % 7 === 0;
      lines.push(
        `${cpp ? '' : 'static '}int f${pad(i)}(void) {`,
        callsPrev ? `    return f${pad(i - 1)}() + ${small(rng)};` : `    return ${small(rng)};`,
        '}',
      );
    }
    if (cpp) lines.push('', '}  // namespace huge');
    else lines.push('', 'int huge_entry(void) {', '    return f0000();', '}');
    push(`huge.${ext}`, j(lines));
  }

  push(`minified.${ext}`, j([
    `${cpp ? 'namespace minified { ' : ''}${cpp ? '' : 'static '}int long_line(void) { int ${chain(rng, c.longVars, (i, v) => `a${i}=${v}`, ',')}; return a0 + a${c.longVars - 1}; }${cpp ? ' }' : ''}`,
    cpp
      ? `namespace minified_blob { int blob_data[] = {${blob(rng, c.blobLen)}}; }`
      : `static int blob_data[] = {${blob(rng, c.blobLen)}};`,
    ...(cpp ? [] : ['', 'int minified_entry(void) {', '    return long_line() + blob_data[0];', '}']),
  ]));

  for (let g = 0; g < c.generatedFiles; g++) {
    const fp = pad(g, 2);
    const lines = cpp ? [`namespace gen${fp} {`, ''] : [];
    for (let h = 0; h < c.handlers; h++) {
      lines.push(`${cpp ? '' : 'static '}int handler${pad(h)}(void) { return ${int(rng, 10)}; }`);
    }
    lines.push('', `${cpp ? '' : 'static '}int dispatch(int k) {`, '    switch (k) {');
    for (let h = 0; h < c.handlers; h++) lines.push(`    case ${h}: return handler${pad(h)}();`);
    lines.push('    default: return -1;', '    }', '}');
    if (cpp) lines.push('', `}  // namespace gen${fp}`);
    else lines.push('', `int generated_${fp}_entry(int k) {`, '    return dispatch(k);', '}');
    push(`generated_${fp}.${ext}`, j(lines));
  }

  push(`traps.${ext}`, j([
    cpp ? 'namespace traps {' : '',
    'static const char *fake_fn = "int fake(void) { return 1; }";',
    'static const char *unbalanced = "if (x) { while (1) {";',
    '',
    '/* int comment_fake(void) { return 2; } */',
    '// int line_comment_fake(void) { return 3; }',
    '',
    '#if 0',
    'int preprocessed_out_fake(void) {',
    '    return 4; /* never compiled, still must lex */',
    '}',
    '#endif',
    '',
    `${cpp ? '' : 'static '}int real_after_traps(void) {`,
    '    return (int)(fake_fn[0] + unbalanced[0]);',
    '}',
    ...(cpp ? ['', '}  // namespace traps'] : ['', 'int traps_entry(void) {', '    return real_after_traps();', '}']),
  ].filter((l, idx) => !(idx === 0 && l === ''))));

  push(`empty.${ext}`, '');
  push(`tiny.${ext}`, cpp ? 'namespace tiny { const int one = 1; }\n' : 'static const int tiny_one = 1;\n');
  push(`comments_only.${ext}`, '/* This file contains only comments. */\n// int nothing_here(void) { return 0; }\n');
  push(`bom.${ext}`, `${BOM}${cpp ? 'namespace bom { int bomFn() { return 1; } }' : 'int bom_fn(void) { return 1; }'}\n`);
  push(`crlf.${ext}`, `${cpp ? 'namespace crlf { int crlfFn() { return 2; } }' : 'int crlf_fn(void) { return 2; }'}\n`.replace(/\n/g, '\r\n'));

  for (let m = 0; m < c.mixed; m++) {
    const fp = pad(m, 2);
    const target = pad(m % c.collide, 2);
    if (cpp) {
      push(`mixed_${fp}.${ext}`, j([
        `namespace collide${target} { int get(); }`,
        '',
        `namespace mixed${fp} {`,
        '',
        `int helper${fp}() {`,
        `    return ${small(rng)};`,
        '}',
        '',
        `int use${fp}() {`,
        `    return collide${target}::get() + helper${fp}();`,
        '}',
        '',
        `}  // namespace mixed${fp}`,
      ]));
    } else {
      push(`mixed_${fp}.${ext}`, j([
        `int collide_${target}_entry(void);`,
        '',
        `static int helper_${fp}(void) {`,
        `    return ${small(rng)};`,
        '}',
        '',
        `int use_${fp}(void) {`,
        `    return collide_${target}_entry() + helper_${fp}();`,
        '}',
      ]));
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const GENERATORS = {
  ts: (s, r) => genTs(s, r, 'ts'),
  js: genJs,
  py: genPy,
  go: genGo,
  java: genJava,
  rust: genRust,
  cs: genCs,
  rb: genRb,
  php: genPhp,
  kotlin: genKotlin,
  swift: genSwift,
  scala: genScala,
  dart: genDart,
  lua: genLua,
  elixir: genElixir,
  bash: genBash,
  zig: genZig,
  c: (s, r) => genC(s, r, false),
  cpp: (s, r) => genC(s, r, true),
};

export const ALL_LANGS = Object.keys(GENERATORS);

/**
 * Generate the adversarial fixture tree. Deterministic: identical options →
 * byte-identical files. Each language is seeded independently so `--langs`
 * subsets produce the same bytes as a full run.
 */
export function generateFixtures({ out, langs = ALL_LANGS, scale = 1 }) {
  const summary = { out, scale, languages: {}, files: 0, bytes: 0 };
  for (const lang of langs) {
    const gen = GENERATORS[lang];
    if (!gen) throw new Error(`unknown language "${lang}" (known: ${ALL_LANGS.join(', ')})`);
    const rng = mulberry32((SEED ^ fnv(lang)) >>> 0);
    const files = gen(scale, rng);
    const dir = path.join(out, lang);
    fs.rmSync(dir, { recursive: true, force: true });
    let bytes = 0;
    for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      const abs = path.join(dir, f.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
      bytes += Buffer.byteLength(f.content, 'utf8');
    }
    summary.languages[lang] = { files: files.length, bytes };
    summary.files += files.length;
    summary.bytes += bytes;
  }
  return summary;
}

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const opts = {
    out: path.resolve(here, '..', 'test', 'fixtures', 'adversarial'),
    langs: ALL_LANGS,
    scale: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (arg === '--langs') {
      const raw = argv[++i] ?? '';
      opts.langs = raw === 'all' ? ALL_LANGS : raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--scale') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--scale must be a positive integer, got "${argv[i]}"`);
      opts.scale = n;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: gen-adversarial-fixtures.mjs [--out <dir>] [--langs ts,py|all] [--scale N]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  for (const lang of opts.langs) {
    if (!GENERATORS[lang]) throw new Error(`unknown language "${lang}" (known: ${ALL_LANGS.join(', ')})`);
  }
  return opts;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const summary = generateFixtures(opts);
    for (const [lang, s] of Object.entries(summary.languages)) {
      process.stdout.write(`${lang.padEnd(7)} ${String(s.files).padStart(4)} files  ${String(s.bytes).padStart(8)} bytes\n`);
    }
    process.stdout.write(
      `total   ${String(summary.files).padStart(4)} files  ${String(summary.bytes).padStart(8)} bytes → ${summary.out}\n`,
    );
  } catch (err) {
    process.stderr.write(`gen-adversarial-fixtures: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
