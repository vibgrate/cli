import { describe, expect, it } from 'vitest';
import {
  DOMINANCE_SHARE,
  MIN_GROUP_SIZE,
  normalizedEntropy,
  repositoryDominantPattern,
  temporalWeight,
  voteAll,
  voteGroup,
  type PeerFile,
} from './dominance.js';
import { classifyDataAccess, isRegression } from './dimensions.js';
import { readDeclaredIntent } from './intent.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function peer(overrides: Partial<PeerFile> = {}): PeerFile {
  return {
    path: 'src/a.ts',
    pattern: 'via-service',
    group: 'area:1:handler',
    groupKind: 'area',
    daysSinceCommit: 0,
    ...overrides,
  };
}

/** n peers with the given patterns, all equally recent. */
function group(patterns: string[], opts: Partial<PeerFile> = {}): PeerFile[] {
  return patterns.map((pattern, i) => peer({ ...opts, pattern, path: `src/f${i}.ts` }));
}

// ── temporal weighting ──────────────────────────────────────────────────────

describe('temporalWeight', () => {
  it('weighs a file touched today at ~2x', () => {
    expect(temporalWeight(0)).toBeCloseTo(2, 5);
  });

  it('weighs a file at the half-life at ~1x', () => {
    expect(temporalWeight(90)).toBeCloseTo(1, 5);
  });

  it('decays an old file well below 1', () => {
    expect(temporalWeight(365)).toBeLessThan(0.2);
  });

  it('treats unknown history as neutral, not old', () => {
    // A repo with no git history must not have every file discounted to zero —
    // that would silently make every vote unwinnable.
    expect(temporalWeight(null)).toBe(1);
  });

  it('never goes negative on a clock skew', () => {
    expect(temporalWeight(-100)).toBeCloseTo(2, 5);
  });
});

// ── entropy ─────────────────────────────────────────────────────────────────

describe('normalizedEntropy', () => {
  it('is 0 for a single pattern', () => {
    expect(normalizedEntropy({ a: 10 })).toBe(0);
  });

  it('scores a two-way 75/25 split high — which is why the gate needs 3+ patterns', () => {
    // Documents the trap: normalization by log(distinct) makes any two-way
    // split look uniform, so voteGroup only applies the gate at 3+ patterns.
    expect(normalizedEntropy({ a: 3, b: 1 })).toBeGreaterThan(0.8);
  });

  it('is 1 for a perfectly even split', () => {
    expect(normalizedEntropy({ a: 5, b: 5, c: 5 })).toBeCloseTo(1, 5);
  });

  it('is low for a dominated split', () => {
    expect(normalizedEntropy({ a: 90, b: 5, c: 5 })).toBeLessThan(0.5);
  });
});

// ── the vote ────────────────────────────────────────────────────────────────

