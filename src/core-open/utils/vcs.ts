// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { VcsInfo } from '../types.js';

/**
 * Detect version control system and read the current HEAD SHA.
 *
 * Implementation reads `.git/HEAD` directly — no subprocess spawning,
 * no git CLI dependency, pure filesystem read-only.
 *
 * If git is not present or reading fails, returns { type: 'unknown' }.
 */
export async function detectVcs(rootDir: string): Promise<VcsInfo> {
  try {
    return await detectGit(rootDir);
  } catch {
    return { type: 'unknown' };
  }
}

async function detectGit(rootDir: string): Promise<VcsInfo> {
  const gitDir = await findGitDir(rootDir);
  if (!gitDir) {
    return { type: 'unknown' };
  }

  const headPath = path.join(gitDir, 'HEAD');
  let headContent: string;
  try {
    headContent = (await fs.readFile(headPath, 'utf8')).trim();
  } catch {
    return { type: 'unknown' };
  }

  let sha: string | undefined;
  let branch: string | undefined;

  if (headContent.startsWith('ref: ')) {
    // HEAD points to a branch ref, e.g. "ref: refs/heads/main"
    const refPath = headContent.slice(5);
    branch = refPath.startsWith('refs/heads/') ? refPath.slice(11) : refPath;

    // Resolve the ref to a SHA — try direct file first, then packed-refs
    sha = await resolveRef(gitDir, refPath);
  } else if (/^[0-9a-f]{40}$/i.test(headContent)) {
    // Detached HEAD — raw SHA
    sha = headContent;
  }

  const remoteUrl = await readGitRemoteUrl(gitDir);

  return {
    type: 'git',
    sha: sha ?? undefined,
    shortSha: sha ? sha.slice(0, 7) : undefined,
    branch: branch ?? undefined,
    remoteUrl,
  };
}

/**
 * Walk up from rootDir to find the `.git` directory.
 * Handles both normal repos (.git is a directory) and worktrees (.git is a file
 * containing "gitdir: <path>").
 */
async function findGitDir(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = await fs.stat(gitPath);
      if (stat.isDirectory()) {
        return gitPath;
      }
      if (stat.isFile()) {
        // Worktree: .git file contains "gitdir: <path>"
        const content = (await fs.readFile(gitPath, 'utf8')).trim();
        if (content.startsWith('gitdir: ')) {
          const resolved = path.resolve(dir, content.slice(8));
          return resolved;
        }
      }
    } catch {
      // .git doesn't exist at this level, keep walking up
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolve a git ref (e.g. "refs/heads/main") to a SHA.
 * First tries the loose ref file, then falls back to packed-refs.
 */
async function resolveRef(gitDir: string, refPath: string): Promise<string | undefined> {
  // Try loose ref
  const loosePath = path.join(gitDir, refPath);
  try {
    const sha = (await fs.readFile(loosePath, 'utf8')).trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) {
      return sha;
    }
  } catch {
    // Loose ref doesn't exist — try packed-refs
  }

  // Try packed-refs
  const packedPath = path.join(gitDir, 'packed-refs');
  try {
    const packed = await fs.readFile(packedPath, 'utf8');
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue;
      const parts = line.trim().split(' ');
      if (parts.length >= 2 && parts[1] === refPath) {
        return parts[0];
      }
    }
  } catch {
    // No packed-refs
  }

  return undefined;
}

async function readGitRemoteUrl(gitDir: string): Promise<string | undefined> {
  const configPath = await resolveGitConfigPath(gitDir);
  if (!configPath) return undefined;

  try {
    const config = await fs.readFile(configPath, 'utf8');
    const originBlock = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/);
    if (!originBlock) return undefined;
    const urlMatch = originBlock[1]?.match(/\n\s*url\s*=\s*(.+)\s*/);
    return urlMatch?.[1]?.trim();
  } catch {
    return undefined;
  }
}

async function resolveGitConfigPath(gitDir: string): Promise<string | undefined> {
  const directConfig = path.join(gitDir, 'config');
  try {
    const stat = await fs.stat(directConfig);
    if (stat.isFile()) return directConfig;
  } catch {
    // continue to commondir lookup
  }

  const commonDirFile = path.join(gitDir, 'commondir');
  try {
    const commonDir = (await fs.readFile(commonDirFile, 'utf8')).trim();
    if (!commonDir) return undefined;
    const resolvedCommonDir = path.resolve(gitDir, commonDir);
    const commonConfig = path.join(resolvedCommonDir, 'config');
    const stat = await fs.stat(commonConfig);
    if (stat.isFile()) return commonConfig;
  } catch {
    return undefined;
  }

  return undefined;
}
