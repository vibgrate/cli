// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Dirent } from 'node:fs';
import { Semaphore } from './semaphore.js';
import { compileGlobs } from './glob.js';


const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  'node_modules',
  // Vendored third-party dependency trees (Go vendor/, PHP composer,
  // Rails vendor/) — their manifests are not the repo's own projects and
  // their runtimes/dependencies must not produce drift findings.
  'vendor',
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
]);

/** File extensions skipped during the walk — binary/font/media that no scanner needs to read */
const SKIP_EXTENSIONS = new Set([
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Images & vector
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.tiff', '.tif', '.webp', '.avif', '.svg',
  '.heic', '.heif', '.jfif', '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef', '.dng',
  // Video
  '.mp4', '.webm', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.wma', '.m4a', '.opus', '.aiff', '.mid', '.midi',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  // Compiled / binary
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.class', '.pyc', '.pdb',
  // Source maps & lockfiles (large, not useful for drift analysis)
  '.map',
]);

const EXTRA_SKIP_DIRS = new Set(['.nuxt', '.output', '.svelte-kit']);

/**
 * Lockfiles and generated dependency manifests excluded from the billing
 * source-size metrics. They are not source code and a single one (e.g. a
 * pnpm-lock.yaml) can exceed 1 MB on its own, which would otherwise inflate a
 * genuinely tiny project past the micro/small size thresholds. Compared
 * case-insensitively against the file basename.
 */
const SOURCE_EXCLUDE_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'composer.lock',
  'cargo.lock',
  'packages.lock.json',
  'go.sum',
  'gradle.lockfile',
  'deno.lock',
  'flake.lock',
]);

// ── Directory entry gathered in a single walk ──

export interface DirEntry {
  /** Absolute path */
  absPath: string;
  /** Path relative to the walk root */
  relPath: string;
  /** Filename (basename) */
  name: string;
  /** Whether this is a regular file */
  isFile: boolean;
  /** Whether this is a directory */
  isDirectory: boolean;
}

// ── FileCache: walk once, read once ──

/**
 * Maximum file size (in bytes) that will be held in the text cache.
 * Files larger than this are read from disk but NOT stored — this prevents
 * lockfiles (pnpm-lock.yaml, package-lock.json, etc.) from consuming
 * 50-200 MB of heap.  Small config files like package.json (~1-5 KB each)
 * are cached normally.
 */
const TEXT_CACHE_MAX_BYTES = 1_048_576; // 1 MB

/**
 * Shared cache that ensures the filesystem is walked at most once per root dir
 * and every small file is read at most once across all scanners.
 *
 * Memory-conscious design:
 * - Walk results are stored once; consumers filter in-memory.
 * - File content is only cached when ≤ TEXT_CACHE_MAX_BYTES (1 MB).
 *   Large files (lockfiles) pass straight through without caching.
 * - readJsonFile evicts the raw-text entry after parsing so we never
 *   hold *both* the string and the parsed object for the same file.
 * - No stat caching — only file-hotspots uses stat and there's no
 *   cross-scanner reuse to justify holding thousands of Stats objects.
 * - Call `clear()` after the scan to release all remaining references.
 */
export class FileCache {
  /** Directory walk results keyed by rootDir */
  private walkCache = new Map<string, Promise<DirEntry[]>>();
  /** File content keyed by absolute path (only files ≤ TEXT_CACHE_MAX_BYTES) */
  private textCache = new Map<string, Promise<string>>();
  /** Parsed JSON keyed by absolute path */
  private jsonCache = new Map<string, Promise<unknown>>();
  /** pathExists keyed by absolute path */
  private existsCache = new Map<string, Promise<boolean>>();
  /** User-configured exclude predicate (compiled from glob patterns) */
  private excludePredicate: ((relPath: string) => boolean) | null = null;
  /** Directories that were auto-skipped because they were stuck */
  private _stuckPaths: string[] = [];
  /** Files skipped because they exceed maxFileSizeToScan */
  private _skippedLargeFiles: string[] = [];
  /** Maximum file size (bytes) we will read. 0 = unlimited. */
  private _maxFileSize = 0;
  /** Per-project / per-directory scan timeout in ms. */
  private _projectScanTimeout = 180_000;
  /** Whether we have already shown the "increase projectScanTimeout" hint */
  private _timeoutHintShown = false;
  /** Root dir for relative-path computation (set by the first walkDir call) */
  private _rootDir: string | null = null;
  /** Cached tree summary captured during the shared walk */
  private walkSummary = new Map<string, TreeCount>();
  /** Fast lookup for exact filename (e.g. package.json) */
  private fileNameIndex = new Map<string, Map<string, string[]>>();
  /** Per-file byte size keyed by absolute path (memoised so nested projects don't re-stat) */
  private sizeCache = new Map<string, Promise<number>>();
  /** Concurrency limiter for size stats */
  private sizeSem = new Semaphore(64);

