import {
  buildVersionTimelines,
  findPackageTimeline,
  gitHistoryAvailable,
  type GitCommitRef,
  type VulnEcosystem,
} from '../core-open/index.js';
import { inventory, type DriftInventory, type DepRecord, type Ecosystem } from '../engine/drift.js';

/**
 * Git-attribution enrichment for the local MCP server.
 *
 * Adds "who added this dependency / who set the current version" to the offline
 * drift inventory by replaying each ecosystem's version timeline. It never writes
 * (no cache) so the MCP stays read-only, and degrades to a plain inventory when
 * git history is unavailable.
 */

/** Bounded history depth for the MCP path (no cache writes, so keep first-call cost in check). */
const MCP_MAX_COMMITS = 300;

/** Map the inventory's ecosystem to the timeline/advisory ecosystem (where they differ). */
const ECOSYSTEM_MAP: Partial<Record<Ecosystem, VulnEcosystem>> = {
  npm: 'npm',
  pypi: 'pypi',
  go: 'go',
  rust: 'cargo',
  ruby: 'rubygems',
  php: 'composer',
  dotnet: 'nuget',
  dart: 'pub',
  // swift (no advisory ecosystem) and java (no resolved lockfile) have no timeline.
};

interface CommitBrief {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface AttributedDepRecord extends DepRecord {
  /** Commit that first introduced this dependency (git required). */
  addedBy?: CommitBrief;
  /** Commit that set the currently-installed version. */
  currentVersionBy?: CommitBrief;
}

function brief(commit: GitCommitRef): CommitBrief {
  return { sha: commit.shortSha, author: commit.authorName, date: commit.date, subject: commit.subject };
}

/**
 * Offline drift inventory, optionally enriched with git attribution.
 * `attribution` reports whether git data was actually applied.
 */
export async function attributedInventory(
  root: string,
  opts: { attribute?: boolean } = {},
): Promise<DriftInventory & { records: AttributedDepRecord[]; attribution: 'git' | 'unavailable' | 'off' }> {
  const inv = inventory(root);
  if (!opts.attribute) return { ...inv, attribution: 'off' };
  if (!(await gitHistoryAvailable(root))) return { ...inv, attribution: 'unavailable' };

  const timelines = await buildVersionTimelines(root, { maxCommits: MCP_MAX_COMMITS });
  if (!timelines) return { ...inv, attribution: 'unavailable' };

  const records: AttributedDepRecord[] = inv.records.map((r) => {
    const ecosystem = ECOSYSTEM_MAP[r.ecosystem];
    if (!ecosystem) return r;
    const pt = findPackageTimeline(timelines, ecosystem, r.name);
    if (!pt || !pt.changes.length) return r;
    return {
      ...r,
      addedBy: brief(pt.changes[0].commit),
      currentVersionBy: brief(pt.changes[pt.changes.length - 1].commit),
    };
  });
  return { ...inv, records, attribution: 'git' };
}