describe('voteGroup', () => {
  it('finds a dominant pattern in a consistent group', () => {
    const v = voteGroup(group(['via-service', 'via-service', 'via-service', 'via-service']));
    expect(v.dominant).toBe('via-service');
    expect(v.reason).toBe('dominant');
    expect(v.share).toBeCloseTo(1, 5);
  });

  it('refuses to call a convention in a group below the minimum size', () => {
    const v = voteGroup(group(['via-service', 'via-service']));
    expect(v.dominant).toBeNull();
    expect(v.reason).toBe('group_too_small');
    expect(MIN_GROUP_SIZE).toBe(3);
  });

  it('refuses a leader below the dominance share', () => {
    // 3/5 = 0.6, under the 0.7 threshold. Two patterns, so the entropy gate is
    // not in play and this isolates the share rule.
    const v = voteGroup(group(['a', 'a', 'a', 'b', 'b']));
    expect(v.dominant).toBeNull();
    expect(v.reason).toBe('no_clear_leader');
    expect(DOMINANCE_SHARE).toBe(0.7);
  });

  it('reports "no convention" for a high-entropy group rather than a fake leader', () => {
    // An even three-way split has a nominal leader after tie-break; naming it
    // would be a lie about a group that has no convention at all.
    const v = voteGroup(group(['a', 'a', 'b', 'b', 'c', 'c']));
    expect(v.dominant).toBeNull();
    expect(v.reason).toBe('no_convention');
    expect(v.entropy).toBeGreaterThan(0.8);
  });

  it('needs enough files before it will claim "no convention"', () => {
    const v = voteGroup(group(['a', 'b', 'c']));
    expect(v.dominant).toBeNull();
    expect(v.reason).toBe('no_clear_leader');
  });

  it('lets recent files outvote a larger abandoned majority', () => {
    // Four year-old files vs three touched today. Raw count says the old
    // pattern wins; recency says the live one does.
    const files: PeerFile[] = [
      ...group(['legacy', 'legacy', 'legacy', 'legacy']).map((f, i) => ({
        ...f,
        path: `old${i}.ts`,
        daysSinceCommit: 400,
      })),
      ...group(['modern', 'modern', 'modern']).map((f, i) => ({
        ...f,
        path: `new${i}.ts`,
        daysSinceCommit: 1,
      })),
    ];
    const v = voteGroup(files);
    expect(v.dominant).toBe('modern');
  });

  it('boosts a pattern a human declared', () => {
    // 4 vs 2 is 0.667 — under threshold. The declared pattern's 1.5x lifts it
    // to 0.75, over the line.
    const files = group(['declared', 'declared', 'declared', 'declared', 'other', 'other']);
    expect(voteGroup(files).dominant).toBeNull();
    expect(voteGroup(files, { declaredPatterns: ['declared'] }).dominant).toBe('declared');
  });

  it('does not manufacture a convention from intent alone', () => {
    // Declaring a pattern nobody follows must not make it dominant.
    const files = group(['other', 'other', 'other', 'other']);
    expect(voteGroup(files, { declaredPatterns: ['declared'] }).dominant).toBe('other');
  });

  it('lists deviators and recent exemplars', () => {
    const files: PeerFile[] = [
      peer({ path: 'a.ts', pattern: 'x', daysSinceCommit: 30 }),
      peer({ path: 'b.ts', pattern: 'x', daysSinceCommit: 1 }),
      peer({ path: 'c.ts', pattern: 'x', daysSinceCommit: 10 }),
      peer({ path: 'd.ts', pattern: 'y', daysSinceCommit: 5 }),
    ];
    const v = voteGroup(files);
    expect(v.dominant).toBe('x');
    expect(v.deviators).toEqual(['d.ts']);
    expect(v.exemplars[0]).toBe('b.ts'); // most recently touched first
  });
});

describe('voteAll + repositoryDominantPattern', () => {
  it('votes each group independently', () => {
    const files = [
      ...group(['a', 'a', 'a']).map((f, i) => ({ ...f, group: 'g1', path: `g1-${i}` })),
      ...group(['b', 'b', 'b']).map((f, i) => ({ ...f, group: 'g2', path: `g2-${i}` })),
    ];
    const votes = voteAll(files);
    expect(votes).toHaveLength(2);
    expect(votes.map((v) => v.dominant).sort()).toEqual(['a', 'b']);
  });

  it('needs a majority of deciding groups for a repo-wide pattern', () => {
    const votes = voteAll([
      ...group(['a', 'a', 'a']).map((f, i) => ({ ...f, group: 'g1', path: `g1-${i}` })),
      ...group(['a', 'a', 'a']).map((f, i) => ({ ...f, group: 'g2', path: `g2-${i}` })),
      ...group(['b', 'b', 'b']).map((f, i) => ({ ...f, group: 'g3', path: `g3-${i}` })),
    ]);
    expect(repositoryDominantPattern(votes)).toBe('a');
  });

  it('returns null when no group reached a verdict', () => {
    expect(repositoryDominantPattern(voteAll(group(['a', 'b'])))).toBeNull();
  });

  it('does not let one huge group decide the repository', () => {
    // 'a' holds one group; 'b' holds two. Group count decides, not file count.
    const votes = voteAll([
      ...Array.from({ length: 50 }, (_, i) => peer({ group: 'big', pattern: 'a', path: `big${i}` })),
      ...group(['b', 'b', 'b']).map((f, i) => ({ ...f, group: 'g2', path: `g2-${i}` })),
      ...group(['b', 'b', 'b']).map((f, i) => ({ ...f, group: 'g3', path: `g3-${i}` })),
    ]);
    expect(repositoryDominantPattern(votes)).toBe('b');
  });
});

// ── the dimension ───────────────────────────────────────────────────────────

