/**
 * Jupyter notebook (.ipynb) cell helpers for VG Code tools.
 * Path-based, nbformat-aware; does not require the VS Code Notebook API.
 */

export interface NotebookCell {
  index: number;
  cell_type: string;
  source: string;
  /** True when the cell was markdown. */
  markdown: boolean;
}

export interface NotebookSummary {
  cells: NotebookCell[];
  nbformat?: number;
  kernel?: string;
}

function sourceToString(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) return source.map((s) => String(s)).join('');
  return '';
}

function stringToSource(text: string, asArray: boolean): string | string[] {
  if (!asArray) return text;
  // nbformat commonly stores source as array of lines ending with \n
  if (!text) return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

export function parseNotebook(raw: string): { ok: true; nb: Record<string, unknown> } | { ok: false; error: string } {
  let nb: unknown;
  try {
    nb = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb)) {
    return { ok: false, error: 'notebook root must be an object' };
  }
  const cells = (nb as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) {
    return { ok: false, error: 'notebook missing cells[]' };
  }
  return { ok: true, nb: nb as Record<string, unknown> };
}

export function summarizeNotebook(raw: string): { ok: true; summary: NotebookSummary } | { ok: false; error: string } {
  const parsed = parseNotebook(raw);
  if (!parsed.ok) return parsed;
  const cellsRaw = parsed.nb.cells as Array<Record<string, unknown>>;
  const cells: NotebookCell[] = cellsRaw.map((c, index) => {
    const cell_type = String(c.cell_type || 'code');
    return {
      index,
      cell_type,
      source: sourceToString(c.source),
      markdown: cell_type === 'markdown',
    };
  });
  const meta = (parsed.nb.metadata || {}) as Record<string, unknown>;
  const kernelspec = (meta.kernelspec || {}) as Record<string, unknown>;
  return {
    ok: true,
    summary: {
      cells,
      nbformat: typeof parsed.nb.nbformat === 'number' ? parsed.nb.nbformat : undefined,
      kernel: typeof kernelspec.name === 'string' ? kernelspec.name : undefined,
    },
  };
}

export function formatNotebookSummary(summary: NotebookSummary, path: string): string {
  const lines = [
    `Notebook ${path}` +
      (summary.nbformat != null ? ` · nbformat ${summary.nbformat}` : '') +
      (summary.kernel ? ` · kernel ${summary.kernel}` : ''),
    `${summary.cells.length} cell(s)`,
  ];
  for (const c of summary.cells) {
    const preview = c.source.replace(/\s+/g, ' ').trim().slice(0, 80);
    lines.push(`  [${c.index}] ${c.cell_type}${preview ? `: ${preview}` : ''}`);
  }
  return lines.join('\n');
}

export function readNotebookCell(
  raw: string,
  index: number,
): { ok: true; cell: NotebookCell; content: string } | { ok: false; error: string } {
  const sum = summarizeNotebook(raw);
  if (!sum.ok) return sum;
  const cell = sum.summary.cells[index];
  if (!cell) {
    return { ok: false, error: `cell index ${index} out of range (0..${sum.summary.cells.length - 1})` };
  }
  return {
    ok: true,
    cell,
    content: `Cell ${index} (${cell.cell_type})\n---\n${cell.source}`,
  };
}

/**
 * Replace cell source by index. Preserves outputs/metadata on the cell.
 * Returns updated notebook JSON string (pretty-printed with 1-space indent like many notebooks).
 */
export function editNotebookCell(
  raw: string,
  index: number,
  newSource: string,
): { ok: true; next: string; before: string; after: string } | { ok: false; error: string } {
  const parsed = parseNotebook(raw);
  if (!parsed.ok) return parsed;
  const cells = parsed.nb.cells as Array<Record<string, unknown>>;
  if (index < 0 || index >= cells.length) {
    return { ok: false, error: `cell index ${index} out of range (0..${cells.length - 1})` };
  }
  const cell = cells[index]!;
  const before = sourceToString(cell.source);
  const asArray = Array.isArray(cell.source);
  cell.source = stringToSource(newSource, asArray);
  // Clear outputs on code cells after source change (stale execution state).
  if (cell.cell_type === 'code') {
    cell.outputs = [];
    if ('execution_count' in cell) cell.execution_count = null;
  }
  const next = JSON.stringify(parsed.nb, null, 1) + '\n';
  return { ok: true, next, before, after: newSource };
}
