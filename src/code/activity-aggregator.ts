/**
 * Engine-side activity aggregation for host UIs (stream-json protocol v6).
 *
 * The agent loop emits one `tool-call` / `tool-result` / `change` event per
 * tool. Rendering each of those as its own row is what makes a transcript
 * noisy: a three-file edit becomes a dozen rows of reads and searches. This
 * module folds that stream into *activity groups* — one line per burst of
 * consecutive tool work, e.g. `Explored 4 items · Edited 2 files · +18 −7` —
 * plus a single end-of-turn `changes-summary` card.
 *
 * Grouping rule: a group is the run of tool calls between two pieces of
 * user-visible assistant prose. A model that reads, edits and finishes without
 * talking in between produces exactly one group, however many steps it took.
 * Each group has a stable `group` id; a host replaces the line with the same
 * id in place (live updates arrive with `final: false`, the closing frame with
 * `final: true`), so a group never costs more than one visible line.
 *
 * Additive by design: raw tool events still flow, so older hosts and debug
 * views keep working. Pure and deterministic (no clock, no I/O).
 */

import { countDiffStats, unifiedDiff } from './diff.js';
import type { FileChange } from './types.js';

/** A tool-call / change / prose event, the only shapes the aggregator reads. */
export type ActivityInput =
  | { type: 'tool-call'; name: string; args?: Record<string, unknown> }
  | { type: 'change'; change: FileChange }
  | { type: 'assistant'; text: string }
  | { type: string };

/** One activity line, as carried by the `activity` agent event. */
export interface ActivitySnapshot {
  /** Stable per-turn group id (1-based). Hosts update the line with this id in place. */
  group: number;
  /** True on the frame that closes the group (prose followed, or the turn ended). */
  final: boolean;
  /** Ready-to-render line, e.g. `Explored 4 items · Edited 2 files · +18 −7`. */
  summary: string;
  /** Read-only lookups in this group (search, read, list, impact, docs, MCP reads). */
  explored: number;
  /** Distinct files written in this group. */
  edited: number;
  /** Shell commands run in this group. */
  ran: number;
  /** Lines added across this group's edits (per-edit diff stats). */
  added: number;
  /** Lines removed across this group's edits (per-edit diff stats). */
  removed: number;
  /** Distinct tool names batched into this group, in first-seen order. */
  tools: string[];
  /** Distinct repo-relative files edited in this group, in first-seen order. */
  files: string[];
}

/** The end-of-turn Changes card (`changes-summary` agent event). */
export interface ChangesSummary {
  files: Array<{ path: string; added: number; removed: number; status: 'created' | 'modified' | 'deleted' }>;
  totalAdded: number;
  totalRemoved: number;
}

/** Tools that explore (read-only lookups). ACP-mapped kinds land on these names too. */
const EXPLORE_TOOLS = new Set([
  'search_code',
  'read_file',
  'list_files',
  'graph_impact',
  'library_docs',
  'inspect_task',
  'inspect_change',
  'verify_change',
  'web_fetch',
  'web_search',
  // ACP agents' `other`-kind tool calls (typically MCP lookups).
  'acp_tool',
]);

/** Bookkeeping / control tools: never part of a visible activity line. */
const CONTROL_TOOLS = new Set([
  'finish',
  'abort',
  'set_progress',
  'ask_user',
  'vg_retrieve',
  'unparsed-dump',
  'think',
]);

/** Tools that write; their visible effect is counted from `change` events, not the call. */
const WRITE_TOOLS = new Set(['edit_file', 'create_file', 'delete_file', 'apply_patch']);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Render the one-line summary for a group's counters. */
export function formatActivitySummary(c: {
  explored: number;
  edited: number;
  ran: number;
  added: number;
  removed: number;
}): string {
  const parts: string[] = [];
  if (c.explored) parts.push(`Explored ${plural(c.explored, 'item', 'items')}`);
  if (c.ran) parts.push(`Ran ${plural(c.ran, 'command', 'commands')}`);
  if (c.edited) parts.push(`Edited ${plural(c.edited, 'file', 'files')}`);
  if (c.added || c.removed) parts.push(`+${c.added} −${c.removed}`);
  return parts.join(' · ') || 'Working…';
}

