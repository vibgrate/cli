import { describe, expect, it } from 'vitest';
import { compareExtractCounts, vgCallableNames } from './extract-count.js';

describe('H3 extract-count', () => {
  it('counts only callable node kinds', () => {
    const names = vgCallableNames([
      { kind: 'method', name: 'handle_login' },
      { kind: 'function', name: 'find_user' },
      { kind: 'file', name: 'login.py' },
      { kind: 'module', name: 'app' },
      { kind: 'method', name: 'handle_login' },
    ]);
    expect(names).toEqual(['find_user', 'handle_login']);
  });

  it('reports gold names vg missed without inventing a re-parse', () => {
    const row = compareExtractCounts(
      [
        { kind: 'method', name: 'handle_login', file: 'app/controllers/login.py' },
        { kind: 'function', name: 'find_user', file: 'app/repo/users.py' },
      ],
      ['handle_login', 'find_user', 'verify_jwt'],
    );
    expect(row.vgCallables).toBe(2);
    expect(row.goldTotal).toBe(3);
    expect(row.goldInVg).toBe(2);
    expect(row.goldMissingVg).toEqual(['verify_jwt']);
  });
});
