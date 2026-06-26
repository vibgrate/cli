// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VcsInfo } from '../types.js';
import { detectVcs } from './vcs.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.vibgrate',
  '.wrangler',
  '.next',
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  'coverage',
  'bin',
  'obj',
  '.vs',
  'TestResults',
  '.nuxt',
  '.output',
  '.svelte-kit',
]);

export interface RepoFingerprint {
  /** Primary dedup key when git HEAD is available */
  vcsSha?: string;
  /** Fallback content signature for non-git trees (hex sha256) */
  treeHash?: string;
  /** How the fingerprint was derived */
  method: 'git_sha' | 'tree_metadata' | 'unknown';
}

export interface TreeFingerprintOptions {
  /** Skip directories with more than this many direct file children (default 500) */
  maxFilesPerDirectory?: number;
}

/**
 * Resolve a repository fingerprint for ingest deduplication.
 * Prefer git HEAD SHA; otherwise hash relative paths + size + mtime for scannable files.
 */
export async function computeRepoFingerprint(
  rootDir: string,
  vcs?: VcsInfo,
): Promise<RepoFingerprint> {
  const vcsInfo = vcs ?? (await detectVcs(rootDir));
  if (vcsInfo.type === 'git' && vcsInfo.sha) {
    return { vcsSha: vcsInfo.sha, method: 'git_sha' };
  }

  const treeHash = await computeTreeMetadataHash(rootDir);
  if (treeHash) {
    return { treeHash, method: 'tree_metadata' };
  }

  return { method: 'unknown' };
}

/**
 * Merkle-style hash over scannable file metadata (path, size, mtime ms).
 * Same algorithm should be used client-side before scan and server-side when validating.
 */
export async function computeTreeMetadataHash(
  rootDir: string,
  options?: TreeFingerprintOptions,
): Promise<string | undefined> {
  const maxFiles = options?.maxFilesPerDirectory ?? 500;
  const leaves: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries.filter((e) => e.isFile());
    if (files.length > maxFiles) {
      leaves.push(`${relDir || '.'}|dir_overflow|${files.length}`);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        await walk(path.join(absDir, entry.name), childRel);
        continue;
      }

      if (!entry.isFile()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);
      try {
        const stat = await fs.stat(absPath);
        leaves.push(`${relPath}|${stat.size}|${stat.mtimeMs}`);
      } catch {
        // ignore unreadable files
      }
    }
  }

  await walk(path.resolve(rootDir), '');
  if (leaves.length === 0) return undefined;

  leaves.sort();
  const digest = crypto.createHash('sha256');
  for (const leaf of leaves) {
    digest.update(leaf);
    digest.update('\n');
  }
  return digest.digest('hex');
}
