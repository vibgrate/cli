import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractContracts, MAX_CONTRACTS } from './contracts.js';

/**
 * A single bounded pass over the source tree that, for every candidate package
 * at once, counts import sites and collects the contract symbols in use. Doing
 * this in one walk (rather than one walk per package) keeps `vg fix` fast on
 * repos with many dependencies. Deterministic: sorted traversal, sorted output.
 *
 * This is pure input-gathering the CLI must do locally — it reads the user's own
 * source, which never leaves the machine. The counts and contracts are shipped
 * to the hosted planner; the risk classification they feed is computed there.
 */

export type SourceEcosystem = 'npm' | 'pypi' | 'unknown';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vibgrate', 'vendor',
  '.venv', 'venv', 'env', '__pycache__', 'target', '.next', '.nuxt', 'coverage', '.cache',
]);
const MAX_FILES = 8000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 1_048_576;

const EXT_ECOSYSTEM: Record<string, SourceEcosystem> = {
  '.ts': 'npm', '.tsx': 'npm', '.js': 'npm', '.jsx': 'npm', '.mjs': 'npm', '.cjs': 'npm',
  '.mts': 'npm', '.cts': 'npm', '.vue': 'npm', '.svelte': 'npm',
  '.py': 'pypi',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function importPattern(ecosystem: 'npm' | 'pypi', pkg: string): RegExp {
  const e = escapeRegExp(pkg);
  if (ecosystem === 'npm') {
    return new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"]${e}(?:/[^'"]*)?['"]`, 'g');
  }
  return new RegExp(`^\\s*(?:import\\s+${e}(?:[.\\s]|$)|from\\s+${e}(?:[.\\s]))`, 'gm');
}

export interface PackageUsage {
  importSites: number;
  filesTouched: number;
  contracts: string[];
}

interface Tracked {
  name: string;
  ecosystem: 'npm' | 'pypi';
  pattern: RegExp;
  importSites: number;
  filesTouched: number;
  contracts: Set<string>;
}

/**
 * Walk `root` once, returning per-package usage keyed by package name. Packages
 * with an `unknown` ecosystem are returned with empty usage (no source scanning
 * applies).
 */
export function analyzeTree(
  root: string,
  packages: Array<{ name: string; ecosystem: SourceEcosystem }>,
): Map<string, PackageUsage> {
  const result = new Map<string, PackageUsage>();
  const tracked: Tracked[] = [];
  for (const p of packages) {
    if (p.ecosystem === 'npm' || p.ecosystem === 'pypi') {
      tracked.push({
        name: p.name,
        ecosystem: p.ecosystem,
        pattern: importPattern(p.ecosystem, p.name),
        importSites: 0,
        filesTouched: 0,
        contracts: new Set(),
      });
    } else {
      result.set(p.name, { importSites: 0, filesTouched: 0, contracts: [] });
    }
  }
  if (tracked.length === 0) return result;

  let filesSeen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || filesSeen >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (filesSeen >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      const fileEco = EXT_ECOSYSTEM[path.extname(entry.name)];
      if (!fileEco || fileEco === 'unknown') continue;
      filesSeen++;
      const full = path.join(dir, entry.name);
      let content: string;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const t of tracked) {
        if (t.ecosystem !== fileEco) continue;
        t.pattern.lastIndex = 0;
        const matches = content.match(t.pattern);
        if (matches && matches.length) {
          t.importSites += matches.length;
          t.filesTouched++;
          if (t.contracts.size < MAX_CONTRACTS) {
            for (const sym of extractContracts(content, t.name, t.ecosystem)) t.contracts.add(sym);
          }
        }
      }
    }
  };
  walk(root, 0);

  for (const t of tracked) {
    result.set(t.name, {
      importSites: t.importSites,
      filesTouched: t.filesTouched,
      contracts: [...t.contracts].sort().slice(0, MAX_CONTRACTS),
    });
  }
  return result;
}
