/**
 * External-surface observation pass.
 *
 * Everything here is deliberately vendor-blind. These functions report *what
 * the repository literally contains* — this package name in this manifest,
 * this hostname in this string literal, this environment-variable NAME in
 * `.env.example`, this model id next to an SDK import, this MCP server block.
 * Not one of them knows that `stripe` means Stripe or that `gpt-4o-mini` is an
 * OpenAI model. That mapping is curated data held in the optional module and
 * reached through `engine/surface-provider.ts`.
 *
 * Keeping the split honest matters for more than licensing: it means a vendor
 * can be added, recategorised or marked deprecated by refreshing one catalog,
 * without shipping a CLI release.
 *
 * Privacy: only names and structure leave this file. Environment variables are
 * read as NAMES, never values; URLs are reduced to a host with no path, query
 * or userinfo; and nothing that matches a credential shape is emitted at all.
 */
import * as path from 'node:path';
import type { DirEntry, FileCache, ProjectScan, ProjectType } from '../../../core-open/index.js';
import { isSkippedDirName } from '../../../core-open/index.js';
import type {
  ApiVersionObservation,
  EnvKeyObservation,
  HostObservation,
  McpServerObservation,
  ModelObservation,
  PackageObservation,
  SurfaceObservations,
} from '../../../engine/surface-provider.js';

/** Source files worth reading for hosts, env names and model ids. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.swift',
  '.yml', '.yaml', '.toml', '.tf', '.env',
]);

/** Config files that carry env-key NAMES rather than values. */
const ENV_NAME_FILES = ['.env.defaults', '.env.example', '.env.sample', '.env.template'] as const;

/**
 * MCP / agent config files, repo-scoped only. Machine-global config
 * (`~/.cursor`, `~/Library/Application Support/Claude`) is deliberately never
 * walked: it is outside the scanned tree, so reading it would make the same
 * repository scan differently on two machines.
 */
const MCP_CONFIG_FILES = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.vibgrate/code.json'];

/** Directories whose contents are never production usage. */
const IGNORED_SEGMENTS = ['node_modules', 'vendor', 'dist', 'build', 'out', '.git', 'target', '__pycache__', 'site-packages'];

/** Read cap per file — a scanner must not be the thing that OOMs a scan. */
const MAX_FILE_BYTES = 512 * 1024;
/** Files read in the observation pass. Bounded so a monorepo stays fast. */
const MAX_FILES = 4000;
/** Observations kept per class, so a generated file cannot flood the batch. */
const MAX_PER_CLASS = 2000;

/** Manifest ecosystem ids, keyed by the project type the base scan reported. */
const ECOSYSTEM_BY_PROJECT_TYPE: Partial<Record<ProjectType, string>> = {
  node: 'npm',
  typescript: 'npm',
  python: 'pypi',
  dotnet: 'nuget',
  java: 'maven',
  kotlin: 'maven',
  scala: 'maven',
  go: 'go',
  rust: 'crates',
  ruby: 'rubygems',
  php: 'packagist',
};

// ── packages ───────────────────────────────────────────────────────────────

/**
 * One observation per (ecosystem, package) across the scan, carrying the first
 * resolved version seen. Deduped so a package declared in five workspace
 * projects is one observation with five project paths folded in by the caller.
 */
