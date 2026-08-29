/**
 * Peer dominance voting — "what do this file's peers actually do?"
 *
 * The mechanic is the one convention-consistency scanners use, with one
 * deliberate difference that matters more than all the constants combined:
 *
 * **Peers are graph-area / role-equivalent symbols, not directory siblings.**
 * A directory is a filing decision; an area is a structural one. Two handlers
 * in `src/api/` may belong to different subsystems, and the right peers for a
 * repository handler are the other repository handlers wherever they live.
 * Directory scoping is the fallback for files the graph could not place, never
 * the primary definition.
 *
 * And the load-bearing product difference: **a dominant pattern is never
 * treated as correct.** This module answers "what is the majority?" and nothing
 * else. Whether deviating from it is a regression is decided against the
 * *declared* `target_pattern` in `.vibgrate/review.toml` — otherwise Review
 * would punish the first file to modernise and lock a repository into its own
 * legacy (spec §4.1: "Majority is never silently treated as correctness").
 */

/** A group smaller than this cannot establish a convention. */
export const MIN_GROUP_SIZE = 3;

/** Share of the group the leader needs before we call it dominant. */
export const DOMINANCE_SHARE = 0.7;

/**
 * Normalized Shannon entropy above which a group has *no* convention — the
 * patterns are too evenly spread for a leader to mean anything. Without this
 * gate a 34/33/33 split reports a "dominant" pattern held by a third of files.
 */
export const ENTROPY_NO_CONVENTION = 0.8;

/** A "no convention here" observation needs at least this many files to be worth making. */
export const NO_CONVENTION_MIN_FILES = 5;

/** Recency half-life. A file touched today counts ~2x one untouched for a year. */
export const TEMPORAL_HALF_LIFE_DAYS = 90;

/** Multiplier applied to a pattern a human declared in CLAUDE.md / AGENTS.md. */
export const INTENT_BOOST = 1.5;

export interface PeerFile {
  path: string;
  /** The pattern this file exhibits for the dimension being voted on. */
  pattern: string;
  /** Peer group key — a graph area/role id, or a directory when unplaced. */
  group: string;
  /** How the group was derived. Recorded so the capsule can be honest about it. */
  groupKind: 'area' | 'role' | 'directory';
  /** Days since last commit. `null` when git history is unavailable. */
  daysSinceCommit: number | null;
}

export interface DominanceVote {
  group: string;
  groupKind: PeerFile['groupKind'];
  /** The winning pattern, or null when no convention could be established. */
  dominant: string | null;
  /** Weighted share held by the leader, 0..1. */
  share: number;
  /** Normalized Shannon entropy of the group, 0..1. */
  entropy: number;
  /** Number of files considered. */
  size: number;
  /** Why there is no dominant pattern, when there isn't one. */
  reason: 'dominant' | 'group_too_small' | 'no_clear_leader' | 'no_convention';
  /** Weighted tally per pattern, for evidence. */
  tally: Record<string, number>;
  /** Files that do not follow the dominant pattern. Empty when there isn't one. */
  deviators: string[];
  /** Up to three files that best exemplify the dominant pattern. */
  exemplars: string[];
}

/**
 * Recency weight: `2 * exp(-ln2 * days / halfLife)`.
 *
 * A file edited today weighs ~2, one edited a half-life ago weighs 1, one from
 * a year ago ~0.12. This is what stops a large, abandoned legacy wing from
 * out-voting the part of the codebase people actually work in — which is the
 * usual reason a naive majority vote tells you to write code like it's 2019.
 *
 * Unknown history weighs 1: neither boosted nor penalised.
 */
export function temporalWeight(
  daysSinceCommit: number | null,
  halfLifeDays: number = TEMPORAL_HALF_LIFE_DAYS,
): number {
  if (daysSinceCommit === null || !Number.isFinite(daysSinceCommit)) return 1;
  const days = Math.max(0, daysSinceCommit);
  return 2 * Math.exp((-Math.LN2 * days) / halfLifeDays);
}

/** Normalized Shannon entropy of a weighted tally, 0 (one pattern) .. 1 (uniform). */
export function normalizedEntropy(tally: Record<string, number>): number {
  const values = Object.values(tally).filter((v) => v > 0);
  if (values.length <= 1) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const v of values) {
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(values.length);
}

