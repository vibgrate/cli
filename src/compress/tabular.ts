/**
 * Tabular text (CSV / TSV / markdown tables / fixed-width) → records →
 * SmartCrusher. No new algorithm: the bridge parses rows into objects and
 * hands them to `crushArray`, which does lossless csv-schema compaction first
 * and the marked keep/drop path as a fallback. Ragged tables (rows whose
 * cell count differs from the header) pass through verbatim — a compressed
 * table must never state facts the original did not.
 */

import { crushArray, droppedSentinel, DEFAULT_CRUSHER_CONFIG, type CrusherConfig } from './crusher.js';
import { isMarkdownSeparator, tryDetectTabular } from './detect.js';
import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export type TabularFormat = 'csv' | 'markdown' | 'fixed_width';

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  format: TabularFormat;
  delimiter?: string;
}

/** RFC-4180-ish CSV parser (quoted fields, doubled quotes, CRLF). Rows that are all-blank are dropped. */
export function parseCsv(content: string, delimiter = ','): { headers: string[]; rows: string[][] } {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = content.length;
  const endRow = (): void => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) records.push(row);
    row = [];
  };
  while (i < n) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length) endRow();
  if (!records.length) return { headers: [], rows: [] };
  return { headers: records[0].map((h) => h.trim()), rows: records.slice(1) };
}

export function parseMarkdownTable(content: string): { headers: string[]; rows: string[][] } {
  const split = (row: string): string[] => {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const lines = content.split('\n').filter((l) => l.trim() && l.includes('|'));
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = split(lines[0]);
  const rows = lines
    .slice(1)
    .filter((l) => !isMarkdownSeparator(l))
    .map(split);
  return { headers, rows };
}

export function parseFixedWidth(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const split = (l: string): string[] => l.trim().split(/\s{2,}/);
  return { headers: split(lines[0]), rows: lines.slice(1).map(split) };
}

export function toRecords(headers: string[], rows: string[][]): Array<Record<string, string>> {
  if (!headers.length) return [];
  return rows.map((row) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = row[i] ?? '';
    });
    return rec;
  });
}

/** Detect and parse; null when not tabular or ragged. */
export function parseTabular(content: string): ParsedTable | null {
  const det = tryDetectTabular(content);
  if (!det || det.confidence < 0.6) return null;
  const format = (det.metadata.format as string) === 'markdown' ? 'markdown' : (det.metadata.format as string) === 'fixed_width' ? 'fixed_width' : 'csv';
  const delimiter = format === 'csv' ? ((det.metadata.delimiter as string) ?? ',') : undefined;
  const parsed = format === 'markdown' ? parseMarkdownTable(content) : format === 'fixed_width' ? parseFixedWidth(content) : parseCsv(content, delimiter);
  if (!parsed.headers.length || !parsed.rows.length) return null;
  const width = parsed.headers.length;
  if (parsed.rows.some((r) => r.length !== width)) return null;
  return { headers: parsed.headers, rows: parsed.rows, format, delimiter };
}

export class TabularCompressor implements Compressor {
  readonly strategy = 'tabular' as const;
  readonly config: CrusherConfig;

  constructor(config: Partial<CrusherConfig> = {}) {
    this.config = { ...DEFAULT_CRUSHER_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['tabular', 'passthrough'], ccrHashes: [], info });
    try {
      const parsed = parseTabular(content);
      if (!parsed) return passthrough('not_tabular');
      const records = toRecords(parsed.headers, parsed.rows);
      if (records.length < 2) return passthrough('too_few_rows');
      const cfg: CrusherConfig = { ...this.config, losslessOnly: this.config.losslessOnly || req.losslessOnly };
      const r = crushArray(
        records,
        {
          query: req.query,
          bias: req.bias ?? req.profile?.bias,
          maxItems: req.profile?.maxItemsAfterCrush,
          ccr: req.ccr ?? null,
          injectMarker: req.injectMarker && !cfg.losslessOnly,
          preserveKeywords: req.profile?.preserveKeywords,
          toolName: req.toolName,
          originalText: content,
          originalTokens: req.tokenizer.count(content),
        },
        cfg,
      );
      let out: string;
      let lossless: boolean;
      if (r.compacted !== undefined) {
        out = r.compacted.replace(/\n$/, '');
        lossless = true;
      } else if (r.dropped > 0) {
        out = JSON.stringify([...r.items, droppedSentinel(r.dropped, r.ccrHash)]);
        if (r.droppedSummary) out += `\n${r.droppedSummary}`;
        lossless = false;
      } else return passthrough(r.strategyInfo);
      if (out.length >= content.length) return passthrough(`${r.strategyInfo}:not_smaller`);
      return {
        content: out,
        strategy: 'tabular',
        chain: lossless ? ['lossless_tabular', 'tabular'] : ['tabular'],
        ccrHashes: r.ccrHash ? [r.ccrHash] : [],
        info: `${parsed.format}:${r.strategyInfo}`,
        itemCounts: { original: records.length, kept: records.length - r.dropped },
      };
    } catch {
      return passthrough('error');
    }
  }
}
