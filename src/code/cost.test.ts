import { describe, it, expect } from 'vitest';
import { costOf, SessionMeter, fmtTokens } from './cost.js';

describe('costOf', () => {
  it('computes $ from per-million pricing', () => {
    expect(costOf({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, { promptPerM: 3, completionPerM: 15 })).toBe(18);
    expect(costOf({ promptTokens: 500_000 }, { promptPerM: 2 })).toBe(1);
  });
  it('is 0 when unpriced (local/free)', () => {
    expect(costOf({ promptTokens: 999999, completionTokens: 999999 }, {})).toBe(0);
  });
});

describe('SessionMeter', () => {
  it('accumulates tokens and cost across turns', () => {
    const m = new SessionMeter({ promptPerM: 3, completionPerM: 6 });
    m.add({ promptTokens: 1000, completionTokens: 500 });
    m.add({ promptTokens: 2000, completionTokens: 1000 });
    const t = m.totals;
    expect(t.promptTokens).toBe(3000);
    expect(t.completionTokens).toBe(1500);
    expect(t.totalTokens).toBe(4500);
    expect(t.turns).toBe(2);
    expect(m.summary()).toMatch(/tok · ~\$/);
  });
  it('shows only tokens when pricing is unknown', () => {
    const m = new SessionMeter();
    m.add({ promptTokens: 1500 });
    expect(m.summary()).toBe('1.5k tok');
  });
});

describe('fmtTokens', () => {
  it('formats k and M', () => {
    expect(fmtTokens(500)).toBe('500');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(2_000_000)).toBe('2.00M');
  });
});
