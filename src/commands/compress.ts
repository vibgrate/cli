import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { c, info, json, out } from '../util/output.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { isProfileName } from '../compress/config.js';
import type { CompressOptions, Message, MessageFormat, ProfileName } from '../compress/types.js';

/**
 * `vg serve compress [file|-]` — run the context-compression pipeline offline
 * over a file or stdin and print the result.
 *
 * This is the debug path, not an everyday verb: in normal use the model never
 * compresses anything by hand — `vg serve --compress` already shrank the tool
 * output on the wire. It lives under `vg serve` because that is the command
 * that owns the compression engine (FEATURE-DESIGN-PRINCIPLES P1).
 *
 * It accepts three input shapes and picks the right path automatically:
 *
 *   • a JSON array of chat messages (OpenAI or Anthropic shape) → the full
 *     message pipeline (`compressMessages`), same format out;
 *   • a JSON request body (`{ "messages": [...], "system": …, "model": … }`)
 *     → the pipeline over `messages`, with `model` driving the tokenizer;
 *   • anything else → treated as one tool output and routed through the
 *     content router (JSON arrays, logs, grep output, diffs, code, text …).
 *
 * Nothing leaves the machine. With CCR on (default), originals are kept in the
 * local retrievable store so `vg serve retrieve <hash>` can expand a marker
 * later.
 */
export function registerServeCompressCommand(serve: Command): void {
  const cmd = serve
    .command('compress')
    .description('compress tool output or a chat transcript offline (same shape out; markers point at retrievable originals)')
    .argument('[file]', 'input file (default: stdin, or `-`)')
    .option('--model <id>', 'model id — selects the tokenizer family and context limit', 'claude-sonnet-4-5')
    .option('--format <fmt>', 'force the message format: openai | anthropic | responses')
    .option('--profile <name>', 'savings profile: coding | balanced | aggressive | general')
    .option('--mode <mode>', 'cache (newest delta only, prefix-cache safe) | token (maximum removal)')
    .option('--lossless', 'byte-reversible folds only — never lossy, never a marker')
    .option('--no-ccr', 'do not keep originals retrievable (lossy output carries no markers)')
    .option('--query <text>', 'relevance context (what the user asked) — keeps matching lines')
    .option('--tool <name>', 'tool name hint for plain-text input (e.g. Grep, Bash, Read)')
    .option('--target-ratio <r>', 'keep ratio for text compression, 0.1..1 (default: adaptive)')
    .option('--dry-run', 'show what would happen (route, manifest) without writing to the store')
    .option('--stats', 'print only the token accounting, not the compressed content')
    .action(async function (this: Command, file: string | undefined) {
      const global = readGlobal(this);
      const opts = this.opts<{
        model: string;
        format?: string;
        profile?: string;
        mode?: string;
        lossless?: boolean;
        ccr: boolean;
        query?: string;
        tool?: string;
        targetRatio?: string;
        dryRun?: boolean;
        stats?: boolean;
      }>();

      if (opts.profile !== undefined && !isProfileName(opts.profile)) {
        throw usageError(`--profile must be one of coding | balanced | aggressive | general (got ${JSON.stringify(opts.profile)})`);
      }
      if (opts.mode !== undefined && opts.mode !== 'cache' && opts.mode !== 'token') {
        throw usageError(`--mode must be cache or token (got ${JSON.stringify(opts.mode)})`);
      }
      if (opts.format !== undefined && !['openai', 'anthropic', 'responses'].includes(opts.format)) {
        throw usageError(`--format must be openai | anthropic | responses (got ${JSON.stringify(opts.format)})`);
      }
      let targetRatio: number | undefined;
      if (opts.targetRatio !== undefined) {
        targetRatio = Number(opts.targetRatio);
        if (!Number.isFinite(targetRatio) || targetRatio < 0.1 || targetRatio > 1) {
          throw usageError(`--target-ratio must be a number between 0.1 and 1 (got ${JSON.stringify(opts.targetRatio)})`);
        }
      }

      const input = await readInput(file);
      if (input.trim() === '') throw usageError('nothing to compress: pass a file, or pipe content on stdin');

      const parsed = parseInput(input);
      const { compressMessages } = await import('../compress/pipeline.js');
      const { defaultStore } = await import('../compress/ccr/store.js');
      const { createRouter } = await import('../compress/router.js');
      const { tokenizerFor } = await import('../compress/tokenizers.js');

      const store = opts.ccr && !opts.dryRun ? defaultStore() : null;
      const model = parsed.kind === 'request' && typeof parsed.body.model === 'string' ? parsed.body.model : opts.model;

      if (parsed.kind === 'text') {
        const router = createRouter({ profile: opts.profile as ProfileName | undefined, lossless: opts.lossless, targetRatio });
        const tokenizer = tokenizerFor(model);
        const route = router.route(parsed.text, { toolName: opts.tool });
        const res = router.compress({
          content: parsed.text,
          query: opts.query,
          toolName: opts.tool,
          ccr: store,
          tokenizer,
          injectMarker: opts.ccr && !opts.dryRun,
          losslessOnly: opts.lossless === true,
          targetRatio,
        });
        const before = tokenizer.count(parsed.text);
        const after = tokenizer.count(res.content);
        const summary = {
          input: 'text' as const,
          model,
          tokenizer: tokenizer.id,
          detected: route.type,
          strategy: res.strategy,
          chain: res.chain,
          info: res.info ?? null,
          itemCounts: res.itemCounts ?? null,
          tokensBefore: before,
          tokensAfter: after,
          tokensSaved: Math.max(0, before - after),
          keptRatio: before > 0 ? Number((after / before).toFixed(4)) : 1,
          ccrHashes: res.ccrHashes,
          dryRun: opts.dryRun === true,
        };
        if (global.json) {
          json(opts.stats ? summary : { ...summary, content: res.content });
          return;
        }
        if (!opts.stats) out(res.content);
        printTextSummary(summary);
        return;
      }

      const messages = parsed.messages;
      const options: CompressOptions = {
        model,
        profile: opts.profile as ProfileName | undefined,
        mode: opts.mode as CompressOptions['mode'],
        lossless: opts.lossless,
        query: opts.query,
        targetRatio,
        ccr: { enabled: opts.ccr && !opts.dryRun, injectMarker: opts.ccr && !opts.dryRun, store },
        optimize: true,
      };
      const result = await compressMessages(messages, options, { store, now: () => Date.now() });
      const format = (opts.format as MessageFormat | undefined) ?? result.format;

      const output: unknown =
        parsed.kind === 'request' ? { ...parsed.body, messages: result.messages } : result.messages;

      if (global.json) {
        json(
          opts.stats
            ? withoutMessages(result)
            : { ...withoutMessages(result), format, output },
        );
        return;
      }
      if (!opts.stats) out(JSON.stringify(output, null, 2));
      printPipelineSummary(result, format, opts.dryRun === true);
    });
  applyGlobalOptions(cmd);
}

