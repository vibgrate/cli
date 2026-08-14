/**
 * `vg hcs` — Holistic Code Specification: extract and analyze code facts.
 *
 * Every subcommand is a thin shim over the optional HCS engine module
 * (engine/hcs-provider.ts): read input → call the engine → write output → map
 * the result to an exit code. No HCS logic (fact parsing, decoding, scoring,
 * diffing, rendering) lives in the CLI — it all runs inside the engine's WASM
 * sandbox, so every host gets byte-identical results.
 *
 * Engine acquisition is loud by contract: when the engine is missing and
 * cannot be fetched, every subcommand exits with ENGINE_UNAVAILABLE (6) — a
 * code deliberately distinct from a gate failure (2) so CI can never read
 * "engine missing" as a gate verdict.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { type HcsEngine, loadHcsEngine, resetHcsEngineCache } from '../engine/hcs-provider.js';
import { HCS_MODULE_NAME, ensureHcsModule } from '../install/hcs-module.js';
import { kernelDisabled } from '../install/module-core.js';
import { CliError, ExitCode, engineUnavailable, usageError } from '../util/exit.js';
import { c, info } from '../util/output.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';

const DIGEST_FORMATS = ['md', 'json', 'html'];
const DIGEST_LEVELS = ['concise', 'full'];
const MAP_FORMATS = ['json', 'md', 'mermaid'];
const MAP_PROFILES = ['integration', 'migration', 'governance'];
const GATE_FORMATS = ['text', 'json', 'sarif'];

/** File extensions per extractable language (discovery plumbing only — the
 *  engine's supportedLanguages() decides what actually runs). */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  rust: ['.rs'],
  ruby: ['.rb', '.rake', '.gemspec'],
  php: ['.php'],
  dart: ['.dart'],
  swift: ['.swift'],
  scala: ['.scala', '.sc'],
  cplusplus: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.ixx'],
  cobol: ['.cbl', '.cob', '.cpy', '.cob85', '.cobol'],
  vb6: ['.vbp', '.bas', '.cls', '.frm', '.ctl', '.dsr'],
};

/** Directories skipped during the extraction walk. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.vibgrate', '.hg', '.svn',
  'dist', 'build', 'out', 'bin', 'obj', 'target', 'vendor',
  'coverage', '__pycache__', 'DerivedData', 'Pods',
]);

const TEST_PATTERNS = [/[/\\]tests?[/\\]/i, /[/\\]__tests__[/\\]/i, /[/\\]spec[/\\]/i, /\.spec\./i, /\.test\./i];

/** Files above this size are skipped during extraction (generated/vendored). */
const MAX_EXTRACT_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Get the engine or fail loudly. First use auto-provisions the module (with a
 * one-line stderr notice); a recorded denial, VIBGRATE_NO_KERNEL, or an
 * unreachable registry all end in ENGINE_UNAVAILABLE with the fix spelled out.
 */
