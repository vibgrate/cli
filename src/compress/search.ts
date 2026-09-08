/**
 * Search-result (grep / ripgrep / ag) compressor. Parses `file:line:content`
 * and `file-line-content` rows with a tiered scanner that survives Windows
 * drive colons, dated paths and dashed file names, scores matches by query
 * overlap and error/warning/importance keywords, caps files and matches under
 * an adaptive budget, and re-emits `file:line:content` rows plus
 * `[... and N more matches in file]` summaries. `rg --json` input is
 * converted first.
 */

import { computeOptimalK } from './adaptive.js';
import { ripgrepJsonToGrep } from './detect.js';
import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export interface SearchMatch {
  file: string;
  lineNumber: number;
  content: string;
  score: number;
}

export interface SearchCompressorConfig {
  maxMatchesPerFile: number;
  alwaysKeepFirst: boolean;
  alwaysKeepLast: boolean;
  maxTotalMatches: number;
  maxFiles: number;
  contextKeywords: string[];
  boostErrors: boolean;
  groupByFile: boolean;
  minMatches: number;
}

export const DEFAULT_SEARCH_CONFIG: Readonly<SearchCompressorConfig> = {
  maxMatchesPerFile: 5,
  alwaysKeepFirst: true,
  alwaysKeepLast: true,
  maxTotalMatches: 30,
  maxFiles: 15,
  contextKeywords: [],
  boostErrors: true,
  groupByFile: false,
  minMatches: 10,
};

const ERROR_RE = /\b(error|exception|fail|failed|failure|fatal|critical|crash|panic|abort|timeout|denied|rejected)\b/i;
const WARNING_RE = /\b(warn|warning)\b/i;
const IMPORTANCE_RE = /\b(important|note|todo|fixme|hack|xxx|bug|fix)\b/i;

/** Keyword priority for a search line: error 0.5, warning 0.4, importance 0.3, else 0. */
export function priorityBoost(line: string): number {
  if (ERROR_RE.test(line)) return 0.5;
  if (WARNING_RE.test(line)) return 0.4;
  if (IMPORTANCE_RE.test(line)) return 0.3;
  return 0;
}

function isCjk(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff);
}

/** Character bigrams of the CJK runs of a (lowercased) query. */
export function cjkBigrams(text: string): Set<string> {
  const out = new Set<string>();
  let run: string[] = [];
  const flush = (): void => {
    for (let i = 0; i + 1 < run.length; i++) out.add(run[i] + run[i + 1]);
    run = [];
  };
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0) as number)) run.push(ch);
    else flush();
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Tier = 'colon' | 'dash' | 'permissive';

function hasExtensionDot(tok: string): boolean {
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] !== '.' || i + 1 === tok.length) continue;
    const tail = tok.slice(i + 1);
    const m = /^[A-Za-z0-9]*/.exec(tail);
    const ext = m ? m[0] : '';
    if (ext.length >= 1 && ext.length <= 8 && /[A-Za-z]/.test(ext)) return true;
  }
  return false;
}

function lastSegmentHasExtension(path: string): boolean {
  const seg = path.split(/[/\\]/).pop() ?? path;
  return hasExtensionDot(seg);
}

function pathContinues(rest: string): boolean {
  const tok = rest.split(/\s/)[0];
  return tok.length > 0 && (tok.includes('/') || tok.includes('\\') || hasExtensionDot(tok));
}

function scanMatchLine(line: string, tier: Tier): [string, number, string] | null {
  const scanStart = line.length >= 3 && /[A-Za-z]/.test(line[0]) && line[1] === ':' && (line[2] === '\\' || line[2] === '/') ? 2 : 0;
  let first: [number, number, number] | null = null;
  let chosen: [number, number, number] | null = null;
  let i = scanStart;
  let sawWhitespace = false;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) sawWhitespace = true;
    const tierSep = tier === 'colon' ? ch === ':' : tier === 'dash' ? ch === '-' : ch === ':' || ch === '-';
    if (tierSep) {
      if (i > 0 && (line[i - 1] === ':' || line[i - 1] === '-')) {
        i++;
        continue;
      }
      if (tier !== 'permissive' && sawWhitespace) break;
      const digitsStart = i + 1;
      let j = digitsStart;
      while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
      const closes = j > digitsStart && j < line.length && (tier === 'permissive' ? line[j] === ':' || line[j] === '-' : line[j] === ch);
      if (closes) {
        if (i === 0) return null;
        if (!first) first = [i, digitsStart, j];
        if (tier !== 'dash') {
          chosen = [i, digitsStart, j];
          break;
        }
        if (lastSegmentHasExtension(line.slice(0, i)) || !pathContinues(line.slice(j + 1))) {
          chosen = [i, digitsStart, j];
          break;
        }
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  const pick = chosen ?? first;
  if (!pick) return null;
  const [pathEnd, ds, de] = pick;
  const n = Number.parseInt(line.slice(ds, de), 10);
  if (!Number.isFinite(n)) return null;
  return [line.slice(0, pathEnd), n, line.slice(de + 1)];
}

/** `(file, line, content)` for a grep/ripgrep row; null when unparseable. */
export function parseMatchLine(line: string): [string, number, string] | null {
  return scanMatchLine(line, 'colon') ?? scanMatchLine(line, 'dash') ?? scanMatchLine(line, 'permissive');
}

export interface ParsedSearch {
  files: Map<string, SearchMatch[]>;
  unparsed: number;
  scanned: number;
}

export function parseSearchResults(content: string): ParsedSearch {
  const files = new Map<string, SearchMatch[]>();
  let unparsed = 0;
  let scanned = 0;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    scanned++;
    const m = parseMatchLine(line);
    if (!m) {
      unparsed++;
      continue;
    }
    let list = files.get(m[0]);
    if (!list) {
      list = [];
      files.set(m[0], list);
    }
    list.push({ file: m[0], lineNumber: m[1], content: m[2], score: 0 });
  }
  return { files, unparsed, scanned };
}

