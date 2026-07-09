import * as path from 'node:path';
import { pathExists, readTextFile, FileCache } from '../../core-open/index.js';
import type { SecurityPostureResult } from '../../core-open/index.js';

const LOCKFILES: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'packages.lock.json': 'nuget',
};

/** Patterns that .gitignore should cover for security hygiene */
const HYGIENE_PATTERNS = {
  env: ['.env', '.env.*', '.env.local', '.env.*.local'],
  nodeModules: ['node_modules', 'node_modules/'],
};

export async function scanSecurityPosture(rootDir: string, cache?: FileCache): Promise<SecurityPostureResult> {
  const result: SecurityPostureResult = {
    lockfilePresent: false,
    multipleLockfileTypes: false,
    gitignoreCoversEnv: false,
    gitignoreCoversNodeModules: false,
    envFilesTracked: false,
    lockfileTypes: [],
  };

  const _pathExists = cache ? (p: string) => cache.pathExists(p) : pathExists;
  const _readTextFile = cache ? (p: string) => cache.readTextFile(p) : readTextFile;

  // Check lockfile presence
  const foundLockfiles: string[] = [];
  for (const [file, type] of Object.entries(LOCKFILES)) {
    if (await _pathExists(path.join(rootDir, file))) {
      foundLockfiles.push(type);
    }
  }
  result.lockfilePresent = foundLockfiles.length > 0;
  result.multipleLockfileTypes = foundLockfiles.length > 1;
  result.lockfileTypes = foundLockfiles.sort();

  // Parse .gitignore
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (await _pathExists(gitignorePath)) {
    try {
      const content = await _readTextFile(gitignorePath);
      const lines = content.split('\n').map((l) => l.trim());

      // Check for .env coverage
      result.gitignoreCoversEnv = lines.some((line) =>
        line === '.env' ||
        line === '.env*' ||
        line === '.env.*' ||
        line === '.env.local' ||
        line === '*.env',
      );

      // Check for node_modules coverage
      result.gitignoreCoversNodeModules = lines.some((line) =>
        line === 'node_modules' ||
        line === 'node_modules/' ||
        line === '/node_modules',
      );
    } catch { /* skip */ }
  }

  // Check if .env files exist (at root only — not recursive to avoid scanning too deep)
  for (const envFile of ['.env', '.env.local', '.env.development', '.env.production']) {
    if (await _pathExists(path.join(rootDir, envFile))) {
      // If .gitignore doesn't cover .env files, they're potentially tracked
      if (!result.gitignoreCoversEnv) {
        result.envFilesTracked = true;
        break;
      }
    }
  }

  return result;
}