type ParsedInput =
  | { kind: 'messages'; messages: Message[] }
  | { kind: 'request'; body: Record<string, unknown>; messages: Message[] }
  | { kind: 'text'; text: string };

/** Decide which path the input takes. Never throws on non-JSON — that is just text. */
export function parseInput(input: string): ParsedInput {
  const trimmed = input.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { kind: 'text', text: input };
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isMessageLike)) {
      return { kind: 'messages', messages: value as Message[] };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const body = value as Record<string, unknown>;
      if (Array.isArray(body.messages) && (body.messages as unknown[]).every(isMessageLike)) {
        return { kind: 'request', body, messages: body.messages as Message[] };
      }
    }
  }
  return { kind: 'text', text: input };
}

function isMessageLike(x: unknown): boolean {
  return !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).role === 'string';
}

async function readInput(file: string | undefined): Promise<string> {
  if (file && file !== '-') {
    const abs = path.resolve(file);
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new CliError(`no such file: ${abs}`, ExitCode.NOT_FOUND);
      throw new CliError(`cannot read ${abs}: ${(err as Error).message}`, ExitCode.ERROR);
    }
  }
  if (process.stdin.isTTY) throw usageError('no input: pass a file, or pipe content on stdin (`cat out.log | vg compress`)');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function withoutMessages<T extends { messages: unknown }>(r: T): Omit<T, 'messages'> {
  const { messages: _messages, ...rest } = r;
  return rest;
}

function pct(kept: number): string {
  return `${Math.round((1 - kept) * 100)}%`;
}

function printTextSummary(s: {
  detected: string;
  strategy: string;
  chain: string[];
  tokensBefore: number;
  tokensAfter: number;
  keptRatio: number;
  ccrHashes: string[];
  dryRun: boolean;
  tokenizer: string;
}): void {
  info(
    `${c.cyan('vg compress')} · ${s.detected} → ${c.bold(s.strategy)}${s.chain.length ? c.dim(` (${s.chain.join(' → ')})`) : ''}` +
      ` · ${s.tokensBefore} → ${s.tokensAfter} tokens ${c.green(`(${pct(s.keptRatio)} smaller)`)} ${c.dim(`· ${s.tokenizer}`)}` +
      (s.dryRun ? c.dim(' · dry run, nothing stored') : ''),
  );
  if (s.ccrHashes.length) info(c.dim(`  originals retrievable: ${s.ccrHashes.map((h) => `vg retrieve ${h}`).join(' · ')}`));
}

function printPipelineSummary(
  r: { tokensBefore: number; tokensAfter: number; keptRatio: number; transformsApplied: string[]; ccrHashes: string[]; warnings: string[]; compressed: boolean },
  format: string,
  dryRun: boolean,
): void {
  info(
    `${c.cyan('vg compress')} · ${format} · ${r.tokensBefore} → ${r.tokensAfter} tokens ` +
      (r.compressed ? c.green(`(${pct(r.keptRatio)} smaller)`) : c.dim('(nothing eligible — original returned)')) +
      (dryRun ? c.dim(' · dry run, nothing stored') : ''),
  );
  if (r.transformsApplied.length) info(c.dim(`  transforms: ${r.transformsApplied.join(', ')}`));
  if (r.ccrHashes.length) info(c.dim(`  originals retrievable: ${r.ccrHashes.length} (vg retrieve <hash>)`));
  for (const w of r.warnings.slice(0, 5)) info(c.yellow(`  warning: ${w}`));
}
