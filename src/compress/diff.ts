/**
 * Unified-diff compressor. Parses files + hunks (regular and combined-diff
 * headers), caps the file count (heaviest by changes first), caps hunks per
 * file (first + last + top-scored middle, relevance-aware), trims context to
 * `maxContextLines` around every `+`/`-` line while always keeping
 * `\ No newline` markers, and re-emits the diff with a `[N files changed, +A -D lines, H hunks omitted]`
 * footer. Pre-diff content (commit / email headers) and rename markers are
 * preserved verbatim. Never chained with a lossy text pass.
 */

import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export interface DiffCompressorConfig {
  maxContextLines: number;
  maxHunksPerFile: number;
  maxFiles: number;
  minLines: number;
}

export const DEFAULT_DIFF_CONFIG: Readonly<DiffCompressorConfig> = { maxContextLines: 2, maxHunksPerFile: 10, maxFiles: 20, minLines: 50 };

export const SCORE_CHANGE_DENSITY_WEIGHT = 0.03;
export const SCORE_CHANGE_DENSITY_CAP = 0.3;
export const SCORE_CONTEXT_WORD_WEIGHT = 0.2;
export const SCORE_PRIORITY_PATTERN_BOOST = 0.3;

export interface DiffHunk {
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
  contextLines: number;
  score: number;
}

export interface DiffFile {
  header: string;
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  renameLines: string[];
  modeLines: string[];
  binaryLine?: string;
}

const HUNK_HEADER_RE = /^(?:@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|@@@ -\d+(?:,\d+)? -\d+(?:,\d+)? \+\d+(?:,\d+)? @@@|@@@@ -\d+(?:,\d+)? -\d+(?:,\d+)? -\d+(?:,\d+)? \+\d+(?:,\d+)? @@@@)/;
const DIFF_HEADER_RE = /^diff --(?:git a\/.+ b\/.+|combined .+|cc .+)$/;
const OLD_FILE_RE = /^--- (?:a\/.+|\/dev\/null)$/;
const NEW_FILE_RE = /^\+\+\+ (?:b\/.+|\/dev\/null)$/;
const BINARY_RE = /^Binary files .+ differ$/;
const PRIORITY_RES: readonly RegExp[] = [/\b(error|exception|fail(?:ed|ure)?|fatal|critical|crash|panic)\b/i, /\b(important|note|todo|fixme|hack|xxx|bug|fix)\b/i, /\b(security|auth|password|secret|token)\b/i];

export interface ParsedDiff {
  preDiffLines: string[];
  files: DiffFile[];
}

export function parseDiff(lines: readonly string[]): ParsedDiff {
  const files: DiffFile[] = [];
  const pre: string[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  const closeHunk = (): void => {
    if (hunk && file) file.hunks.push(hunk);
    hunk = null;
  };
  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) {
      closeHunk();
      if (file) files.push(file);
      file = { header: line, oldFile: '', newFile: '', hunks: [], isBinary: false, isNewFile: false, isDeletedFile: false, renameLines: [], modeLines: [] };
      continue;
    }
    if (!file) {
      pre.push(line);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('new file mode')) {
        file.isNewFile = true;
        file.modeLines.push(line);
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        file.isDeletedFile = true;
        file.modeLines.push(line);
        continue;
      }
      if (/^(rename |similarity |copy |dissimilarity |old mode|new mode)/.test(line)) {
        file.renameLines.push(line);
        continue;
      }
      if (BINARY_RE.test(line)) {
        file.isBinary = true;
        file.binaryLine = line;
        continue;
      }
      if (OLD_FILE_RE.test(line)) {
        file.oldFile = line;
        continue;
      }
      if (NEW_FILE_RE.test(line)) {
        file.newFile = line;
        continue;
      }
    }
    if (HUNK_HEADER_RE.test(line)) {
      closeHunk();
      hunk = { header: line, lines: [], additions: 0, deletions: 0, contextLines: 0, score: 0 };
      continue;
    }
    if (hunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        hunk.additions++;
        hunk.lines.push(line);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        hunk.deletions++;
        hunk.lines.push(line);
      } else if (line.startsWith(' ') || line === '') {
        hunk.contextLines++;
        hunk.lines.push(line);
      } else hunk.lines.push(line);
    }
  }
  closeHunk();
  if (file) files.push(file);
  return { preDiffLines: pre, files };
}

function isCjk(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff);
}

function cjkBigrams(text: string): string[] {
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
  return [...out];
}

export function scoreHunks(files: DiffFile[], query: string): void {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const bigrams = cjkBigrams(lower);
  for (const f of files) {
    for (const h of f.hunks) {
      let score = Math.min(SCORE_CHANGE_DENSITY_CAP, (h.additions + h.deletions) * SCORE_CHANGE_DENSITY_WEIGHT);
      const body = h.lines.join('\n').toLowerCase();
      for (const w of words) if (body.includes(w)) score += SCORE_CONTEXT_WORD_WEIGHT;
      for (const bg of bigrams) if (body.includes(bg)) score += SCORE_CONTEXT_WORD_WEIGHT;
      for (const re of PRIORITY_RES) {
        if (re.test(body)) {
          score += SCORE_PRIORITY_PATTERN_BOOST;
          break;
        }
      }
      h.score = Math.min(1, score);
    }
  }
}

