import { describe, expect, it } from 'vitest';
import { formatHaileLines, haileJsonFields } from './format.js';
import type { HaileSymbol } from './types.js';

/** Boundary findings ride on the symbol record; `vg show` prints them as their own lines. */
const symbol: HaileSymbol = {
  node_id: 'n1',
  file_path: 'src/Api/Controllers/ProductsController.cs',
  name: 'Create',
  qualified_name: 'ProductsController.Create',
  symbol_kind: 'method',
  role: { primary: 'controller', alternatives: [], confidence: 0.9, band: 'high' },
  purposes: [{ purpose: 'persist', confidence: 1 }, { purpose: 'network_io', confidence: 0.6 }],
  intent: { text: 'writes Product via SaveChangesAsync, returns 201', verbs: ['persist'], objects: ['Product'] },
  evidence: [{ kind: 'effect', signal: 'body writes Product via SaveChangesAsync', weight: 4.2 }],
  findings: [
    { rule: 'hexagonal-v1/controller-persists', severity: 'hard', message: 'HTTP handler writes the store via SaveChangesAsync; controllers must not persist' },
    { rule: 'hexagonal-v1/controller-calls-out', severity: 'warn', message: 'HTTP handler calls out via post; it skips the application layer' },
  ],
};

describe('boundary findings on vg show', () => {
  it('prints one boundary line per finding after the classification lines', () => {
    const lines = formatHaileLines(symbol);
    expect(lines[0]).toContain('role controller');
    expect(lines).toContain('  boundary violation: HTTP handler writes the store via SaveChangesAsync; controllers must not persist (hexagonal-v1/controller-persists)');
    expect(lines).toContain('  boundary warning: HTTP handler calls out via post; it skips the application layer (hexagonal-v1/controller-calls-out)');
  });

  it('is absent, not broken, when a symbol carries none or malformed rows', () => {
    const none = formatHaileLines({ ...symbol, findings: undefined });
    expect(none.some((l) => l.includes('boundary'))).toBe(false);
    const bad = formatHaileLines({ ...symbol, findings: [{ rule: 1, message: null } as never, null as never] });
    expect(bad.some((l) => l.includes('boundary'))).toBe(false);
    expect(haileJsonFields(symbol)?.findings).toHaveLength(2);
    expect(haileJsonFields({ ...symbol, findings: undefined })?.findings).toEqual([]);
  });
});