  /** Set exclude patterns from config (call once before the walk) */
  setExcludePatterns(patterns: string[]): void {
    this.excludePredicate = compileGlobs(patterns);
  }

  /** Set the maximum file size in bytes that readTextFile / readJsonFile will process */
  setMaxFileSize(bytes: number): void {
    this._maxFileSize = bytes;
  }

  /** Set the per-project scan timeout (milliseconds). Scanners use this
   *  instead of a hard-coded constant so the user can override it via config. */
  setProjectScanTimeout(ms: number): void {
    this._projectScanTimeout = ms;
  }

  /** Current per-project scan timeout in milliseconds */
  get projectScanTimeout(): number {
    return this._projectScanTimeout;
  }

  /** Record a path that timed out or was stuck during scanning */
  addStuckPath(relPath: string): void {
    this._stuckPaths.push(relPath);
  }

  /**
   * Returns true the first time it is called, false thereafter.
   * Used by scanners to print the "increase projectScanTimeout" hint
   * only once per scan run.
   */
  shouldShowTimeoutHint(): boolean {
    if (this._timeoutHintShown) return false;
    this._timeoutHintShown = true;
    return true;
  }

  /** Get all paths that were auto-skipped due to being stuck (dirs + scanner files) */
  get stuckPaths(): readonly string[] {
    return this._stuckPaths;
  }

  /** @deprecated Use stuckPaths instead */
  get stuckDirs(): readonly string[] {
    return this._stuckPaths;
  }

  /** Get files that were skipped because they exceeded maxFileSizeToScan */
  get skippedLargeFiles(): readonly string[] {
    return this._skippedLargeFiles;
  }

  // ── Directory walking ──

  /**
   * Walk the directory tree from `rootDir` once, skipping SKIP_DIRS plus
   * common framework output dirs (.nuxt, .output, .svelte-kit).
   *
   * The result is memoised so every scanner filters the same array.
   * Consumers that need additional filtering (e.g. SOURCE_EXTENSIONS,
   * SKIP_EXTENSIONS) do so on the returned entries — no separate walk.
   */
  walkDir(rootDir: string, onProgress?: (filesFound: number, currentPath: string) => void): Promise<DirEntry[]> {
    this._rootDir = rootDir;
    const cached = this.walkCache.get(rootDir);
    if (cached) return cached;

    const promise = this._doWalk(rootDir, onProgress);
    this.walkCache.set(rootDir, promise);
    return promise;
  }

  /** Return tree summary from the cached walk, if available. */
  getWalkSummary(rootDir: string): TreeCount | undefined {
    return this.walkSummary.get(rootDir);
  }

  /** Additional dirs skipped only by the cached walk (framework outputs) */
  private static readonly EXTRA_SKIP = EXTRA_SKIP_DIRS;