function hunkStartLine(header: string): number {
  const m = /\+(\d+)/.exec(header);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** First + last + top-scored middle, re-sorted by start line. */
export function selectHunks(hunks: DiffHunk[], maxPerFile: number): { selected: DiffHunk[]; dropped: DiffHunk[] } {
  if (hunks.length <= maxPerFile) return { selected: hunks, dropped: [] };
  const first = hunks[0];
  const last = hunks.length > 1 ? hunks[hunks.length - 1] : null;
  const middle = hunks.slice(1, last ? -1 : undefined).map((h, i) => ({ h, i }));
  const slots = Math.max(0, maxPerFile - (last ? 2 : 1));
  middle.sort((a, b) => b.h.score - a.h.score || a.i - b.i);
  const kept = middle.slice(0, slots).map((x) => x.h);
  const dropped = middle.slice(slots).map((x) => x.h);
  const selected = [first, ...kept, ...(last ? [last] : [])].sort((a, b) => hunkStartLine(a.header) - hunkStartLine(b.header));
  return { selected, dropped };
}

/** Keep `maxContext` lines around every `+`/`-`; `\`-prefixed markers always survive. */
export function reduceContext(hunk: DiffHunk, maxContext: number): DiffHunk {
  const changes: number[] = [];
  hunk.lines.forEach((l, i) => {
    if (l.startsWith('+') || l.startsWith('-')) changes.push(i);
  });
  if (!changes.length) {
    const take = Math.min(maxContext, hunk.lines.length);
    return { header: hunk.header, lines: hunk.lines.slice(0, take), additions: 0, deletions: 0, contextLines: take, score: hunk.score };
  }
  const keep = new Set<number>();
  for (const pos of changes) {
    for (let i = Math.max(0, pos - maxContext); i <= Math.min(hunk.lines.length - 1, pos + maxContext); i++) keep.add(i);
  }
  hunk.lines.forEach((l, i) => l.startsWith('\\') && keep.add(i));
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let context = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const l = hunk.lines[i];
    lines.push(l);
    if (l.startsWith('+')) additions++;
    else if (l.startsWith('-')) deletions++;
    else context++;
  }
  return { header: hunk.header, lines, additions, deletions, contextLines: context, score: hunk.score };
}

export function formatDiffOutput(pre: readonly string[], files: readonly DiffFile[], totals: { additions: number; deletions: number; hunksRemoved: number }): string {
  const out: string[] = [...pre];
  for (const f of files) {
    out.push(f.header);
    for (const l of f.renameLines) out.push(l);
    for (const l of f.modeLines) out.push(l);
    if (f.isBinary) {
      out.push(f.binaryLine ?? 'Binary files differ');
      continue;
    }
    if (f.oldFile) out.push(f.oldFile);
    if (f.newFile) out.push(f.newFile);
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) out.push(l);
    }
  }
  if (files.length > 0 || totals.hunksRemoved > 0) {
    const parts = [`${files.length} files changed`, `+${totals.additions} -${totals.deletions} lines`];
    if (totals.hunksRemoved > 0) parts.push(`${totals.hunksRemoved} hunks omitted`);
    out.push(`[${parts.join(', ')}]`);
  }
  return out.join('\n');
}

export interface DiffCompressionStats {
  filesTotal: number;
  filesKept: number;
  hunksTotal: number;
  hunksKept: number;
  additions: number;
  deletions: number;
}

export function compressDiff(content: string, query: string, cfg: DiffCompressorConfig = DEFAULT_DIFF_CONFIG): { text: string; stats: DiffCompressionStats } | null {
  const lines = content.split('\n');
  if (lines.length < cfg.minLines) return null;
  const parsed = parseDiff(lines);
  if (!parsed.files.length) return null;
  let files = parsed.files;
  const stats: DiffCompressionStats = { filesTotal: files.length, filesKept: 0, hunksTotal: files.reduce((a, f) => a + f.hunks.length, 0), hunksKept: 0, additions: 0, deletions: 0 };
  scoreHunks(files, query);
  const changes = (f: DiffFile): number => f.hunks.reduce((a, h) => a + h.additions + h.deletions, 0);
  if (files.length > cfg.maxFiles) files = [...files].sort((a, b) => changes(b) - changes(a)).slice(0, cfg.maxFiles);
  let hunksRemoved = 0;
  const compressed: DiffFile[] = files.map((f) => {
    stats.additions += f.hunks.reduce((a, h) => a + h.additions, 0);
    stats.deletions += f.hunks.reduce((a, h) => a + h.deletions, 0);
    const { selected } = selectHunks(f.hunks, cfg.maxHunksPerFile);
    hunksRemoved += f.hunks.length - selected.length;
    return { ...f, hunks: selected.map((h) => reduceContext(h, cfg.maxContextLines)) };
  });
  stats.filesKept = compressed.length;
  stats.hunksKept = compressed.reduce((a, f) => a + f.hunks.length, 0);
  const text = formatDiffOutput(parsed.preDiffLines, compressed, { additions: stats.additions, deletions: stats.deletions, hunksRemoved });
  return { text, stats };
}

export class DiffCompressor implements Compressor {
  readonly strategy = 'diff' as const;
  readonly config: DiffCompressorConfig;

  constructor(config: Partial<DiffCompressorConfig> = {}) {
    this.config = { ...DEFAULT_DIFF_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['diff', 'passthrough'], ccrHashes: [], info });
    try {
      const r = compressDiff(content, req.query ?? '', this.config);
      if (!r) return passthrough('not_diff_or_too_short');
      if (r.text.length >= content.length) return passthrough('no_savings');
      return {
        content: r.text,
        strategy: 'diff',
        chain: ['diff'],
        ccrHashes: [],
        info: `diff(${r.stats.filesTotal}->${r.stats.filesKept} files, ${r.stats.hunksTotal}->${r.stats.hunksKept} hunks)`,
        itemCounts: { original: r.stats.hunksTotal, kept: r.stats.hunksKept },
      };
    } catch {
      return passthrough('error');
    }
  }
}