describe('classifyDataAccess', () => {
  it('labels a handler that imports a repository as direct-persistence', () => {
    expect(classifyDataAccess('routing', ['data-access'])).toBe('direct-persistence');
  });

  it('counts direct persistence even when a service is also used', () => {
    // Calling the service too does not undo having bypassed the boundary once.
    expect(classifyDataAccess('routing', ['services', 'data-access'])).toBe('direct-persistence');
  });

  it('labels a handler that only calls a service as via-service', () => {
    expect(classifyDataAccess('routing', ['services'])).toBe('via-service');
  });

  it('ignores config/shared/testing dependencies', () => {
    expect(classifyDataAccess('routing', ['config', 'shared', 'testing'])).toBe('no-data-access');
  });

  it('does not label the persistence layer itself', () => {
    expect(classifyDataAccess('data-access', ['infrastructure'])).toBeNull();
    expect(classifyDataAccess('testing', ['data-access'])).toBeNull();
  });
});

describe('isRegression', () => {
  it('flags reaching persistence directly when peers do not', () => {
    expect(isRegression('direct-persistence', 'via-service')).toBe(true);
  });

  it('never flags the first file to improve on its peers', () => {
    // Peers all bypass; this file goes through the service. That is the change
    // we want, and flagging it would punish modernisation.
    expect(isRegression('via-service', 'direct-persistence')).toBe(false);
  });

  it('does not flag a file matching a bypassing majority', () => {
    expect(isRegression('direct-persistence', 'direct-persistence')).toBe(false);
  });

  it('does not flag when there is no convention to deviate from', () => {
    expect(isRegression('direct-persistence', null)).toBe(false);
  });
});

// ── declared intent ─────────────────────────────────────────────────────────

describe('readDeclaredIntent', () => {
  const withRepo = (files: Record<string, string>, fn: (dir: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-intent-'));
    try {
      for (const [name, body] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body, 'utf8');
      }
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads an architecture declaration out of CLAUDE.md', () => {
    withRepo({ 'CLAUDE.md': '# Rules\n\nWe follow Clean Architecture here.\n' }, (dir) => {
      const intent = readDeclaredIntent(dir);
      expect(intent.patterns).toContain('clean');
      expect(intent.sources).toContain('CLAUDE.md');
      expect(intent.citations[0].line).toBe(3);
    });
  });

  it('reads AGENTS.md too', () => {
    withRepo({ 'AGENTS.md': 'This service uses vertical slices.' }, (dir) => {
      expect(readDeclaredIntent(dir).patterns).toContain('vertical-slice');
    });
  });

  it('returns nothing when no instruction file declares an architecture', () => {
    withRepo({ 'CLAUDE.md': 'Run the tests before pushing.' }, (dir) => {
      const intent = readDeclaredIntent(dir);
      expect(intent.patterns).toEqual([]);
      expect(intent.sources).toEqual([]);
    });
  });

  it('never throws on a missing repository', () => {
    expect(readDeclaredIntent('/definitely/not/a/path').patterns).toEqual([]);
  });

  it('does not guess at unrecognised vocabulary', () => {
    // An unknown word must not become a target_pattern — a wrong one silently
    // changes every alignment verdict in the receipt.
    withRepo({ 'CLAUDE.md': 'We use the Bananas Architecture.' }, (dir) => {
      expect(readDeclaredIntent(dir).patterns).toEqual([]);
    });
  });
});

// ── the property that separates Review from a consistency scanner ───────────

describe('majority is never correctness', () => {
  /**
   * The whole point. A convention-consistency scanner scores a repository
   * against its own dominant patterns, so the first file to adopt a better one
   * is, by construction, its worst-scoring file. Review must do the opposite:
   * peers establish *what is normal*, and only a declared target establishes
   * *what is right*.
   */
  it('flags a file that regresses away from its peers', () => {
    const votes = voteAll(group(['via-service', 'via-service', 'via-service', 'via-service']));
    expect(isRegression('direct-persistence', votes[0].dominant as never)).toBe(true);
  });

  it('does not flag the file that improves on a legacy majority', () => {
    const votes = voteAll(
      group(['direct-persistence', 'direct-persistence', 'direct-persistence', 'direct-persistence']),
    );
    expect(votes[0].dominant).toBe('direct-persistence');
    // Four peers all bypass the service. This file goes through it — better
    // than the majority, and a scanner that treats majority as truth would
    // flag it. Review must not.
    expect(isRegression('via-service', votes[0].dominant as never)).toBe(false);
  });

  it('stays silent where a group has no convention at all', () => {
    const votes = voteAll(group(['a', 'a', 'b', 'b', 'c', 'c']));
    expect(votes[0].dominant).toBeNull();
    expect(isRegression('direct-persistence', votes[0].dominant as never)).toBe(false);
  });
});