  private async _doWalk(rootDir: string, onProgress?: (filesFound: number, currentPath: string) => void): Promise<DirEntry[]> {
    const results: DirEntry[] = [];
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 4;
    const maxConcurrentReads = Math.max(8, Math.min(64, cores * 4));
    let foundCount = 0;
    let lastReported = 0;
    const REPORT_INTERVAL = 50; // report every N files
    // Semaphore limits concurrent readdir I/O only — NOT the entire
    // recursive walk.  Previously sem.run wrapped the whole walk(),
    // so parent directories held a slot while awaiting children,
    // starving deep trees into near-serial execution.
    const sem = new Semaphore(maxConcurrentReads);
    const STUCK_TIMEOUT_MS = this._projectScanTimeout;

    const extraSkip = FileCache.EXTRA_SKIP;
    const isExcluded = this.excludePredicate;
    const stuckDirs = this._stuckPaths;

    async function walk(dir: string) {
      const relDir = path.relative(rootDir, dir);

      // Report the directory we are ABOUT to read so the UI shows
      // where we are if this readdir gets stuck.
      if (onProgress) {
        onProgress(foundCount, relDir || '.');
      }

      // Acquire the semaphore ONLY for the readdir I/O, then release
      // immediately so parent dirs don't hold slots while awaiting children.
      let entries: Dirent[] | null;
      try {
        entries = await sem.run(async () => {
          const readPromise = fs.readdir(dir, { withFileTypes: true });
          let stuckTimer: ReturnType<typeof setTimeout>;
          const result = await Promise.race([
            readPromise.then((e) => ({ ok: true as const, entries: e })),
            new Promise<{ ok: false }>((resolve) => {
              stuckTimer = setTimeout(() => resolve({ ok: false }), STUCK_TIMEOUT_MS);
              stuckTimer.unref();
            }),
          ]);
          clearTimeout(stuckTimer!);
          if (!result.ok) {
            // Directory read timed out — record and skip
            stuckDirs.push(relDir || dir);
            return null;
          }
          return result.entries;
        });
      } catch {
        return;
      }
      if (!entries) return;

      const subWalks: Promise<void>[] = [];
      for (const e of entries) {
        const absPath = path.join(dir, e.name);
        const relPath = path.relative(rootDir, absPath);

        // Check user-configured excludes
        if (isExcluded && isExcluded(relPath)) continue;

        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || extraSkip.has(e.name)) continue;
          results.push({ absPath, relPath, name: e.name, isFile: false, isDirectory: true });
          // Launch sub-walk WITHOUT wrapping in sem.run — child walks
          // acquire the semaphore independently for their own readdir.
          subWalks.push(walk(absPath));
        } else if (e.isFile()) {
          // Skip binary/font/media files that no scanner needs
          const ext = path.extname(e.name).toLowerCase();
          if (SKIP_EXTENSIONS.has(ext)) continue;
          results.push({ absPath, relPath, name: e.name, isFile: true, isDirectory: false });
          foundCount++;
          if (onProgress && foundCount - lastReported >= REPORT_INTERVAL) {
            lastReported = foundCount;
            onProgress(foundCount, relPath);
          }
        }
      }
      await Promise.all(subWalks);
    }

    await walk(rootDir);

    let totalDirs = 0;
    const rootNameIndex = new Map<string, string[]>();
    for (const entry of results) {
      if (entry.isDirectory) totalDirs++;
      if (!entry.isFile) continue;
      const bucket = rootNameIndex.get(entry.name);
      if (bucket) {
        bucket.push(entry.absPath);
      } else {
        rootNameIndex.set(entry.name, [entry.absPath]);
      }
    }
    this.walkSummary.set(rootDir, { totalFiles: foundCount, totalDirs });
    this.fileNameIndex.set(rootDir, rootNameIndex);

    // Final progress report
    if (onProgress && foundCount !== lastReported) {
      onProgress(foundCount, '');
    }
    return results;
  }

  /**
   * Find files matching a predicate from the cached walk.
   * Returns absolute paths (same contract as the standalone `findFiles`).
   */
  async findFiles(rootDir: string, predicate: (name: string) => boolean): Promise<string[]> {
    const entries = await this.walkDir(rootDir);
    return entries.filter((e) => e.isFile && predicate(e.name)).map((e) => e.absPath);
  }

  async findPackageJsonFiles(rootDir: string): Promise<string[]> {
    await this.walkDir(rootDir);
    return this.fileNameIndex.get(rootDir)?.get('package.json') ?? [];
  }

  async findCsprojFiles(rootDir: string): Promise<string[]> {
    const entries = await this.walkDir(rootDir);
    return entries.filter((e) => e.isFile && e.name.endsWith('.csproj')).map((e) => e.absPath);
  }

  async findSolutionFiles(rootDir: string): Promise<string[]> {
    const entries = await this.walkDir(rootDir);
    return entries.filter((e) => e.isFile && e.name.endsWith('.sln')).map((e) => e.absPath);
  }

  /**
   * Count files under a given directory using the cached walk data.
   * Avoids a redundant recursive readdir that can be slow on large
   * project trees (the main cause of per-project timeout hits).
   * Falls back to the standalone `countFilesInDir` if the walk hasn't
   * been populated yet.
   */
  async countFilesUnder(rootDir: string, dir: string): Promise<number> {
    const entries = this.walkCache.get(rootDir);
    if (!entries) {
      // Walk not done yet — fall back to standalone count
      return countFilesInDir(dir);
    }
    const resolved = await entries;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    let count = 0;
    for (const e of resolved) {
      if (!e.isFile) continue;
      // File is directly in `dir` or in a subdirectory of `dir`
      if (e.absPath === dir || e.absPath.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  /** Stat a single file's byte size, memoised and concurrency-limited. */
  private statSize(absPath: string): Promise<number> {
    const cached = this.sizeCache.get(absPath);
    if (cached) return cached;
    const promise = this.sizeSem.run(async () => {
      try {
        const stat = await fs.stat(absPath);
        return stat.size;
      } catch {
        return 0;
      }
    });
    this.sizeCache.set(absPath, promise);
    return promise;
  }

  /**
   * Sum the byte size of every file under `dir` using the cached walk.
   * Mirrors {@link countFilesUnder}; per-file stats are memoised so nested
   * project trees are never stat-ed twice. Falls back to a standalone walk
   * when the cache has not been populated yet.
   */
  async bytesUnder(rootDir: string, dir: string): Promise<number> {
    const entries = this.walkCache.get(rootDir);
    if (!entries) {
      // Walk not done yet — fall back to a standalone size walk
      return bytesInDir(dir);
    }
    const resolved = await entries;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const sizes = await Promise.all(
      resolved
        .filter((e) => e.isFile && (e.absPath === dir || e.absPath.startsWith(prefix)))
        .map((e) => this.statSize(e.absPath)),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }

  /**
   * Source-only file count and byte size under `dir`, used for billing
   * classification. Identical to {@link countFilesUnder} / {@link bytesUnder}
   * but additionally excludes lockfiles and generated dependency manifests
   * (see {@link SOURCE_EXCLUDE_FILES}); vendored and build-output directories
   * are already excluded by the shared walk. Walks the cached entries once so
   * the count and size stay consistent. Falls back to the standalone walks
   * when the cache has not been populated yet.
   */
  async sourceMetricsUnder(rootDir: string, dir: string): Promise<{ fileCount: number; sizeBytes: number }> {
    const entries = this.walkCache.get(rootDir);
    if (!entries) {
      // Walk not done yet — fall back to standalone walks.
      const [fileCount, sizeBytes] = await Promise.all([countFilesInDir(dir), bytesInDir(dir)]);
      return { fileCount, sizeBytes };
    }
    const resolved = await entries;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const sourceFiles = resolved.filter(
      (e) =>
        e.isFile &&
        (e.absPath === dir || e.absPath.startsWith(prefix)) &&
        !SOURCE_EXCLUDE_FILES.has(e.name.toLowerCase()),
    );
    const sizes = await Promise.all(sourceFiles.map((e) => this.statSize(e.absPath)));
    return {
      fileCount: sourceFiles.length,
      sizeBytes: sizes.reduce((total, size) => total + size, 0),
    };
  }

  // ── File content reading ──

  /**
   * Read a text file. Files ≤ 1 MB are cached so subsequent calls from
   * different scanners return the same string. Files > 1 MB (lockfiles,
   * large generated files) are read directly and never retained.
   *
   * If maxFileSizeToScan is set and the file exceeds it, the file is
   * recorded as skipped and an empty string is returned.
   */
  readTextFile(filePath: string): Promise<string> {
    const abs = path.resolve(filePath);
    const cached = this.textCache.get(abs);
    if (cached) return cached;

    const maxSize = this._maxFileSize;
    const skippedLarge = this._skippedLargeFiles;
    const rootDir = this._rootDir;

    // Read file, then decide whether to cache based on size
    const promise = (async () => {
      // Check file size before reading when a limit is configured
      if (maxSize > 0) {
        try {
          const stat = await fs.stat(abs);
          if (stat.size > maxSize) {
            const rel = rootDir ? path.relative(rootDir, abs) : abs;
            skippedLarge.push(rel);
            this.textCache.delete(abs);
            return '';
          }
        } catch {
          // If stat fails, fall through and let readFile handle it
        }
      }

      const content = await fs.readFile(abs, 'utf8');
      if (content.length > TEXT_CACHE_MAX_BYTES) {
        // Too large for cache — evict so we don't hold it
        this.textCache.delete(abs);
      }
      return content;
    })();

    // Temporarily store the promise so concurrent callers during the same
    // tick await the same read (avoids double-reads even for large files).
    this.textCache.set(abs, promise);
    return promise;
  }

  /**
   * Read and parse a JSON file. The parsed object is cached; the raw
   * text is evicted immediately so we never hold both representations.
   */
  readJsonFile<T>(filePath: string): Promise<T> {
    const abs = path.resolve(filePath);
    const cached = this.jsonCache.get(abs);
    if (cached) return cached as Promise<T>;

    const promise = this.readTextFile(abs).then((txt) => {
      // Evict raw text — we now have the parsed object
      this.textCache.delete(abs);
      return JSON.parse(stripBom(txt)) as T;
    });
    this.jsonCache.set(abs, promise);
    return promise;
  }

  // ── Existence checks ──

  pathExists(p: string): Promise<boolean> {
    const abs = path.resolve(p);
    const cached = this.existsCache.get(abs);
    if (cached) return cached;
    const promise = fs.access(abs).then(() => true, () => false);
    this.existsCache.set(abs, promise);
    return promise;
  }

  // ── Lifecycle ──

  /** Release all cached data. Call after the scan completes. */
  clear(): void {
    this.walkCache.clear();
    this.walkSummary.clear();
    this.fileNameIndex.clear();
    this.textCache.clear();
    this.jsonCache.clear();
    this.existsCache.clear();
    this.sizeCache.clear();
  }

  /** Number of file content entries currently held */
  get textCacheSize(): number { return this.textCache.size; }
  /** Number of parsed JSON entries currently held */
  get jsonCacheSize(): number { return this.jsonCache.size; }
}

// ── Quick tree count (fast pre-scan) ──

export interface TreeCount {
  /** Total files discovered (excluding skipped dirs) */
  totalFiles: number;
  /** Total subdirectories discovered (excluding skipped dirs) */
  totalDirs: number;
}

/**
 * Fast, lightweight traversal that only *counts* files and directories
 * without storing entries.  Used before the main scan so the progress
 * bar can show an accurate percentage.
 *
 * Respects the same SKIP_DIRS as the full walk.
 */
export async function quickTreeCount(rootDir: string, excludePatterns?: string[]): Promise<TreeCount> {
  const native = await quickTreeCountWithRipgrep(rootDir, excludePatterns);
  if (native) return native;

  let totalFiles = 0;
  let totalDirs = 0;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 4;
  const maxConcurrent = Math.max(8, Math.min(128, cores * 8));
  const sem = new Semaphore(maxConcurrent);
  const extraSkip = EXTRA_SKIP_DIRS;
  const isExcluded = excludePatterns ? compileGlobs(excludePatterns) : null;

  async function count(dir: string) {
    let entries: Dirent[];
    try {
      entries = await sem.run(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    const subs: Promise<void>[] = [];
    for (const e of entries) {
      const relPath = path.relative(rootDir, path.join(dir, e.name));
      if (isExcluded && isExcluded(relPath)) continue;

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || extraSkip.has(e.name)) continue;
        totalDirs++;
        subs.push(count(path.join(dir, e.name)));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SKIP_EXTENSIONS.has(ext)) totalFiles++;
      }
    }
    await Promise.all(subs);
  }

  await count(rootDir);
  return { totalFiles, totalDirs };
}



export function normalizeGlobForRipgrep(pattern: string): string {
  return pattern.replace(/\\/g, '/');
}

async function quickTreeCountWithRipgrep(rootDir: string, excludePatterns?: string[]): Promise<TreeCount | null> {
  const args = ['--files', '--hidden', '--no-ignore', '--null'];

  for (const dir of SKIP_DIRS) {
    args.push('-g', `!**/${dir}/**`);
  }
  for (const dir of EXTRA_SKIP_DIRS) {
    args.push('-g', `!**/${dir}/**`);
  }
  for (const ext of SKIP_EXTENSIONS) {
    args.push('-g', `!**/*${ext}`);
  }
  for (const pattern of (excludePatterns ?? [])) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    args.push('-g', `!${normalizeGlobForRipgrep(trimmed)}`);
  }

  try {
    const { stdout } = await execFileAsync('rg', args, { cwd: rootDir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    if (!stdout) return { totalFiles: 0, totalDirs: 0 };

    const files = stdout.split('\0').filter(Boolean);
    const dirs = new Set<string>();
    for (const file of files) {
      const dir = path.dirname(file);
      if (dir && dir !== '.') dirs.add(dir);
    }

    return { totalFiles: files.length, totalDirs: dirs.size };
  } catch {
    return null;
  }
}

/**
 * Count the number of source files in a directory (non-recursive by default).
 * For project-level file counting, skips binary/media files.
 */
export async function countFilesInDir(dir: string, recursive = true): Promise<number> {
  let count = 0;
  const extraSkip = new Set(['obj', 'bin', 'Debug', 'Release', 'TestResults']);

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const subs: Promise<void>[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!recursive) continue;
        if (SKIP_DIRS.has(e.name) || extraSkip.has(e.name)) continue;
        subs.push(walk(path.join(currentDir, e.name)));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SKIP_EXTENSIONS.has(ext)) count++;
      }
    }
    await Promise.all(subs);
  }

  await walk(dir);
  return count;
}