export interface VoteOptions {
  /**
   * Patterns a human declared (CLAUDE.md / AGENTS.md / review.toml). Each gets
   * {@link INTENT_BOOST} — a stated intention outweighs a slim accidental
   * majority, but does not manufacture a convention on its own.
   */
  declaredPatterns?: readonly string[];
  minGroupSize?: number;
  dominanceShare?: number;
}

/** Vote one peer group. */
export function voteGroup(files: readonly PeerFile[], opts: VoteOptions = {}): DominanceVote {
  const minGroupSize = opts.minGroupSize ?? MIN_GROUP_SIZE;
  const dominanceShare = opts.dominanceShare ?? DOMINANCE_SHARE;
  const declared = new Set(opts.declaredPatterns ?? []);
  const group = files[0]?.group ?? '';
  const groupKind = files[0]?.groupKind ?? 'directory';

  const tally: Record<string, number> = {};
  for (const f of files) {
    const boost = declared.has(f.pattern) ? INTENT_BOOST : 1;
    tally[f.pattern] = (tally[f.pattern] ?? 0) + temporalWeight(f.daysSinceCommit) * boost;
  }

  const base = {
    group,
    groupKind,
    size: files.length,
    tally,
    entropy: normalizedEntropy(tally),
    exemplars: [] as string[],
    deviators: [] as string[],
  };

  if (files.length < minGroupSize) {
    return { ...base, dominant: null, share: 0, reason: 'group_too_small' };
  }

  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [leader, leaderWeight] = ranked[0];
  const share = total > 0 ? leaderWeight / total : 0;

  // Entropy first: a group with no convention has no leader worth naming, even
  // if one pattern happens to edge ahead.
  //
  // Only meaningful once there are three or more competing patterns. Entropy is
  // normalized by log(distinct patterns), so *any* two-way split scores high —
  // a clean 75/25 lands at 0.81 and would be thrown out as "no convention"
  // despite being exactly the dominance we are looking for. With two patterns
  // the share threshold below is already the right and only test.
  const distinctPatterns = Object.values(tally).filter((v) => v > 0).length;
  if (distinctPatterns >= 3 && base.entropy > ENTROPY_NO_CONVENTION) {
    return {
      ...base,
      dominant: null,
      share,
      reason: files.length >= NO_CONVENTION_MIN_FILES ? 'no_convention' : 'no_clear_leader',
    };
  }
  if (share < dominanceShare) {
    return { ...base, dominant: null, share, reason: 'no_clear_leader' };
  }

  const following = files.filter((f) => f.pattern === leader);
  return {
    ...base,
    dominant: leader,
    share,
    reason: 'dominant',
    // Most recently touched first — the best example is a live one.
    exemplars: [...following]
      .sort((a, b) => (a.daysSinceCommit ?? 1e9) - (b.daysSinceCommit ?? 1e9))
      .slice(0, 3)
      .map((f) => f.path),
    deviators: files.filter((f) => f.pattern !== leader).map((f) => f.path).sort(),
  };
}

/** Vote every peer group in a corpus, keyed by group id. */
export function voteAll(files: readonly PeerFile[], opts: VoteOptions = {}): DominanceVote[] {
  const groups = new Map<string, PeerFile[]>();
  for (const f of files) {
    let bucket = groups.get(f.group);
    if (!bucket) groups.set(f.group, (bucket = []));
    bucket.push(f);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, bucket]) => voteGroup(bucket, opts));
}

/**
 * The repository-wide dominant pattern, when one exists.
 *
 * Derived from the *groups that reached a verdict*, not from a global file
 * count — otherwise one enormous directory decides the whole repository's
 * "convention". A pattern must lead a majority of deciding groups.
 */
export function repositoryDominantPattern(votes: readonly DominanceVote[]): string | null {
  const deciding = votes.filter((v) => v.reason === 'dominant' && v.dominant);
  if (deciding.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of deciding) counts.set(v.dominant!, (counts.get(v.dominant!) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [pattern, n] = ranked[0];
  return n / deciding.length >= 0.5 ? pattern : null;
}
