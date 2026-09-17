/**
 * Shared, best-effort loaders for architecture-map overlays.
 * Never throws. Absent source is `null` / empty — never a fabricated zero.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScanArtifact, ScanReachabilityFinding } from '../../core-open/index.js';
import type { VgGraph } from '../../schema.js';

export const SCAN_ARTIFACT_REL = '.vibgrate/scan_result.json';
export const CHURN_COMMIT_CAP = 400;
export const MAX_OVERLAY_PACKAGES = 6;

export interface OverlayProjectDrift {
  path: string;
  name: string;
  /** Dependencies that are actually behind — never `current` / `unknown`. */
  drifted: Array<{ package: string; band: 'minor' | 'major' }>;
}

export interface CodeOwnerRule {
  pattern: string;
  owners: string[];
}

export interface OverlayContext {
  root: string;
  graph: VgGraph | null;
  artifact: Partial<ScanArtifact> | null;
  reachability: ScanReachabilityFinding[];
  projects: OverlayProjectDrift[];
  /** Null when no CODEOWNERS file exists. */
  owners: CodeOwnerRule[] | null;
  /** Null when git history is unavailable. Empty map = git ok, no touches. */
  churn: Map<string, number> | null;
}

const contextCache = new Map<string, OverlayContext>();

export function posixPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function pathUnder(file: string, dir: string): boolean {
  const f = posixPath(file);
  const d = posixPath(dir);
  if (!d || d === '.') return true;
  return f === d || f.startsWith(`${d}/`);
}

export function loadOverlayContext(root: string, graph?: VgGraph | null): OverlayContext {
  const key = cacheKey(root);
  const hit = contextCache.get(key);
  if (hit) {
    if (graph && !hit.graph) hit.graph = graph;
    return hit;
  }
  const artifact = loadScanArtifact(root);
  const ctx: OverlayContext = {
    root,
    graph: graph ?? null,
    artifact,
    reachability: Array.isArray(artifact?.reachability?.findings) ? artifact!.reachability!.findings : [],
    projects: projectDriftOf(artifact),
    owners: loadCodeowners(root),
    churn: loadPathChurn(root),
  };
  contextCache.set(key, ctx);
  return ctx;
}

/** Test-only: drop the process-local overlay cache. */
export function resetOverlayContextCache(): void {
  contextCache.clear();
}

function cacheKey(root: string): string {
  const abs = path.resolve(root);
  const scan = stamp(path.join(abs, SCAN_ARTIFACT_REL));
  const owners = CODEOWNERS_RELS.map((rel) => stamp(path.join(abs, rel))).join(',');
  const head = gitHead(abs);
  return `${abs}|${scan}|${owners}|${head}`;
}

function stamp(abs: string): string {
  try {
    const st = fs.statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '0';
  }
}

function gitHead(root: string): string {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      timeout: 4_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    }).trim();
  } catch {
    return '0';
  }
}

export function loadScanArtifact(root: string): Partial<ScanArtifact> | null {
  try {
    const abs = path.join(root, SCAN_ARTIFACT_REL);
    if (!fs.existsSync(abs)) return null;
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as Partial<ScanArtifact>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function projectDriftOf(artifact: Partial<ScanArtifact> | null): OverlayProjectDrift[] {
  if (!artifact || !Array.isArray(artifact.projects)) return [];
  const out: OverlayProjectDrift[] = [];
  for (const project of artifact.projects) {
    if (!project || typeof project !== 'object') continue;
    const projPath = typeof project.path === 'string' ? posixPath(project.path) : '';
    const name = typeof project.name === 'string' ? project.name : projPath;
    const drifted: OverlayProjectDrift['drifted'] = [];
    const seen = new Set<string>();
    for (const dep of project.dependencies ?? []) {
      if (!dep || typeof dep !== 'object') continue;
      const band = driftBand(dep.drift);
      if (!band || typeof dep.package !== 'string' || !dep.package) continue;
      if (seen.has(dep.package)) continue;
      seen.add(dep.package);
      drifted.push({ package: dep.package, band });
    }
    drifted.sort((a, b) => (a.band === b.band ? a.package.localeCompare(b.package) : a.band === 'major' ? -1 : 1));
    out.push({ path: projPath, name, drifted });
  }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  return out;
}

export function driftBand(raw: unknown): 'minor' | 'major' | null {
  if (raw === 'major-behind' || raw === 'major') return 'major';
  if (raw === 'minor-behind' || raw === 'minor' || raw === 'patch-behind' || raw === 'patch') return 'minor';
  return null;
}

const CODEOWNERS_RELS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

export function loadCodeowners(root: string): CodeOwnerRule[] | null {
  for (const rel of CODEOWNERS_RELS) {
    const abs = path.join(root, rel);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      return parseCodeowners(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
  }
  return null;
}

export function parseCodeowners(text: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern) continue;
    const owners = [...new Set(parts.slice(1).filter((p) => p.startsWith('@') || p.includes('@')))].sort((a, b) =>
      a.localeCompare(b),
    );
    if (!owners.length) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Last-match-wins, GitHub-style. `*` / `**` / `?`, optional leading `/` (repo root),
 * trailing `/` (directory prefix). Unanchored patterns match any path segment.
 */
export function matchCodeownersPattern(pattern: string, file: string): boolean {
  const f = posixPath(file);
  let p = pattern.replace(/\\/g, '/');
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  if (!p) return anchored ? true : f.length > 0;
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GS}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GS\}\}/g, '.*');
  const suffix = dirOnly ? '(?:/.*)?' : '';
  try {
    if (anchored) return new RegExp(`^${escaped}${suffix}$`).test(f);
    return new RegExp(`(?:^|/)${escaped}${suffix}$`).test(f);
  } catch {
    return false;
  }
}

export function ownersForPath(rules: CodeOwnerRule[], file: string): string[] | undefined {
  let matched: string[] | undefined;
  for (const rule of rules) {
    if (matchCodeownersPattern(rule.pattern, file)) matched = rule.owners;
  }
  return matched;
}

export function ownerTone(team: string): number {
  let h = 0;
  for (let i = 0; i < team.length; i++) h = (Math.imul(h, 31) + team.charCodeAt(i)) >>> 0;
  return h % 8;
}

export function loadPathChurn(root: string): Map<string, number> | null {
  try {
    const inside = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    }).trim();
    if (inside !== 'true') return null;
  } catch {
    return null;
  }
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '--name-only', '--pretty=format:', `--max-count=${CHURN_COMMIT_CAP}`, '--no-merges'],
      {
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: gitEnv(),
      },
    );
    const counts = new Map<string, number>();
    for (const line of out.split('\n')) {
      const file = posixPath(line.trim());
      if (!file) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    return counts;
  } catch {
    return new Map();
  }
}

export function heatOf(count: number, positives: number[]): 1 | 2 | 3 | 4 | 5 | null {
  if (count <= 0 || !positives.length) return null;
  const sorted = [...positives].filter((n) => n > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = sorted.filter((n) => n <= count).length / sorted.length;
  if (rank <= 0.2) return 1;
  if (rank <= 0.4) return 2;
  if (rank <= 0.6) return 3;
  if (rank <= 0.8) return 4;
  return 5;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  };
}