export class ActivityAggregator {
  private group = 0;
  /** The current group is closed; the next tool work opens a new one. */
  private sealed = true;
  private explored = 0;
  private ran = 0;
  private added = 0;
  private removed = 0;
  private tools = new Set<string>();
  private files = new Set<string>();
  /** Something changed since the last emitted frame. */
  private pending = false;
  /** Number of groups opened this turn (= visible activity lines). */
  get groups(): number {
    return this.group;
  }

  private open(): void {
    if (!this.sealed) return;
    this.group++;
    this.sealed = false;
    this.explored = 0;
    this.ran = 0;
    this.added = 0;
    this.removed = 0;
    this.tools = new Set();
    this.files = new Set();
  }

  /** True when the open group has anything worth a line. */
  private hasContent(): boolean {
    return !this.sealed && (this.tools.size > 0 || this.files.size > 0);
  }

  observe(e: ActivityInput): void {
    if (e.type === 'tool-call') {
      const name = (e as { name: string }).name;
      if (CONTROL_TOOLS.has(name)) return;
      this.open();
      this.tools.add(name);
      if (name === 'run_command') this.ran++;
      else if (!WRITE_TOOLS.has(name) && isExploreTool(name)) this.explored++;
      this.pending = true;
      return;
    }
    if (e.type === 'change') {
      const change = (e as { change: FileChange }).change;
      this.open();
      this.files.add(change.file);
      const stats = countDiffStats(change.diff ?? '');
      this.added += stats.added;
      this.removed += stats.removed;
      this.pending = true;
    }
  }

  private snapshot(final: boolean): ActivitySnapshot {
    const counters = {
      explored: this.explored,
      edited: this.files.size,
      ran: this.ran,
      added: this.added,
      removed: this.removed,
    };
    return {
      group: this.group,
      final,
      summary: formatActivitySummary(counters),
      ...counters,
      tools: [...this.tools],
      files: [...this.files],
    };
  }

  /**
   * Live update for the open group (step boundary). Null when nothing changed
   * since the last frame, so idle steps cost the host nothing.
   */
  flush(): ActivitySnapshot | null {
    if (!this.pending || !this.hasContent()) return null;
    this.pending = false;
    return this.snapshot(false);
  }

  /**
   * Close the open group (prose follows, or the turn ends). Returns the final
   * frame, or null when no group is open. Later tool work opens a new group.
   */
  seal(): ActivitySnapshot | null {
    if (!this.hasContent()) {
      this.sealed = true;
      return null;
    }
    const snap = this.snapshot(true);
    this.sealed = true;
    this.pending = false;
    return snap;
  }
}

/** Read-only lookups: the built-in discovery set plus MCP / vendor read tools. */
function isExploreTool(name: string): boolean {
  if (EXPLORE_TOOLS.has(name)) return true;
  // Project / built-in MCP tools (mcp__server__tool) are lookups unless they
  // write, and their writes surface as `change` events of their own.
  if (name.startsWith('mcp__')) return true;
  return name === 'search' || name === 'read' || name === 'fetch' || name === 'spawn_subagent';
}

/**
 * The Changes card: one row per file with the NET effect of the turn (first
 * `before` → last `after`), so a file edited three times shows one row, and an
 * edit that was later reverted drops out. Files keep first-edit order.
 */
export function summarizeChanges(changes: readonly FileChange[]): ChangesSummary {
  const byFile = new Map<string, { before: string | null; after: string | null }>();
  for (const c of changes) {
    const prior = byFile.get(c.file);
    if (prior) prior.after = c.after;
    else byFile.set(c.file, { before: c.before, after: c.after });
  }
  const files: ChangesSummary['files'] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const [file, { before, after }] of byFile) {
    if (before === after) continue; // net no-op (edited, then reverted)
    const { added, removed } = countDiffStats(unifiedDiff(before, after, file));
    const status = before === null ? 'created' : after === null ? 'deleted' : 'modified';
    files.push({ path: file, added, removed, status });
    totalAdded += added;
    totalRemoved += removed;
  }
  return { files, totalAdded, totalRemoved };
}
