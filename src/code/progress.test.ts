import { describe, it, expect } from 'vitest';
import {
  applyProgressUpdate,
  emptyProgress,
  progressFromVerificationPlan,
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
