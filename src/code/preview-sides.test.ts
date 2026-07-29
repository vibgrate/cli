import { describe, it, expect } from 'vitest';
import { previewSides, MAX_PREVIEW_CHARS } from './preview-sides.js';

describe('previewSides', () => {
  it('carries both sides of an edit', () => {
    expect(previewSides('old', 'new')).toEqual({ before: 'old', after: 'new' });
  });

  it('treats a create as an empty before and a delete as an empty after', () => {
    expect(previewSides(null, 'body')).toEqual({ before: '', after: 'body' });
    expect(previewSides('body', null)).toEqual({ before: 'body', after: '' });
  });

  it('omits the sides entirely when either is too large, never truncating', () => {
    const big = 'x'.repeat(MAX_PREVIEW_CHARS + 1);
    // A truncated side would misrepresent the change the user is approving.
    expect(previewSides(big, 'small')).toBeUndefined();
    expect(previewSides('small', big)).toBeUndefined();
  });

  it('allows content exactly at the cap', () => {
    const atCap = 'x'.repeat(MAX_PREVIEW_CHARS);
    expect(previewSides(atCap, atCap)).toEqual({ before: atCap, after: atCap });
  });

  it('handles an unchanged file without inventing content', () => {
    expect(previewSides('', '')).toEqual({ before: '', after: '' });
  });
});