// ---------------------------------------------------------------------------
// Scoring / selection / formatting
// ---------------------------------------------------------------------------

export function scoreMatches(files: Map<string, SearchMatch[]>, query: string, cfg: SearchCompressorConfig): void {
  const lower = query.toLowerCase();
  const words = new Set<string>(lower.split(/\s+/).filter((w) => [...w].length > 2));
  for (const bg of cjkBigrams(lower)) words.add(bg);
  const keywords = cfg.contextKeywords.map((k) => k.toLowerCase());
  for (const matches of files.values()) {
    for (const m of matches) {
      let score = 0;
      const c = m.content.toLowerCase();
      for (const w of words) if (c.includes(w)) score += 0.3;
      if (cfg.boostErrors) score += priorityBoost(m.content);
      for (const k of keywords) if (c.includes(k)) score += 0.4;
      m.score = Math.min(1, score);
    }
  }
}

export function selectMatches(files: Map<string, SearchMatch[]>, bias: number, cfg: SearchCompressorConfig): Map<string, SearchMatch[]> {
  const total = (ms: SearchMatch[]): number => ms.reduce((a, m) => a + m.score, 0);
  let ordered = [...files.entries()].sort((a, b) => total(b[1]) - total(a[1]));
  if (ordered.length > cfg.maxFiles) ordered = ordered.slice(0, cfg.maxFiles);
  const all: string[] = [];
  for (const [file, ms] of ordered) for (const m of ms) all.push(`${file}:${m.lineNumber}:${m.content}`);
  const adaptiveTotal = computeOptimalK(all, bias, 5, cfg.maxTotalMatches);
  const selected = new Map<string, SearchMatch[]>();
  let count = 0;
  for (const [file, ms] of ordered) {
    if (count >= adaptiveTotal) continue;
    const sorted = [...ms].sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber);
    const cap = Math.min(cfg.maxMatchesPerFile, adaptiveTotal - count);
    const picked: SearchMatch[] = [];
    const seen = new Set<string>();
    const push = (m: SearchMatch): void => {
      const key = `${m.lineNumber} ${m.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        picked.push(m);
      }
    };
    if (cfg.alwaysKeepFirst && picked.length < cap) push(ms[0]);
    if (cfg.alwaysKeepLast && ms.length > 1 && picked.length < cap) push(ms[ms.length - 1]);
    for (const m of sorted) {
      if (picked.length >= cap) break;
      push(m);
    }
    picked.sort((a, b) => a.lineNumber - b.lineNumber);
    count += picked.length;
    selected.set(file, picked);
  }
  return selected;
}

export function formatSearchOutput(selected: Map<string, SearchMatch[]>, original: Map<string, SearchMatch[]>, cfg: SearchCompressorConfig): string {
  const lines: string[] = [];
  for (const [file, ms] of selected) {
    if (cfg.groupByFile) {
      if (lines.length) lines.push('');
      lines.push(file);
      for (const m of ms) lines.push(`${m.lineNumber}:${m.content}`);
    } else for (const m of ms) lines.push(`${m.file}:${m.lineNumber}:${m.content}`);
    const orig = original.get(file);
    if (orig && orig.length > ms.length) {
      const omitted = orig.length - ms.length;
      lines.push(cfg.groupByFile ? `[... and ${omitted} more matches]` : `[... and ${omitted} more matches in ${file}]`);
    }
  }
  return lines.join('\n');
}

export class SearchCompressor implements Compressor {
  readonly strategy = 'search' as const;
  readonly config: SearchCompressorConfig;

  constructor(config: Partial<SearchCompressorConfig> = {}) {
    this.config = { ...DEFAULT_SEARCH_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['search', 'passthrough'], ccrHashes: [], info });
    try {
      const rg = ripgrepJsonToGrep(content);
      const source = rg ? rg.rows : content;
      const parsed = parseSearchResults(source);
      if (parsed.files.size === 0) return passthrough('no_matches');
      const originalCount = [...parsed.files.values()].reduce((a, ms) => a + ms.length, 0);
      if (originalCount < this.config.minMatches) {
        if (rg && rg.rows.length < content.length) return { content: rg.rows, strategy: 'search', chain: ['search'], ccrHashes: [], info: `search:ripgrep-json(${originalCount} matches)`, itemCounts: { original: originalCount, kept: originalCount } };
        return passthrough('below_min_matches');
      }
      scoreMatches(parsed.files, req.query ?? '', this.config);
      const selected = selectMatches(parsed.files, req.bias ?? req.profile?.bias ?? 1, this.config);
      const out = formatSearchOutput(selected, parsed.files, this.config);
      const kept = [...selected.values()].reduce((a, ms) => a + ms.length, 0);
      if (out.length >= content.length) return passthrough('no_savings');
      const lossless = kept === originalCount && parsed.unparsed === 0 && selected.size === parsed.files.size;
      return {
        content: out,
        strategy: 'search',
        chain: lossless ? ['lossless_search', 'search'] : ['search'],
        ccrHashes: [],
        info: `search${rg ? ':ripgrep-json' : ''}(${originalCount}->${kept} matches, ${parsed.files.size} files)`,
        itemCounts: { original: originalCount, kept },
      };
    } catch {
      return passthrough('error');
    }
  }
}
