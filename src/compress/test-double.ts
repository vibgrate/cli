/**
 * Test double for the content router (`Compressor` + `route()`), plus the
 * golden conversation fixture used by the pipeline, handler and SDK tests.
 * Deterministic and dependency-free; never shipped (only tests import it).
 */

import { makeMarker, retrieveHint } from './ccr/markers.js';
import { hashOriginal } from './ccr/store.js';
import type { CompressRequest, CompressResponse, Compressor, ContentType, Message, Strategy } from './types.js';

export function fakeRoute(text: string, hint: { toolName?: string } = {}): { type: ContentType; strategy: Strategy; reason: string } {
  const t = text.trimStart();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) return { type: 'json', strategy: 'smart_crusher', reason: 'json array' };
      return { type: 'json', strategy: 'passthrough', reason: 'json object' };
    } catch {
      /* not json */
    }
  }
  const lines = text.split('\n');
  const search = lines.filter((l) => /^[^\s:]*[./][^\s:]*:\d+:/.test(l)).length;
  if (lines.length >= 2 && search / lines.length >= 0.3) return { type: 'search_results', strategy: 'search', reason: 'file:line:' };
  const log = lines.filter((l) => /\b(ERROR|WARN|INFO|DEBUG)\b/.test(l)).length;
  if (lines.length >= 3 && log / lines.length >= 0.1) return { type: 'build_output', strategy: 'log', reason: 'log levels' };
  if (/^(diff --git|--- a\/|@@ )/m.test(text)) return { type: 'git_diff', strategy: 'diff', reason: 'diff' };
  const code = lines.filter((l) => /^\s*(def |class |import |function |const |let |return |export |fn |pub )/.test(l)).length;
  if (code >= 3) return { type: 'source_code', strategy: 'code_aware', reason: `${hint.toolName ?? ''} code` };
  return { type: 'plain_text', strategy: 'text', reason: 'fallback' };
}

export interface FakeRouterOptions {
  /** Items kept from a JSON array. */
  keepItems?: number;
  /** Throw on every call (fail-open tests). */
  throwOn?: boolean;
  /** Return an empty string (empty-output guard tests). */
  emptyOn?: boolean;
  /** Return a longer output (inflation tests). */
  inflate?: boolean;
  /** Render JSON arrays as a lossless csv-schema table, the way the real crusher does. */
  losslessTable?: boolean;
  /** Compress plain text by keeping the first N sentences. */
  textKeep?: number;
}

/** Deterministic stand-in for `ContentRouter`. */
export class FakeRouter implements Compressor {
  readonly strategy = 'mixed' as const;
  calls = 0;
  constructor(private readonly opts: FakeRouterOptions = {}) {}

  route(text: string, hint?: { toolName?: string; language?: string }): { type: ContentType; strategy: Strategy; reason: string } {
    return fakeRoute(text, hint ?? {});
  }

  compress(req: CompressRequest): CompressResponse {
    this.calls += 1;
    if (this.opts.throwOn) throw new Error('boom');
    const pass: CompressResponse = { content: req.content, strategy: 'passthrough', chain: ['passthrough'], ccrHashes: [] };
    if (this.opts.emptyOn) return { ...pass, content: '', strategy: 'text', chain: ['text'] };
    if (this.opts.inflate) return { ...pass, content: `${req.content}\n${req.content}`, strategy: 'text', chain: ['text'] };
    const r = fakeRoute(req.content, { toolName: req.toolName });
    if (this.opts.losslessTable && r.type === 'json') {
      // What the real crusher returns for a uniform array: a csv-schema table
      // with every row intact. The lossless step leads the chain and the
      // compressor that produced it follows, and there is no marker because
      // nothing was dropped.
      const items = JSON.parse(req.content) as Array<Record<string, unknown>>;
      const cols = [...new Set(items.flatMap((it) => Object.keys(it)))].sort();
      const rows = items.map((it) => cols.map((c) => String(it[c] ?? '')).join(','));
      const out = `[${items.length}]{${cols.join(',')}}\n${rows.join('\n')}`;
      if (out.length >= req.content.length) return pass;
      return { content: out, strategy: 'smart_crusher', chain: ['lossless_json', 'smart_crusher'], ccrHashes: [], info: `lossless:table(${items.length} rows)`, itemCounts: { original: items.length, kept: items.length } };
    }
    if (r.type === 'json' && r.strategy === 'smart_crusher') {
      const items = JSON.parse(req.content) as unknown[];
      const keep = Math.max(1, Math.floor((this.opts.keepItems ?? 3) * (req.bias ?? 1)));
      if (items.length <= keep) return pass;
      if (req.losslessOnly) {
        const compact = JSON.stringify(items);
        return compact.length < req.content.length ? { content: compact, strategy: 'lossless', chain: ['lossless_json'], ccrHashes: [] } : pass;
      }
      const kept = items.slice(0, keep);
      const dropped = items.length - keep;
      let out = JSON.stringify(kept, null, 1);
      const hashes: string[] = [];
      if (req.injectMarker && req.ccr) {
        const hash = req.ccr.store(req.content, { compressed: out, strategy: 'smart_crusher', originalItemCount: items.length, compressedItemCount: keep, toolName: req.toolName, originalTokens: req.tokenizer.count(req.content), compressedTokens: req.tokenizer.count(out) });
        out = `${out}\n${makeMarker('rows', hash, dropped)}\n${retrieveHint(hash, { originalTokens: req.tokenizer.count(req.content), compressedTokens: req.tokenizer.count(out), toolName: req.toolName })}`;
        hashes.push(hash);
      } else if (req.injectMarker) {
        out = `${out}\n${makeMarker('rows', hashOriginal(req.content), dropped)}`;
      }
      return { content: out, strategy: 'smart_crusher', chain: ['smart_crusher'], ccrHashes: hashes, info: `smart_sample(${items.length}->${keep})`, itemCounts: { original: items.length, kept: keep } };
    }
    if (r.type === 'build_output') {
      const lines = req.content.split('\n');
      if (req.losslessOnly) return pass;
      const kept = lines.filter((l) => /\b(ERROR|WARN|FAIL)\b/.test(l));
      if (kept.length === 0 || kept.length >= lines.length) return pass;
      let out = `${kept.join('\n')}\n[${lines.length - kept.length} lines omitted]`;
      const hashes: string[] = [];
      if (req.injectMarker && req.ccr) {
        const hash = req.ccr.store(req.content, { compressed: out, strategy: 'log', toolName: req.toolName, originalTokens: req.tokenizer.count(req.content), compressedTokens: req.tokenizer.count(out) });
        out += `\n${retrieveHint(hash, { originalTokens: req.tokenizer.count(req.content), compressedTokens: req.tokenizer.count(out), toolName: req.toolName })}`;
        hashes.push(hash);
      }
      return { content: out, strategy: 'log', chain: ['log'], ccrHashes: hashes };
    }
    if (r.type === 'search_results') {
      // Lossless fold: strip a shared directory prefix and restate it once.
      const lines = req.content.split('\n').filter(Boolean);
      const paths = lines.map((l) => l.split(':')[0]);
      const dirs = paths.map((p) => p.slice(0, p.lastIndexOf('/') + 1));
      const common = dirs.every((d) => d === dirs[0]) ? dirs[0] : '';
      if (!common) return pass;
      const out = `@${common}\n${lines.map((l) => l.slice(common.length)).join('\n')}`;
      return out.length < req.content.length ? { content: out, strategy: 'lossless', chain: ['lossless_search'], ccrHashes: [] } : pass;
    }
    if (r.type === 'plain_text' && this.opts.textKeep !== undefined && !req.losslessOnly) {
      const sentences = req.content.split(/(?<=[.!?])\s+/);
      if (sentences.length <= this.opts.textKeep) return pass;
      return { content: sentences.slice(0, this.opts.textKeep).join(' '), strategy: 'text', chain: ['text'], ccrHashes: [] };
    }
    return pass;
  }
}