export function observePackages(projects: ProjectScan[]): PackageObservation[] {
  const seen = new Map<string, PackageObservation>();
  for (const project of projects) {
    const eco = ECOSYSTEM_BY_PROJECT_TYPE[project.type];
    if (!eco) continue;
    for (const dep of project.dependencies) {
      const key = `${eco}\u0000${dep.package}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        eco,
        name: dep.package,
        version: dep.resolvedVersion,
        file: path.posix.join(toPosix(project.path), manifestName(project.type)),
        project: toPosix(project.path),
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));
}

function manifestName(type: ProjectType): string {
  switch (type) {
    case 'python':
      return 'pyproject.toml';
    case 'dotnet':
      return '*.csproj';
    case 'java':
    case 'kotlin':
    case 'scala':
      return 'pom.xml';
    case 'go':
      return 'go.mod';
    case 'rust':
      return 'Cargo.toml';
    case 'ruby':
      return 'Gemfile';
    case 'php':
      return 'composer.json';
    default:
      return 'package.json';
  }
}

// ── source text ────────────────────────────────────────────────────────────

/** `https://api.stripe.com/v1/charges?key=…` → `api.stripe.com`. Host only:
 *  a path or query string can carry a token, and a host cannot. */
const URL_RE = /\bhttps?:\/\/([A-Za-z0-9._-]+(?::\d+)?)/g;
/** `OPENAI_API_KEY=` / `process.env.X` / `os.environ["X"]` / `env.X`. */
const ENV_RE = /(?:process\s*\.\s*env\s*\.\s*([A-Z][A-Z0-9_]{2,})|process\s*\.\s*env\s*\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]|os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]|System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"|Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]{2,})"|^\s*([A-Z][A-Z0-9_]{2,})\s*=)/gm;
/** A quoted model-ish id: a vendor prefix check happens in the kernel. */
const MODEL_RE = /['"]([A-Za-z][A-Za-z0-9._/-]{2,63})['"]/g;
/** Model ids only ever appear on one of these keys. */
const MODEL_KEY_RE = /\b(model|modelId|model_id|modelName|deployment|deploymentName|engine)['"]?\s*[:=]\s*$/;
/** Pinned vendor API versions. */
const API_VERSION_RE = /['"]?(Stripe-Version|anthropic-version|OpenAI-Beta|X-GitHub-Api-Version|api-version)['"]?\s*[:=]\s*['"]([A-Za-z0-9._-]{3,40})['"]/gi;

/** Imports that mark a file as talking to an inference API. */
const SDK_IMPORT_RE = /\b(?:from|import|require)\b[^\n]{0,120}?['"]([@A-Za-z0-9._/-]+)['"]/g;
/** A file is "near an SDK import" when one of these substrings appears in a
 *  module specifier. Shape only — which vendor it is remains the kernel's job. */
const SDK_IMPORT_HINTS = [
  'openai', 'anthropic', 'generative-ai', 'genai', 'bedrock', 'vertexai', 'cohere',
  'mistral', 'groq', 'together', 'fireworks', 'replicate', 'huggingface', 'ollama',
  'langchain', 'llamaindex', 'ai-sdk', 'xai', 'deepseek', '/ai', 'litellm',
];

/** Hosts that are never a third-party vendor. */
function isLocalHost(host: string): boolean {
  const h = host.split(':')[0].toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.test') ||
    h.endsWith('.example.com') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
  );
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isIgnored(relPath: string): boolean {
  const segments = relPath.split('/');
  return segments.some((s) => IGNORED_SEGMENTS.includes(s) || isSkippedDirName(s));
}

/** 1-based line number of `index` within `text`. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

interface SourceObservations {
  hosts: HostObservation[];
  envKeys: EnvKeyObservation[];
  models: ModelObservation[];
  apiVersions: ApiVersionObservation[];
}

/**
 * One bounded pass over the scanned tree. Deterministic: files are visited in
 * sorted relative-path order, and every observation carries its file and line
 * so the dashboard can show provenance without re-reading the repo.
 */
export async function observeSource(rootDir: string, cache: FileCache, projectPaths: string[]): Promise<SourceObservations> {
  const out: SourceObservations = { hosts: [], envKeys: [], models: [], apiVersions: [] };
  let entries: DirEntry[];
  try {
    entries = await cache.walkDirUnder(rootDir);
  } catch {
    return out;
  }

  const walked = entries
    .filter((e) => e.isFile)
    .map((e) => ({ absPath: e.absPath, name: e.name, relPath: toPosix(e.relPath) }))
    .filter((e) => !isIgnored(e.relPath))
    .filter((e) => SOURCE_EXTENSIONS.has(path.extname(e.name).toLowerCase()) || (ENV_NAME_FILES as readonly string[]).includes(e.name));

  // The shared walk prunes dot-directories and is tuned for source discovery,
  // so `.env.example` and friends are read by name instead of relying on it.
  const envCandidates: Array<{ absPath: string; name: string; relPath: string }> = [];
  for (const dir of ['.', ...projectPaths]) {
    for (const name of ENV_NAME_FILES) {
      const relPath = dir === '.' ? name : `${dir}/${name}`;
      const absPath = path.join(rootDir, ...relPath.split('/'));
      if (await cache.pathExists(absPath)) envCandidates.push({ absPath, name, relPath });
    }
  }

  const seen = new Set<string>();
  const files = [...walked, ...envCandidates]
    .filter((e) => (seen.has(e.relPath) ? false : (seen.add(e.relPath), true)))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .slice(0, MAX_FILES);

  for (const entry of files) {
    // A gitignored `.env` holds real values. Its NAMES are already covered by
    // `.env.example` when one exists, so reading it buys nothing and risks a
    // value landing in the artifact — skip it outright.
    if (entry.name === '.env' || entry.name.startsWith('.env.local')) continue;

    let text: string;
    try {
      text = await cache.readTextFile(entry.absPath);
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES);
    const project = projectFor(entry.relPath, projectPaths);
    const nearSdkImport = hasSdkImport(text);

    for (const m of text.matchAll(URL_RE)) {
      const host = m[1].split(':')[0].toLowerCase();
      if (isLocalHost(host) || !host.includes('.')) continue;
      if (out.hosts.length >= MAX_PER_CLASS) break;
      out.hosts.push({ host, file: entry.relPath, line: lineOf(text, m.index ?? 0), project });
    }

    if ((ENV_NAME_FILES as readonly string[]).includes(entry.name) || SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      for (const m of text.matchAll(ENV_RE)) {
        const key = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
        if (!key || out.envKeys.length >= MAX_PER_CLASS) continue;
        out.envKeys.push({ key, file: entry.relPath, line: lineOf(text, m.index ?? 0), project });
      }
    }

    for (const m of text.matchAll(MODEL_RE)) {
      if (out.models.length >= MAX_PER_CLASS) break;
      const index = m.index ?? 0;
      // Only a value sitting on a model-ish key counts. Without this every
      // quoted string in the repo would be offered to the kernel as a model id.
      const before = text.slice(Math.max(0, index - 60), index);
      if (!MODEL_KEY_RE.test(before.replace(/\s+$/, ' '))) continue;
      out.models.push({ id: m[1], file: entry.relPath, line: lineOf(text, index), project, nearSdkImport });
    }

    for (const m of text.matchAll(API_VERSION_RE)) {
      if (out.apiVersions.length >= MAX_PER_CLASS) break;
      out.apiVersions.push({ field: m[1], value: m[2], file: entry.relPath, line: lineOf(text, m.index ?? 0), project });
    }
  }
  return out;
}

function hasSdkImport(text: string): boolean {
  for (const m of text.matchAll(SDK_IMPORT_RE)) {
    const spec = m[1].toLowerCase();
    if (SDK_IMPORT_HINTS.some((h) => spec.includes(h))) return true;
  }
  return false;
}

/** The deepest project path containing this file, or `.` for the repo root. */
function projectFor(relPath: string, projectPaths: string[]): string {
  let best = '.';
  for (const p of projectPaths) {
    const prefix = p === '.' ? '' : `${p}/`;
    if (prefix && relPath.startsWith(prefix) && p.length > best.length) best = p;
  }
  return best;
}

// ── MCP / agent config ─────────────────────────────────────────────────────

/**
 * Repo-scoped MCP server blocks. Accepts both community shapes — an
 * `mcpServers` map (Claude Code, Cursor) and a `servers` map (VS Code) — and
 * lets `.vibgrate/code.json` win on a name collision, the same precedence
 * `code/mcp-discovery.ts` applies at runtime.
 */
export async function observeMcpServers(rootDir: string, cache: FileCache): Promise<McpServerObservation[]> {
  const byName = new Map<string, McpServerObservation>();
  for (const rel of MCP_CONFIG_FILES) {
    const abs = path.join(rootDir, ...rel.split('/'));
    if (!(await cache.pathExists(abs))) continue;
    let parsed: { mcpServers?: unknown; servers?: unknown };
    try {
      parsed = (await cache.readJsonFile(abs)) as { mcpServers?: unknown; servers?: unknown };
    } catch {
      continue;
    }
    const map = (parsed?.mcpServers ?? parsed?.servers) as Record<string, unknown> | undefined;
    if (!map || typeof map !== 'object') continue;
    for (const [name, value] of Object.entries(map)) {
      const cfg = (value ?? {}) as Record<string, unknown>;
      const url = typeof cfg.url === 'string' ? cfg.url : '';
      byName.set(name, {
        name,
        transport: transportOf(cfg, url),
        command: typeof cfg.command === 'string' ? cfg.command : undefined,
        args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
        // Host only. A remote MCP URL routinely carries an access token in its
        // query string, and the host is all the inventory needs.
        urlHost: hostOf(url),
        tools: Array.isArray(cfg.tools) ? cfg.tools.filter((t): t is string => typeof t === 'string') : [],
        file: rel,
        project: '.',
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function transportOf(cfg: Record<string, unknown>, url: string): 'stdio' | 'sse' | 'http' | undefined {
  const declared = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : '';
  if (declared === 'sse' || declared === 'http' || declared === 'stdio') return declared;
  if (url) return 'http';
  if (cfg.command) return 'stdio';
  return undefined;
}

function hostOf(url: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

// ── batch ──────────────────────────────────────────────────────────────────

/** Assemble everything the kernel needs for one scan. */
export async function observeSurfaces(
  rootDir: string,
  cache: FileCache,
  projects: ProjectScan[],
  today: string,
): Promise<SurfaceObservations> {
  const projectPaths = projects.map((p) => toPosix(p.path)).filter((p) => p && p !== '.');
  const [source, mcpServers] = await Promise.all([
    observeSource(rootDir, cache, projectPaths),
    observeMcpServers(rootDir, cache),
  ]);
  return {
    today,
    packages: observePackages(projects),
    hosts: source.hosts,
    envKeys: source.envKeys,
    models: source.models,
    apiVersions: source.apiVersions,
    mcpServers,
  };
}
