/**
 * Session todo / focus-chain state for VG Code.
 *
 * The model updates items via `set_progress`; the host renders a live checklist.
 * Verification-ladder steps can mark items done when their commands pass.
 * On a successful `finish`, open items are completed automatically so the panel
 * does not leave a trailing "still working" row after the answer lands.
 */

export type ProgressStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface ProgressItem {
  id: string;
  title: string;
  status: ProgressStatus;
}

export interface ProgressState {
  items: ProgressItem[];
  updatedAt: number;
}

export function emptyProgress(): ProgressState {
  return { items: [], updatedAt: Date.now() };
}

/**
 * Glyph for a checklist status. Prefer hollow/filled circles over ellipsis —
 * `…` read as "loading forever" for items that were simply not started yet.
 * Hosts may use SVG instead; keep these as the plain-text / CLI contract.
 */
export function progressMark(status: ProgressStatus | string): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'in_progress':
      return '◎';
    case 'cancelled':
      return '✗';
    default:
      return '○';
  }
}

export function summarizeProgress(state: ProgressState): string {
  if (!state.items.length) return 'No progress items.';
  const lines = state.items.map((i) => {
    return `${progressMark(i.status)} [${i.status}] ${i.id}: ${i.title}`;
  });
  const done = state.items.filter((i) => i.status === 'done').length;
  return `Progress ${done}/${state.items.length}\n` + lines.join('\n');
}

/**
 * Mark every open item done (pending / in_progress). Cancelled stays cancelled.
 * Returns the same reference when nothing changed.
 */
export function completeOpenProgress(state: ProgressState): ProgressState {
  if (!state.items.length) return state;
  let changed = false;
  const items = state.items.map((i) => {
    if (i.status === 'pending' || i.status === 'in_progress') {
      changed = true;
      return { ...i, status: 'done' as const };
    }
    return i;
  });
  if (!changed) return state;
  return { items, updatedAt: Date.now() };
}

/**
 * Apply a set_progress update.
 * - `items` replaces the list when provided as a full snapshot.
 * - `id` + `title`/`status` upserts a single item.
 */
export function applyProgressUpdate(
  state: ProgressState,
  args: {
    items?: Array<{ id?: string; title?: string; status?: string }>;
    id?: string;
    title?: string;
    status?: string;
  },
): ProgressState {
  const next: ProgressState = {
    items: state.items.map((i) => ({ ...i })),
    updatedAt: Date.now(),
  };

  if (Array.isArray(args.items) && args.items.length) {
    next.items = args.items
      .map((raw, idx) => normalizeItem(raw, idx))
      .filter((i): i is ProgressItem => i != null);
    return next;
  }

  const id = (args.id || '').trim();
  if (!id) return next;
  const status = coerceStatus(args.status) ?? 'pending';
  const title = (args.title || '').trim() || id;
  const existing = next.items.findIndex((i) => i.id === id);
  if (existing >= 0) {
    const cur = next.items[existing]!;
    next.items[existing] = {
      id,
      title: title || cur.title,
      status: coerceStatus(args.status) ?? cur.status,
    };
  } else {
    next.items.push({ id, title, status });
  }
  return next;
}

function coerceStatus(s: string | undefined): ProgressStatus | null {
  const v = String(s || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (v === 'pending' || v === 'todo' || v === 'open') return 'pending';
  if (v === 'in_progress' || v === 'inprogress' || v === 'active' || v === 'doing') return 'in_progress';
  if (v === 'done' || v === 'complete' || v === 'completed' || v === 'checked') return 'done';
  if (v === 'cancelled' || v === 'canceled' || v === 'skipped') return 'cancelled';
  return null;
}

function normalizeItem(
  raw: { id?: string; title?: string; status?: string },
  idx: number,
): ProgressItem | null {
  const id = String(raw.id || `item-${idx + 1}`).trim();
  if (!id) return null;
  const title = String(raw.title || id).trim() || id;
  const status = coerceStatus(raw.status) ?? 'pending';
  return { id, title, status };
}

/** Seed checklist from capsule verification plan (titles only, pending). */
export function progressFromVerificationPlan(plan: {
  syntaxFiles?: string[];
  suggestedTests?: string[];
  notes?: string[];
}): ProgressState {
  const items: ProgressItem[] = [];
  let n = 0;
  for (const f of plan.syntaxFiles ?? []) {
    n++;
    items.push({ id: `syntax-${n}`, title: `Syntax check: ${f}`, status: 'pending' });
  }
  for (const t of plan.suggestedTests ?? []) {
    n++;
    items.push({ id: `test-${n}`, title: `Test: ${t}`, status: 'pending' });
  }
  for (const note of plan.notes ?? []) {
    n++;
    items.push({ id: `note-${n}`, title: note, status: 'pending' });
  }
  return { items, updatedAt: Date.now() };
}