/** JSON array of 40 uniform records (~2k tokens). */
export function jsonArrayFixture(n = 40): string {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: i + 1, name: `service-${i + 1}`, status: i === 17 ? 'error' : 'ok', latency_ms: 100 + ((i * 37) % 250), region: ['us-east-1', 'eu-west-1', 'ap-south-1'][i % 3] });
  return JSON.stringify(items, null, 2);
}

/** Build log with a couple of errors among many INFO lines. */
export function logFixture(n = 60): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 23) lines.push(`2026-01-01T10:00:${String(i).padStart(2, '0')}Z ERROR worker-3 connection refused to db-primary:5432`);
    else if (i === 41) lines.push(`2026-01-01T10:00:${String(i).padStart(2, '0')}Z WARN worker-1 retrying request 7f3a`);
    else lines.push(`2026-01-01T10:00:${String(i).padStart(2, '0')}Z INFO worker-${i % 4} processed batch ${i} in ${12 + (i % 9)}ms`);
  }
  return lines.join('\n');
}

/** grep-style search output with a shared directory prefix. */
export function grepFixture(n = 30): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`src/services/billing/handlers/invoice_${i % 7}.ts:${10 + i * 3}:  const total = computeTotal(lines[${i}]);`);
  return lines.join('\n');
}

/** 12-message Anthropic conversation: three tool rounds (json, log, grep) plus chatter. */
export function goldenConversation(): Message[] {
  return [
    { role: 'user', content: 'Check the service inventory and tell me which region is unhealthy.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Listing services.' }, { type: 'tool_use', id: 'toolu_01', name: 'list_services', input: { region: 'all' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: jsonArrixture() }] },
    { role: 'assistant', content: [{ type: 'text', text: 'One service reports an error. Pulling its logs.' }, { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'tail -n 60 /var/log/worker.log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: logFixture() }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The database connection is refused. Searching for the retry logic.' }, { type: 'tool_use', id: 'toolu_03', name: 'Grep', input: { pattern: 'computeTotal', path: 'src' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: grepFixture() }] },
    { role: 'assistant', content: 'Found the call sites. The retry loop lives in invoice_3.ts.' },
    { role: 'user', content: 'Show me the handler file.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_04', name: 'Read', input: { file_path: 'src/services/billing/handlers/invoice_3.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_04', content: codeFixture() }] },
    { role: 'user', content: 'Why does the retry never succeed?' },
  ];
}

function jsonArrixture(): string {
  return jsonArrayFixture();
}

/** A TypeScript file (~60 lines). */
export function codeFixture(): string {
  const lines = ['import { db } from "../db.js";', 'import { computeTotal } from "./totals.js";', '', 'export class InvoiceHandler {', '  private attempts = 0;', '  constructor(private readonly maxAttempts: number) {}', ''];
  for (let i = 0; i < 6; i++) {
    lines.push(`  async handle${i}(lines: number[]): Promise<number> {`, '    const total = computeTotal(lines);', '    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {', `      const ok = await db.write("invoice-${i}", total);`, '      if (ok) return total;', '      this.attempts += 1;', '    }', '    return -1;', '  }', '');
  }
  lines.push('}', '');
  return lines.join('\n');
}
