import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { parseSource } from '../src/engine/parse.js';
import { PARSE_FAILURE_RECOVERY, parseFailedWarning } from '../src/engine/parse-failure.js';
import { formatWarningLine, WARNING_CODES } from '../src/core-open/warnings.js';
import { scanCommand } from '../src/reporting/commands/scan.js';
import { cleanup, makeProject } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(files: Record<string, string>): string {
  const dir = makeProject(files);
  dirs.push(dir);
  return dir;
}

/** Deliberate tree-sitter break: the grammar recovers with an ERROR node and no definitions. */
const GAP = '@@@@\n';

function failureMessage(rel: string): string {
  const stamped = parseFailedWarning(rel, 'ts');
  const suffix = ` [${WARNING_CODES.PARSE_FAILED}]`;
  return stamped.endsWith(suffix) ? stamped.slice(0, -suffix.length) : stamped;
}

describe('tree-sitter parse failure warning', () => {
  it('names the file, the language, and a stable recovery hint', async () => {
    const rel = 'src/a-gap.ts';
    const once = await parseSource(rel, 'ts', GAP);
    const twice = await parseSource(rel, 'ts', GAP);
    expect(once.warnings).toEqual(twice.warnings);
    expect(once.warnings).toEqual([parseFailedWarning(rel, 'ts')]);
    const message = failureMessage(rel);
    expect(message).toContain(rel);
    expect(message).toContain('(TypeScript)');
    expect(message).toContain('tree-sitter parse failed');
    expect(message).toContain(PARSE_FAILURE_RECOVERY);
    expect(message).not.toContain('@@@@');
    expect(message).not.toMatch(/\bat \S+\(/);
    expect(once.defs).toEqual([]);
  });

  it('does not warn for a file the grammar accepts', async () => {
    const comment = await parseSource('src/note.ts', 'ts', '// just a comment\n');
    const expr = await parseSource('src/expr.ts', 'ts', '1 + 1;\n');
    const fn = await parseSource('src/kept.ts', 'ts', 'export function kept() { return 1; }\n');
    expect(comment.warnings ?? []).toEqual([]);
    expect(expr.warnings ?? []).toEqual([]);
    expect(fn.warnings ?? []).toEqual([]);
    expect(fn.defs.map((d) => d.name)).toContain('kept');
  });

  it('keeps recovered definitions and does not emit PARSE_FAILED for a partial tree', async () => {
    const parsed = await parseSource('src/half.ts', 'ts', 'export function ok() { return 1; }\n@@@@\n');
    expect(parsed.defs.map((d) => d.name)).toContain('ok');
    expect(parsed.warnings ?? []).toEqual([]);
  });

  it('does not warn when a reused parser flags a valid file that has no definitions', async () => {
    await parseSource('src/f.lua', 'lua', 'local function f()\n  return 1\nend\n');
    const tiny = await parseSource('tiny.lua', 'lua', 'return 1\n');
    expect(tiny.defs).toEqual([]);
    expect(tiny.warnings ?? []).toEqual([]);
  });

  it('keeps a recovered import and does not warn when a real construct remains', async () => {
    const parsed = await parseSource('src/mixed.ts', 'ts', "import { kept } from './kept';\n@@@@\n");
    expect(parsed.defs).toEqual([]);
    expect(parsed.imports.map((i) => i.source)).toEqual(['./kept']);
    expect(parsed.warnings ?? []).toEqual([]);
  });

  it('replaces a parser crash with the same warning and still parses the next file', async () => {
    const rel = 'scripts/case.sh';
    const crashed = await parseSource(rel, 'sh', 'case $x in\n  a) echo hi;;\nesac\n');
    expect(crashed.defs).toEqual([]);
    expect(crashed.warnings).toEqual([parseFailedWarning(rel, 'sh')]);
    const text = crashed.warnings?.[0] ?? '';
    expect(text).toContain('scripts/case.sh');
    expect(text).toContain('(Shell)');
    expect(text).toContain(PARSE_FAILURE_RECOVERY);
    expect(text).not.toContain('resolved is not a function');
    expect(text).not.toMatch(/\n/);

    const again = await parseSource(rel, 'sh', 'case $x in\n  a) echo hi;;\nesac\n');
    expect(again.warnings).toEqual(crashed.warnings);

    const ok = await parseSource('scripts/ok.sh', 'sh', 'hello() {\n  echo hi\n}\n');
    expect(ok.warnings ?? []).toEqual([]);
    expect(ok.defs.map((d) => d.name)).toContain('hello');
  });

  it('build warns in path order and keeps the graph deterministic', async () => {
    const root = project({
      'src/kept.ts': 'export function kept() { return 1; }\n',
      'src/note.ts': '// just a comment\n',
      'src/z-gap.ts': 'export function broken(\n',
      'src/a-gap.ts': GAP,
    });
    const opts = { root, generatedAt: PIN, inline: true, noTsc: true, noIndex: true } as const;
    const first = await buildGraph({ ...opts, noCache: true });
    const second = await buildGraph({ ...opts, noCache: true });
    const warmed = await buildGraph({ ...opts });

    const messages = [failureMessage('src/a-gap.ts'), failureMessage('src/z-gap.ts')];
    expect(first.codedWarnings.map((warning) => warning.code)).toEqual([
      WARNING_CODES.PARSE_FAILED,
      WARNING_CODES.PARSE_FAILED,
    ]);
    expect(first.codedWarnings.map((warning) => warning.message)).toEqual(messages);
    expect(second.codedWarnings).toEqual(first.codedWarnings);
    expect(warmed.codedWarnings).toEqual(first.codedWarnings);
    expect(first.warnings).toEqual(messages.map((message) => `${message} [${WARNING_CODES.PARSE_FAILED}]`));
    expect(formatWarningLine(first.codedWarnings[0]!)).toBe(`warning [${WARNING_CODES.PARSE_FAILED}]: ${messages[0]}`);

    expect(serializeGraph(first.graph)).toBe(serializeGraph(second.graph));
    expect(serializeGraph(warmed.graph)).toBe(serializeGraph(first.graph));

    const names = first.graph.nodes.map((node) => node.name);
    expect(names).toContain('kept');
    expect(names).not.toContain('broken');
    const files = first.graph.nodes.filter((node) => node.kind === 'file').map((node) => node.file);
    expect(files).toContain('src/a-gap.ts');
    expect(files).toContain('src/z-gap.ts');
    expect(files).toContain('src/kept.ts');
    expect(JSON.stringify(first.codedWarnings)).not.toContain('@@@@');
    expect(JSON.stringify(first.codedWarnings)).not.toContain('export function');
  });
});

describe('vg scan surfaces parse failures', () => {
  it('prints the same warning on stderr, twice identically', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'parse-break-fixture', version: '1.0.0' }),
      'src/kept.ts': 'export function kept() { return 1; }\n',
      'src/a-gap.ts': GAP,
    });
    const strip = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');
    const run = async (): Promise<string> => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await scanCommand.parseAsync([
          'node',
          'scan',
          root,
          '--offline',
          '--no-daemon',
          '--quiet',
          '--format',
          'json',
        ]);
        return strip(errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n'));
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    };

    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    try {
      const first = await run();
      const second = await run();
      const line = `warning [${WARNING_CODES.PARSE_FAILED}]: ${failureMessage('src/a-gap.ts')}`;
      const lines = (text: string) => text.split('\n').filter((row) => row.includes(WARNING_CODES.PARSE_FAILED));
      expect(lines(first)).toEqual([line]);
      expect(lines(second)).toEqual(lines(first));
      expect(first).not.toContain('@@@@');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);
});
