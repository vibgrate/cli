import { describe, expect, it } from 'vitest';
import { canonicalModuleName } from './module.js';

describe('vg module names', () => {
  it('accepts the pre-rename codename as an alias for the public architecture module id', () => {
    expect(canonicalModuleName('haile')).toBe('arch');
    expect(canonicalModuleName('arch')).toBe('arch');
    expect(canonicalModuleName('relevance')).toBe('relevance');
  });
});
