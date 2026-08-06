import { describe, it, expect } from 'vitest';
import { editNotebookCell, summarizeNotebook, readNotebookCell } from './notebook.js';

const sample = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3' } },
  cells: [
    { cell_type: 'markdown', source: ['# Title\n'], metadata: {} },
    { cell_type: 'code', source: ['print(1)\n'], outputs: [{ o: 1 }], execution_count: 1, metadata: {} },
  ],
});

describe('notebook', () => {
  it('lists cells', () => {
    const s = summarizeNotebook(sample);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.summary.cells).toHaveLength(2);
    expect(s.summary.kernel).toBe('python3');
  });

  it('reads and edits a cell', () => {
    const r = readNotebookCell(sample, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cell.source).toContain('print(1)');
    const e = editNotebookCell(sample, 1, 'print(2)\n');
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.after).toContain('print(2)');
    const again = summarizeNotebook(e.next);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.summary.cells[1]?.source).toContain('print(2)');
  });
});