async function requireEngine(): Promise<HcsEngine> {
  if (kernelDisabled()) {
    throw engineUnavailable(
      'vg hcs needs the HCS engine module, but VIBGRATE_NO_KERNEL is set — unset it and retry',
    );
  }
  let engine = await loadHcsEngine();
  if (engine) return engine;

  const result = await ensureHcsModule();
  if (result.status === 'installed') {
    info(c.dim(`installed ${HCS_MODULE_NAME}@${result.version} (proprietary license, runs fully locally)`));
    resetHcsEngineCache();
    engine = await loadHcsEngine();
    if (engine) return engine;
  }
  if (result.status === 'declined') {
    throw engineUnavailable(
      'the HCS engine module was previously declined — run `vg module install hcs` to install it',
    );
  }
  throw engineUnavailable(
    `the HCS engine module is not installed and could not be fetched` +
      `${result.detail ? ` (${result.detail})` : ''} — ` +
      'run `vg module install hcs` on a machine with registry access, or point VIBGRATE_HCS_PATH at an ' +
      'installed engine. This exit (6, ENGINE_UNAVAILABLE) is distinct from a gate failure (2) by design.',
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function readFileOrThrow(file: string, label: string): string {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw usageError(`${label} file not found: ${p}`);
  return fs.readFileSync(p, 'utf-8');
}

async function readInput(file: string | undefined, label: string): Promise<string> {
  return file ? readFileOrThrow(file, label) : readStdin();
}

function writeOutput(outFile: string | undefined, content: string): void {
  if (!outFile) {
    process.stdout.write(content.endsWith('\n') ? content : content + '\n');
    return;
  }
  const outPath = path.resolve(outFile);
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) throw usageError(`output directory does not exist: ${dir}`);
  fs.writeFileSync(outPath, content.endsWith('\n') ? content : content + '\n', 'utf-8');
  info(c.dim(`wrote ${outPath}`));
}

function requireChoice(value: string, valid: string[], flag: string): void {
  if (!valid.includes(value)) throw usageError(`${flag} must be one of: ${valid.join(', ')}`);
}

/** Run one engine call, translating an engine error into a clean CliError. */
function engineCall(what: string, fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    throw new CliError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerHcs(program: Command): void {
  const cmd = program
    .command('hcs')
    .description('Holistic Code Specification — extract and analyze deterministic code facts');

  cmd
    .command('extract')
    .description('extract HCS facts from source into an NDJSON stream')
    .argument('[dir]', 'directory to extract from', '.')
    .option('--language <lang>', 'only extract this language (default: all the engine supports)')
    .option('--include-tests', 'include test files (excluded by default)')
    .option('-o, --out <file>', 'write NDJSON to file (default: stdout)')
    .option(
      '--previous <file>',
      'previous extract output to update incrementally (default: the --out file, so repeated `-o` runs ' +
        'are incremental; a missing file means a full extraction)',
    )
    .option('--full', 'ignore the previous stream and re-extract every file from scratch')
    .action(async function (this: Command, dir: string, opts: { language?: string; includeTests?: boolean; out?: string; previous?: string; full?: boolean }) {
      const engine = await requireEngine();
      if (!engine.extractFacts || !engine.supportedLanguages) {
        throw engineUnavailable(
          'the installed HCS engine does not include extraction — update it with `vg module install hcs --force`',
        );
      }
      // Incremental is the default: the previous stream is the --previous file
      // when given, else the --out file (so repeated `-o` runs self-prime).
      // An explicit --previous demands the capability loudly; the implicit
      // default degrades to a plain full extraction on an older engine.
      const canIncremental = Boolean(engine.planExtract && engine.mergeExtract);
      if (opts.previous && !canIncremental) {
        throw engineUnavailable(
          'the installed HCS engine does not include incremental extraction — update it with `vg module install hcs --force`',
        );
      }
      const statePath = opts.previous ?? opts.out;
      const useIncremental = canIncremental && statePath !== undefined;
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw usageError(`not a directory: ${root}`);
      }
      const supported = new Set(
        engine.supportedLanguages().split(',').map((l) => l.trim()).filter(Boolean),
      );
      if (opts.language && !supported.has(opts.language)) {
        throw usageError(`--language must be one of: ${[...supported].sort().join(', ')}`);
      }
      const wanted = opts.language ? new Set([opts.language]) : supported;

      // Discovery is plumbing: walk, bucket by extension, read contents. The
      // engine decides everything about what the files mean.
      const extToLang = new Map<string, string>();
      for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
        if (wanted.has(lang)) for (const ext of exts) extToLang.set(ext, lang);
      }
      const byLanguage = new Map<string, Array<{ path: string; content: string }>>();
      const walk = (abs: string, rel: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
          return;
        }
        // Sort so the emitted stream is independent of filesystem order.
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (entry.name.startsWith('.')) continue;
          const absChild = path.join(abs, entry.name);
          const relChild = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(absChild, relChild);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!opts.includeTests && TEST_PATTERNS.some((p) => p.test(relChild))) continue;
          const lang = extToLang.get(path.extname(entry.name).toLowerCase());
          if (!lang) continue;
          try {
            if (fs.statSync(absChild).size > MAX_EXTRACT_FILE_BYTES) continue;
            const content = fs.readFileSync(absChild, 'utf-8');
            let bucket = byLanguage.get(lang);
            if (!bucket) byLanguage.set(lang, (bucket = []));
            bucket.push({ path: relChild, content });
          } catch {
            /* unreadable file — skip */
          }
        }
      };
      walk(root, '');

      if (byLanguage.size === 0 && !useIncremental) {
        info(`no extractable sources found under ${root} (languages: ${[...wanted].sort().join(', ')})`);
        writeOutput(opts.out, '');
        return;
      }

      /** Extract one language bucket, restricted to `only` when given. */
      const extractLanguage = (language: string, only?: ReadonlySet<string>): string => {
        let files = byLanguage.get(language)!;
        if (only) files = files.filter((f) => only.has(f.path));
        if (files.length === 0) return '';
        info(c.dim(`extracting ${language} (${files.length} files)`));
        // emittedAt stays empty for deterministic output; it never affects factId.
        return engineCall(`${language} extraction`, () =>
          engine.extractFacts!(JSON.stringify({ language, files, emittedAt: '' })),
        ).trim();
      };
      const languages = [...byLanguage.keys()].sort();

      if (!useIncremental) {
        const parts = languages.map((l) => extractLanguage(l)).filter(Boolean);
        writeOutput(opts.out, parts.join('\n'));
        return;
      }

      // Incremental mode: the engine plans (via the previous stream's
      // FileHashIndex), the CLI re-extracts only the planned files, and the
      // engine merges — reusing unchanged facts byte-for-byte and stamping a
      // fresh index. All diff/merge logic lives in the engine; this is plumbing.
      // Under --full the previous stream is ignored (empty ⇒ the engine plans
      // a full extraction) but the output is still merged, so the fresh index
      // keeps the incremental loop primed.
      const previousPath = path.resolve(statePath!);
      const previousNdjson =
        !opts.full && fs.existsSync(previousPath) ? fs.readFileSync(previousPath, 'utf-8') : '';
      if (opts.full) info(c.dim('running a full re-extraction (--full)'));
      else if (!previousNdjson) info(c.dim(`previous stream not found at ${previousPath} — running a full extraction`));
      const currentFilesJson = JSON.stringify(
        languages.flatMap((l) => byLanguage.get(l)!.map((f) => ({ path: f.path, content: f.content }))),
      );
      const plan = JSON.parse(
        engineCall('incremental planning', () => engine.planExtract!(previousNdjson, currentFilesJson)),
      ) as { mode: string; added: string[]; changed: string[]; removed: string[]; unchanged: number };
      const toExtract = new Set([...plan.added, ...plan.changed]);
      info(
        c.dim(
          `incremental plan (${plan.mode}): ${plan.added.length} added, ${plan.changed.length} changed, ` +
            `${plan.removed.length} removed, ${plan.unchanged} unchanged`,
        ),
      );
      const parts = languages.map((l) => extractLanguage(l, toExtract)).filter(Boolean);
      const merged = JSON.parse(
        engineCall('incremental merge', () =>
          engine.mergeExtract!(previousNdjson, parts.join('\n'), currentFilesJson),
        ),
      ) as { ndjson: string; stats: { reusedFacts: number; freshFacts: number; droppedFacts: number } };
      info(
        c.dim(
          `merged: ${merged.stats.reusedFacts} facts reused, ${merged.stats.freshFacts} fresh, ` +
            `${merged.stats.droppedFacts} dropped`,
        ),
      );
      writeOutput(opts.out, merged.ndjson);
    });

  cmd
    .command('digest')
    .description('render an HCS NDJSON fact stream (from `vg hcs extract`) as Markdown, JSON, or HTML')
    .option('--in <file>', 'NDJSON file to read (default: stdin)')
    .option('-o, --out <file>', 'write output to file (default: stdout)')
    .option('--format <format>', `output format: ${DIGEST_FORMATS.join(' | ')}`, 'md')
    .option('--level <level>', `detail level: ${DIGEST_LEVELS.join(' | ')}`, 'concise')
    .option('--title <title>', 'override the document title')
    .action(async function (this: Command, opts: { in?: string; out?: string; format: string; level: string; title?: string }) {
      requireChoice(opts.format, DIGEST_FORMATS, '--format');
      requireChoice(opts.level, DIGEST_LEVELS, '--level');
      const engine = await requireEngine();
      const ndjson = await readInput(opts.in, 'input');
      const options: Record<string, string> = { format: opts.format, level: opts.level };
      if (opts.title) options.title = opts.title;
      writeOutput(opts.out, engineCall('digest rendering', () => engine.renderDigest(ndjson, JSON.stringify(options))));
    });

  cmd
    .command('map')
    .description('build the System Map from an HCS NDJSON fact stream')
    .option('--facts <file>', 'NDJSON facts file to read (default: stdin)')
    .option('-o, --out <file>', 'write output to file (default: stdout)')
    .option('--format <format>', `output format: ${MAP_FORMATS.join(' | ')}`, 'json')
    .option('--profile <profile>', `consumer projection: ${MAP_PROFILES.join(' | ')}`)
    .action(async function (this: Command, opts: { facts?: string; out?: string; format: string; profile?: string }) {
      requireChoice(opts.format, MAP_FORMATS, '--format');
      if (opts.profile) requireChoice(opts.profile, MAP_PROFILES, '--profile');
      // --generated-at is a global flag (applyGlobalOptions), read via optsWithGlobals.
      const generatedAt = readGlobal(this).generatedAt;
      const engine = await requireEngine();
      const ndjson = await readInput(opts.facts, 'facts');
      const options: Record<string, string> = { format: opts.format };
      if (opts.profile) options.profile = opts.profile;
      if (generatedAt) options.generatedAt = generatedAt;
      writeOutput(opts.out, engineCall('map build', () => engine.buildMap(ndjson, JSON.stringify(options))));
    });

  cmd
    .command('gate')
    .description('governance gate — diff two HCS fact streams and fail (exit 2) on material structural regressions')
    .requiredOption('--baseline <file>', 'baseline NDJSON facts (the "before" stream)')
    .option('--facts <file>', 'current NDJSON facts (the "after" stream; default: stdin)')
    .option('--policy <file>', 'gate policy JSON — thresholds and disabled rules')
    .option('-o, --out <file>', 'write the result to file (default: stdout)')
    .option('--format <format>', `output format: ${GATE_FORMATS.join(' | ')}`, 'text')
    .action(async function (this: Command, opts: { baseline: string; facts?: string; policy?: string; out?: string; format: string }) {
      requireChoice(opts.format, GATE_FORMATS, '--format');
      const engine = await requireEngine();
      const before = readFileOrThrow(opts.baseline, 'baseline');
      const after = await readInput(opts.facts, 'facts');
      let policy: unknown;
      if (opts.policy) {
        try {
          policy = JSON.parse(readFileOrThrow(opts.policy, 'policy'));
        } catch (err) {
          if (err instanceof CliError) throw err;
          throw usageError(`invalid policy JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // JSON pass first for the machine verdict; then the requested format.
      const jsonOut = engineCall('gate evaluation', () =>
        engine.evaluateGate(before, after, JSON.stringify({ format: 'json', policy })),
      );
      const pass = (JSON.parse(jsonOut) as { pass: boolean }).pass;
      const output =
        opts.format === 'json'
          ? jsonOut
          : engineCall('gate evaluation', () => engine.evaluateGate(before, after, JSON.stringify({ format: opts.format, policy })));
      writeOutput(opts.out, output);
      if (!pass) {
        info(c.red('gate FAILED — material structural regression against the baseline'));
        process.exitCode = ExitCode.GATE_FAILED;
      } else {
        info(c.green('gate passed'));
      }
    });

  cmd
    .command('validate')
    .description('validate an HCS NDJSON model against the spec (exits with the Appendix-I conformance code)')
    .argument('<file>', 'NDJSON model file (e.g. `vg hcs extract` output)')
    .action(async function (this: Command, file: string) {
      // --json is a global flag (applyGlobalOptions), read via optsWithGlobals.
      const opts = { json: readGlobal(this).json };
      const engine = await requireEngine();
      if (!engine.validateLines) {
        throw engineUnavailable(
          'the installed HCS engine does not include the validator — update it with `vg module install hcs --force`',
        );
      }
      const content = readFileOrThrow(file, 'model');
      const lines = content.split('\n').filter((l) => l.trim());
      const report = JSON.parse(engineCall('validation', () => engine.validateLines!(JSON.stringify(lines)))) as {
        ok: boolean;
        exitCode: number;
        errors: Array<{ code: string; factId?: string; message: string }>;
      };
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else if (report.ok) {
        info(c.green('✔ conformant — model satisfies the HCS spec'));
      } else {
        info(c.red(`✘ ${report.errors.length} validation error(s) (exit ${report.exitCode}):`));
        for (const e of report.errors.slice(0, 50)) {
          info(c.dim(`  [${e.code}] ${e.factId || '(model)'}: ${e.message}`));
        }
        if (report.errors.length > 50) info(c.dim(`  … and ${report.errors.length - 50} more`));
      }
      process.exitCode = report.exitCode;
    });

  applyGlobalOptions(cmd);
}
