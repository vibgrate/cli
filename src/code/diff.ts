/**
 * Deterministic unified diff (VG-CLI-CODE §4.3).
 *
 * A `vg code` dry-run shows the human/agent exactly what would change *before*
 * anything is written — the "inspect the proposal" half of the governance
 * lifecycle. This is a small, dependency-free Myers-style line diff producing
 * standard unified-diff hunks. Identical (before, after) always renders the
 * identical text, so the dry-run output is stable and diff-able in tests and
 * benchmarks.
 */

/** Render a unified diff for one file. Returns '' when there is no change. */
export function unifiedDiff(before: string | null, after: string | null, file: string, context = 3): string {
  if (before === after) return '';
  if (before === null) return newFileDiff(after ?? '', file);
  if (after === null) return deletedFileDiff(before, file);

  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  const hunks = groupHunks(ops, context);
  if (hunks.length === 0) return '';

  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
    for (const line of h.lines) out.push(line);
  }
  return out.join('\n');
}

/**
 * Whole-file create/delete bodies larger than this are summarized instead of
 * line-dumped. Small files stay fully visible for review; large page deletes
 * (hundreds/thousands of lines) only need path + line count in the transcript.
 */
const FULL_BODY_LINE_CAP = 40;

function newFileDiff(after: string, file: string): string {
  const lines = splitLines(after);
  const out = [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`];
  if (lines.length > FULL_BODY_LINE_CAP) {
    out.push(`+… ${lines.length} lines added …`);
    return out.join('\n');
  }
  for (const l of lines) out.push(`+${l}`);
  return out.join('\n');
}

function deletedFileDiff(before: string, file: string): string {
  const lines = splitLines(before);
  const n = lines.length;
  const out = [`--- a/${file}`, `+++ /dev/null`, `@@ -1,${n} +0,0 @@`];
  // No — we do not need the full body in the panel when a page is deleted.
  // Undo still keeps FileChange.before; approval is path-only for delete_file.
  if (n > FULL_BODY_LINE_CAP) {
    out.push(`-… ${n} lines deleted …`);
    return out.join('\n');
  }
  for (const l of lines) out.push(`-${l}`);
  return out.join('\n');
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  // A trailing newline yields a final '' element — drop it so line counts match.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { tag: 'eq' | 'del' | 'add'; line: string };

/**
 * Line diff via LCS (dynamic programming). O(n·m) space is fine for source
 * files; the deterministic backtrace (favouring deletions before additions on
 * ties) keeps output stable.
 */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'eq', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ tag: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ tag: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ tag: 'del', line: a[i++] });
  while (j < m) ops.push({ tag: 'add', line: b[j++] });
  return ops;
}

interface Hunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  lines: string[];
}

/** Group the op stream into unified-diff hunks with `context` equal lines around changes. */
function groupHunks(ops: Op[], context: number): Hunk[] {
  // Index of each op that is a change (del/add).
  const changeIdx = ops.map((o, i) => (o.tag === 'eq' ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return [];

  // Merge change indices into windows that share context.
  const windows: [number, number][] = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length - 1, changeIdx[0] + context);
  for (let k = 1; k < changeIdx.length; k++) {
    const cs = Math.max(0, changeIdx[k] - context);
    const ce = Math.min(ops.length - 1, changeIdx[k] + context);
    if (cs <= end + 1) {
      end = ce;
    } else {
      windows.push([start, end]);
      start = cs;
      end = ce;
    }
  }
  windows.push([start, end]);

  const hunks: Hunk[] = [];
  // Running 1-based line numbers into a and b.
  let aLine = 1;
  let bLine = 1;
  let idx = 0;
  for (const [ws, we] of windows) {
    // advance line counters up to window start
    while (idx < ws) {
      const o = ops[idx];
      if (o.tag !== 'add') aLine++;
      if (o.tag !== 'del') bLine++;
      idx++;
    }
    const hunk: Hunk = { aStart: aLine, aLen: 0, bStart: bLine, bLen: 0, lines: [] };
    for (let k = ws; k <= we; k++) {
      const o = ops[k];
      if (o.tag === 'eq') {
        hunk.lines.push(` ${o.line}`);
        hunk.aLen++;
        hunk.bLen++;
        aLine++;
        bLine++;
      } else if (o.tag === 'del') {
        hunk.lines.push(`-${o.line}`);
        hunk.aLen++;
        aLine++;
      } else {
        hunk.lines.push(`+${o.line}`);
        hunk.bLen++;
        bLine++;
      }
      idx = k + 1;
    }
    // A hunk that starts at line 1 with zero length should report start 0.
    if (hunk.aLen === 0) hunk.aStart = Math.max(0, hunk.aStart - 1);
    if (hunk.bLen === 0) hunk.bStart = Math.max(0, hunk.bStart - 1);
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * Count +/− lines in a unified diff. Whole-file create/delete summaries
 * (`+… N lines added …` / `-… N lines deleted …`) use the hunk header for the
 * true line count so the rollup stays accurate when bodies are compacted.
 */
export function countDiffStats(diff: string): { added: number; removed: number } {
  if (!diff) return { added: 0, removed: 0 };

  const isWholeDelete = /^\+\+\+ \/dev\/null$/m.test(diff);
  const isWholeCreate = /^--- \/dev\/null$/m.test(diff);
  if (isWholeDelete) {
    const m = diff.match(/@@ -(\d+)(?:,(\d+))? \+0(?:,0)? @@/);
    if (m) {
      const n = m[2] != null ? Number(m[2]) : Number(m[1]) || 0;
      return { added: 0, removed: Number.isFinite(n) ? n : 0 };
    }
  }
  if (isWholeCreate) {
    const m = diff.match(/@@ -0(?:,0)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      const n = m[2] != null ? Number(m[2]) : Number(m[1]) || 0;
      return { added: Number.isFinite(n) ? n : 0, removed: 0 };
    }
  }

  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** A compact one-line changeset summary: `+adds -dels across N file(s)`. */
export function summarizeDiffs(diffs: { file: string; diff: string }[]): string {
  let adds = 0;
  let dels = 0;
  let touched = 0;
  for (const { diff } of diffs) {
    if (!diff) continue;
    touched++;
    const { added, removed } = countDiffStats(diff);
    adds += added;
    dels += removed;
  }
  return `+${adds} -${dels} across ${touched} file(s)`;
}
