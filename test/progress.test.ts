import { describe, it, expect } from 'vitest';
import { formatProgressLine } from '../src/util/progress.js';

const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('formatProgressLine (scan-style bar)', () => {
  it('renders a half-full bar with percent and counts', () => {
    const line = plain(formatProgressLine('embedding', 50, 100, 1000, 0));
    expect(line).toContain('embedding');
    expect(line).toContain('50%');
    expect(line).toContain('50/100');
    expect(line).toContain('━'); // filled segment
    expect(line).toContain('╌'); // empty segment
  });

  it('clamps to 100% when done', () => {
    const line = plain(formatProgressLine('x', 10, 10, 1000, 3));
    expect(line).toContain('100%');
    expect(line).not.toContain('╌'); // fully filled
  });

  it('shows an ETA mid-run but not at the very start', () => {
    expect(plain(formatProgressLine('x', 50, 100, 2000, 0))).toContain('eta');
    expect(plain(formatProgressLine('x', 0, 100, 0, 0))).not.toContain('eta');
  });
});
