import { describe, it, expect } from 'vitest';
import {
  applyProgressUpdate,
  completeOpenProgress,
  emptyProgress,
  progressFromVerificationPlan,
  progressMark,
  summarizeProgress,
} from './progress.js';

describe('progress', () => {
  it('upserts items and summarizes', () => {
    let s = emptyProgress();
    s = applyProgressUpdate(s, {
      items: [
        { id: 'a', title: 'First', status: 'pending' },
        { id: 'b', title: 'Second', status: 'in_progress' },
      ],
    });
    s = applyProgressUpdate(s, { id: 'a', status: 'done' });
    expect(s.items.find((i) => i.id === 'a')?.status).toBe('done');
    expect(summarizeProgress(s)).toContain('Progress 1/2');
    expect(summarizeProgress(s)).toContain(progressMark('done'));
    expect(summarizeProgress(s)).toContain(progressMark('in_progress'));
  });

  it('uses clear glyphs instead of ellipsis for open items', () => {
    expect(progressMark('pending')).toBe('○');
    expect(progressMark('in_progress')).toBe('◎');
    expect(progressMark('done')).toBe('✓');
    expect(progressMark('cancelled')).toBe('✗');
    expect(progressMark('pending')).not.toBe('…');
    expect(progressMark('in_progress')).not.toBe('…');
  });

  it('completeOpenProgress marks pending and in_progress done, keeps cancelled', () => {
    let s = emptyProgress();
    s = applyProgressUpdate(s, {
      items: [
        { id: 'a', title: 'First', status: 'done' },
        { id: 'b', title: 'Second', status: 'in_progress' },
        { id: 'c', title: 'Third', status: 'pending' },
        { id: 'd', title: 'Skip', status: 'cancelled' },
      ],
    });
    const next = completeOpenProgress(s);
    expect(next.items.map((i) => i.status)).toEqual(['done', 'done', 'done', 'cancelled']);
    expect(summarizeProgress(next)).toContain('Progress 3/4');
    // No-op when already complete.
    expect(completeOpenProgress(next)).toBe(next);
  });

  it('seeds from verification plan', () => {
    const s = progressFromVerificationPlan({
      syntaxFiles: ['src/a.ts'],
      suggestedTests: ['npm test'],
      notes: ['check edge cases'],
    });
    expect(s.items.length).toBe(3);
    expect(s.items[0]?.title).toContain('src/a.ts');
  });
});