/**
 * Sum the byte size of all source files in a directory (recursive),
 * skipping common build/output dirs and binary/media files. Standalone
 * fallback for {@link FileCache.bytesUnder} when the cached walk is cold.
 */
export async function bytesInDir(dir: string, recursive = true): Promise<number> {
  let bytes = 0;
  const extraSkip = new Set(['obj', 'bin', 'Debug', 'Release', 'TestResults']);

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const subs: Promise<void>[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!recursive) continue;
        if (SKIP_DIRS.has(e.name) || extraSkip.has(e.name)) continue;
        subs.push(walk(path.join(currentDir, e.name)));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        try {
          const stat = await fs.stat(path.join(currentDir, e.name));
          bytes += stat.size;
        } catch {
          // ignore unreadable files
        }
      }
    }
    await Promise.all(subs);
  }

  await walk(dir);
  return bytes;
}

/** Recursively find files matching a predicate, skipping common build/output dirs */
export async function findFiles(
  rootDir: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  const results: string[] = [];
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 4;
  const maxConcurrentReads = Math.max(8, Math.min(64, cores * 4));
  const readDirSemaphore = new Semaphore(maxConcurrentReads);

  async function walk(dir: string) {
    let entries: Dirent[];
    try {
      entries = await readDirSemaphore.run(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }

    const subDirectoryWalks: Promise<void>[] = [];

    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        subDirectoryWalks.push(walk(path.join(dir, e.name)));
      } else if (e.isFile() && predicate(e.name)) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SKIP_EXTENSIONS.has(ext)) results.push(path.join(dir, e.name));
      }
    }

    await Promise.all(subDirectoryWalks);
  }

  await walk(rootDir);
  return results;
}

export async function findPackageJsonFiles(rootDir: string): Promise<string[]> {
  return findFiles(rootDir, (name) => name === 'package.json');
}

export async function findSolutionFiles(rootDir: string): Promise<string[]> {
  return findFiles(rootDir, (name) => name.endsWith('.sln'));
}

export async function findCsprojFiles(rootDir: string): Promise<string[]> {
  return findFiles(rootDir, (name) => name.endsWith('.csproj'));
}

/**
 * Strip a UTF-8 byte-order mark — editors on Windows commonly save
 * manifests with a BOM, and JSON.parse rejects it, which silently
 * dropped the project from scan results.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const txt = await fs.readFile(filePath, 'utf8');
  return JSON.parse(stripBom(txt)) as T;
}

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}
