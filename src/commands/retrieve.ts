import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { c, info, json, out } from '../util/output.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';

/**
 * `vg serve retrieve <hash>` — expand a compression marker back to its original
 * content from the local retrievable store. Targeted views (`--grep`,
 * `--lines`, `--head`, `--tail`, `--json-path`) return just the slice an agent
 * needs instead of re-paying for the whole original.
 *
 * A model does not come here: it calls the `retrieve_original` MCP tool, or the
 * `vg_retrieve` tool the compression listener injects. This is the human debug
 * path, so it nests under the command that owns the store (P1).
 *
 * Also: `vg serve retrieve --list` (what is currently retrievable) and
 * `--purge` (drop expired entries now instead of at next use).
 */
export function registerServeRetrieve(serve: Command): void {
  const cmd = serve
    .command('retrieve')
    .description('expand a compression marker (`<<vg-ccr:…>>` / `hash=…`) back to the original from the local store')
    .argument('[hash]', 'the 12- or 24-character hash from a marker or a `Retrieve original: hash=…` line')
    .option('--grep <pattern>', 'only lines matching this pattern (case-insensitive substring or /regex/)')
    .option('--lines <a-b>', 'only this 1-based line range, e.g. 120-180')
    .option('--head <n>', 'only the first n lines')
    .option('--tail <n>', 'only the last n lines')
    .option('--json-path <path>', 'for JSON originals: a dotted path or `[i]` index to extract')
    .option('--max-tokens <n>', 'cap the returned slice (tokens)')
    .option('--list', 'list retrievable entries instead of expanding one')
    .option('--purge', 'delete expired entries from the store and exit')
    .option('--stats', 'show store statistics')
    .action(async function (this: Command, hash: string | undefined) {
      const global = readGlobal(this);
      const opts = this.opts<{
        grep?: string;
        lines?: string;
        head?: string;
        tail?: string;
        jsonPath?: string;
        maxTokens?: string;
        list?: boolean;
        purge?: boolean;
        stats?: boolean;
      }>();
      const { defaultStore } = await import('../compress/ccr/store.js');
      const store = defaultStore();

      if (opts.purge) {
        const removed = store.purgeExpired();
        if (global.json) json({ ok: true, removed });
        else info(`${c.cyan('vg serve retrieve')} ${c.dim('--purge')} · ${removed} expired entr${removed === 1 ? 'y' : 'ies'} removed`);
        return;
      }
      if (opts.stats) {
        const stats = store.stats();
        if (global.json) json(stats);
        else info(`${c.cyan('vg serve retrieve')} ${c.dim('--stats')} · ${JSON.stringify(stats)}`);
        return;
      }
      if (opts.list) {
        const entries = store.list().map((e) => ({
          hash: e.hash,
          strategy: e.strategy,
          toolName: e.toolName ?? null,
          originalTokens: e.originalTokens,
          compressedTokens: e.compressedTokens,
          createdAt: new Date(e.createdAt).toISOString(),
          expiresAt: new Date(e.expiresAt).toISOString(),
          status: e.status,
        }));
        if (global.json) {
          json({ entries });
          return;
        }
        info(`${c.cyan('vg serve retrieve')} ${c.dim('--list')} · ${entries.length} retrievable entr${entries.length === 1 ? 'y' : 'ies'}`);
        for (const e of entries) {
          info(`  ${e.hash}  ${e.strategy.padEnd(14)} ${String(e.originalTokens).padStart(8)} → ${String(e.compressedTokens).padStart(6)} tok  ${c.dim(`${e.toolName ?? ''} expires ${e.expiresAt}`)}`);
        }
        return;
      }

      if (!hash) throw usageError('pass the hash from a marker: `vg serve retrieve <hash>` (or `--list` to see what is retrievable)');
      const clean = normalizeHash(hash);
      if (!clean) throw usageError(`not a marker hash: ${JSON.stringify(hash)} — expected 12 or 24 hex characters`);

      const lines = opts.lines ? parseRange(opts.lines) : undefined;
      const head = opts.head !== undefined ? positiveInt(opts.head, '--head') : undefined;
      const tail = opts.tail !== undefined ? positiveInt(opts.tail, '--tail') : undefined;
      const maxTokens = opts.maxTokens !== undefined ? positiveInt(opts.maxTokens, '--max-tokens') : undefined;

      const result = store.retrieve(clean, { grep: opts.grep, lines, head, tail, jsonPath: opts.jsonPath, maxTokens });
      if (!result.found) {
        throw new CliError(
          `nothing retrievable for ${clean}${result.status ? ` (${result.status})` : ''} — entries expire after their TTL; run \`vg serve retrieve --list\` to see what is still held`,
          ExitCode.NOT_FOUND,
        );
      }
      if (global.json) {
        json(result);
        return;
      }
      out(result.content);
      if (result.truncated) info(c.dim(`  (truncated to ${maxTokens ?? '?'} tokens — narrow with --grep/--lines, or raise --max-tokens)`));
    });
  applyGlobalOptions(cmd);
}

/** Accept a bare hash, a `<<vg-ccr:HASH…>>` marker, or a `hash=HASH` fragment. */
export function normalizeHash(raw: string): string | null {
  const m = raw.match(/([0-9a-f]{24}|[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

function parseRange(raw: string): [number, number] {
  const m = raw.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!m) throw usageError(`--lines expects a range like 120-180 (got ${JSON.stringify(raw)})`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a < 1 || b < a) throw usageError(`--lines range must be ascending and 1-based (got ${raw})`);
  return [a, b];
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw usageError(`${flag} expects a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}
