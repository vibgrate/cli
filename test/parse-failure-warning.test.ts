import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { parseFailureWarning, parseFailureWarningLines } from '../src/engine/parse-warning.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { cleanup, makeProject } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

const SYNTAX_MSG =
  "src/broken.ts (TypeScript): parse failed. The map continues without this file's symbols. Correct the file or exclude the path with --exclude.";
const SHELL_MSG =
  "scripts/dispatch.sh (Shell): parse failed. The map continues without this file's symbols. Correct the file or exclude the path with --exclude.";

function fixture(): string {
  const root = makeProject({
    'src/ok.ts': 'export function ok(): number { return 1; }\n',
    'src/value.ts': 'export const x = 1;\n',
    'src/partial.ts': 'export function kept(): number { return 1; }\n@@@\n',
    'src/broken.ts': 'export function broken(\n',
    'scripts/ok.sh': '#!/bin/sh\nhello() { echo hi; }\nhello\n',
    // The bundled shell grammar throws on `case` (web-tree-sitter 0.25.x).
    'scripts/dispatch.sh': 'case "$1" in\n  a) echo a ;;\nesac\n',
  });
  dirs.push(root);
  return root;
}

function parseFailures(warnings: { code: string; message: string }[]): string[] {
  return warnings.filter((warning) => warning.code === 'VG_WARN_PARSE_FAILED').map((warning) => warning.message);
}

describe('parse failure warning', () => {
  it('names the file and language, repeats exactly, and keeps recovered files', async () => {
    const root = fixture();
    const opts = { root, generatedAt: PIN, inline: true, noCache: true };
    const first = await buildGraph(opts);
    const second = await buildGraph(opts);

    expect(parseFailures(first.codedWarnings)).toEqual([SHELL_MSG, SYNTAX_MSG]);
    expect(first.codedWarnings).toEqual(second.codedWarnings);
    expect(first.warnings).toEqual(second.warnings);
    expect(serializeGraph(first.graph)).toBe(serializeGraph(second.graph));

    const text = parseFailures(first.codedWarnings).join('\n');
    expect(text).not.toMatch(/resolved is not a function/);
    expect(text).not.toMatch(/\n\s+at /);

    const names = first.graph.nodes.map((node) => node.name);
    expect(names).toContain('ok');
    expect(names).toContain('kept');
    expect(names).toContain('hello');
    expect(names).not.toContain('broken');
  });

  it('still warns on a second build when the failed parse is not cached', async () => {
    const root = fixture();
    const opts = { root, generatedAt: PIN, inline: true };
    const first = await buildGraph(opts);
    const second = await buildGraph(opts);
    expect(parseFailures(first.codedWarnings)).toEqual([SHELL_MSG, SYNTAX_MSG]);
    expect(parseFailures(second.codedWarnings)).toEqual([SHELL_MSG, SYNTAX_MSG]);
  });

  it('keeps an escaping path to the file name and formats the scan line', () => {
    const stored = parseFailureWarning('../secret.ts', 'ts');
    expect(stored).toContain('secret.ts (TypeScript)');
    expect(stored).not.toContain('..');
    expect(stored.endsWith(' [VG_WARN_PARSE_FAILED]')).toBe(true);
    expect(
      parseFailureWarningLines([
        { code: 'VG_WARN_PARSE_FAILED', message: SYNTAX_MSG },
        { code: 'VG_WARN_BUILD_FILE_OVERSIZE', message: 'src/big.ts: skipped' },
      ]),
    ).toEqual([`warning [VG_WARN_PARSE_FAILED]: ${SYNTAX_MSG}`]);
  });
});
