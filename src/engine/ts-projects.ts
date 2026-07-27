/**
 * Partition TS/JS files into project shards for incremental / monorepo-safe
 * TypeScript Compiler API resolution. Each shard gets its own `createProgram`
 * so a large monorepo never pays for one giant Program over every package.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TsFile {
  rel: string;
  abs: string;
}

export interface TsProjectShard {
  /** Directory that owns the nearest tsconfig / package.json (repo-relative POSIX). */
  key: string;
  files: TsFile[];
}

/**
 * Group files by nearest ancestor that contains `tsconfig.json` /
 * `tsconfig.base.json` / `package.json`, falling back to the repo root.
 * Deterministic: shards sorted by key; files within a shard sorted by rel.
 */
export function shardTsProjects(root: string, files: TsFile[]): TsProjectShard[] {
  if (files.length === 0) return [];

  const cache = new Map<string, string>(); // abs dir → project key (rel posix)
  const byKey = new Map<string, TsFile[]>();

  for (const f of files) {
    const dir = path.dirname(f.abs);
    const key = nearestProjectKey(root, dir, cache);
    const list = byKey.get(key);
    if (list) list.push(f);
    else byKey.set(key, [f]);
  }

  return [...byKey.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, shardFiles]) => ({
      key,
      files: [...shardFiles].sort((a, b) => a.rel.localeCompare(b.rel)),
    }));
}

function nearestProjectKey(root: string, startDir: string, cache: Map<string, string>): string {
  const hit = cache.get(startDir);
  if (hit !== undefined) return hit;

  let dir = startDir;
  const rootAbs = path.resolve(root);
  while (true) {
    if (
      fs.existsSync(path.join(dir, 'tsconfig.json')) ||
      fs.existsSync(path.join(dir, 'tsconfig.base.json')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      const key = toPosix(path.relative(rootAbs, dir)) || '.';
      cache.set(startDir, key);
      return key;
    }
    if (dir === rootAbs || path.dirname(dir) === dir) {
      cache.set(startDir, '.');
      return '.';
    }
    dir = path.dirname(dir);
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
