// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { PyPICache } from './pypi-cache.js';
import { latestStable, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';

/** Well-known Python frameworks / libraries to track */
const KNOWN_PYTHON_FRAMEWORKS: Record<string, string> = {
  // ── Web Frameworks ──
  'django': 'Django',
  'flask': 'Flask',
  'fastapi': 'FastAPI',
  'starlette': 'Starlette',
  'tornado': 'Tornado',
  'bottle': 'Bottle',
  'sanic': 'Sanic',
  'falcon': 'Falcon',
  'aiohttp': 'aiohttp',
  'quart': 'Quart',
  'litestar': 'Litestar',
  'robyn': 'Robyn',

  // ── ORM & Database ──
  'sqlalchemy': 'SQLAlchemy',
  'django-rest-framework': 'DRF',
  'djangorestframework': 'DRF',
  'peewee': 'Peewee',
  'tortoise-orm': 'Tortoise ORM',
  'sqlmodel': 'SQLModel',
  'pony': 'Pony ORM',
  'alembic': 'Alembic',
  'psycopg2': 'psycopg2',
  'psycopg2-binary': 'psycopg2',
  'psycopg': 'psycopg3',
  'asyncpg': 'asyncpg',
  'pymongo': 'PyMongo',
  'motor': 'Motor',
  'redis': 'redis-py',
  'celery': 'Celery',
  'boto3': 'AWS SDK (boto3)',
  'botocore': 'AWS SDK (botocore)',

  // ── Data Science & ML ──
  'numpy': 'NumPy',
  'pandas': 'pandas',
  'scipy': 'SciPy',
  'scikit-learn': 'scikit-learn',
  'tensorflow': 'TensorFlow',
  'torch': 'PyTorch',
  'keras': 'Keras',
  'matplotlib': 'Matplotlib',
  'seaborn': 'Seaborn',
  'plotly': 'Plotly',
  'polars': 'Polars',
  'dask': 'Dask',
  'xgboost': 'XGBoost',
  'lightgbm': 'LightGBM',
  'transformers': 'Transformers (HF)',
  'langchain': 'LangChain',
  'openai': 'OpenAI SDK',

  // ── Testing ──
  'pytest': 'pytest',
  'unittest2': 'unittest2',
  'nose2': 'nose2',
  'tox': 'tox',
  'hypothesis': 'Hypothesis',
  'factory-boy': 'factory_boy',
  'faker': 'Faker',
  'coverage': 'Coverage.py',
  'responses': 'responses',
  'httpx': 'HTTPX',

  // ── Async & Tasks ──
  'uvicorn': 'Uvicorn',
  'gunicorn': 'Gunicorn',
  'hypercorn': 'Hypercorn',
  'dramatiq': 'Dramatiq',
  'rq': 'RQ',
  'huey': 'Huey',

  // ── Auth & Security ──
  'pyjwt': 'PyJWT',
  'authlib': 'Authlib',
  'python-jose': 'python-jose',
  'passlib': 'Passlib',
  'cryptography': 'cryptography',

  // ── Serialization & Validation ──
  'pydantic': 'Pydantic',
  'marshmallow': 'Marshmallow',
  'attrs': 'attrs',
  'cerberus': 'Cerberus',
  'msgpack': 'msgpack',
  'protobuf': 'protobuf',

  // ── HTTP Clients ──
  'requests': 'Requests',
  'urllib3': 'urllib3',

  // ── DevOps & Infrastructure ──
  'ansible': 'Ansible',
  'fabric': 'Fabric',
  'invoke': 'Invoke',
  'paramiko': 'Paramiko',

  // ── Linting & Formatting ──
  'black': 'Black',
  'ruff': 'Ruff',
  'flake8': 'Flake8',
  'mypy': 'mypy',
  'pylint': 'Pylint',
  'isort': 'isort',
  'bandit': 'Bandit',

  // ── Logging & Observability ──
  'structlog': 'structlog',
  'loguru': 'Loguru',
  'sentry-sdk': 'Sentry SDK',
  'opentelemetry-api': 'OpenTelemetry',
  'prometheus-client': 'prometheus-client',
};

// Latest Python major.minor is resolved at scan time — see runtime-baselines.ts

interface PythonDependency {
  name: string;
  spec: string;
  /** Normalised name for PyPI lookup (lowercase, hyphens) */
  normalisedName: string;
}

/**
 * Parse a PEP 508 requirement line:
 *   package==1.0.0
 *   package>=1.0,<2.0
 *   package~=1.0
 *   package[extras]==1.0
 *   package ; python_version >= "3.8"
 */
function parseRequirementLine(line: string): PythonDependency | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) return null;

  // Strip environment markers (after ;)
  const withoutMarkers = trimmed.split(';')[0]!.trim();

  // Match package name (possibly with extras), then version spec
  const match = withoutMarkers.match(/^([A-Za-z0-9][-A-Za-z0-9_.]*[A-Za-z0-9]?)(?:\[.*?\])?\s*(.*)?$/);
  if (!match) return null;

  const rawName = match[1]!;
  const spec = (match[2] ?? '').trim();

  // Normalise: PEP 503 — lowercase, replace underscores/dots with hyphens
  const normalisedName = rawName.toLowerCase().replace(/[_.]+/g, '-');

  return { name: rawName, spec, normalisedName };
}

/**
 * Extract a pinned version from a PEP 508 spec.
 * Returns the version if pinned (==), or null otherwise.
 */
function extractPinnedVersion(spec: string): string | null {
  const match = spec.match(/^==\s*([^\s,;]+)/);
  return match?.[1] ?? null;
}

/**
 * Convert a PEP 440 version to semver where possible (best-effort).
 */
function pep440ToSemver(ver: string): string | null {
  let v = ver.replace(/^[vV]/, '').trim();
  if (/(?:a\d|b\d|rc\d|alpha|beta|dev|post)/i.test(v)) return null;
  const parts = v.split('.');
  while (parts.length < 3) parts.push('0');
  v = parts.slice(0, 3).join('.');
  return semver.valid(v);
}

// ── File parsers ──

function parseRequirementsTxt(content: string): PythonDependency[] {
  const deps: PythonDependency[] = [];
  for (const line of content.split('\n')) {
    const dep = parseRequirementLine(line);
    if (dep) deps.push(dep);
  }
  return deps;
}

interface PyProjectToml {
  pythonVersion?: string;
  dependencies: PythonDependency[];
  projectName?: string;
}

/**
 * Very lightweight TOML parser — handles the subset we care about:
 * [project] name, requires-python, dependencies array,
 * [tool.poetry.dependencies] table.
 *
 * We don't pull in a full TOML parser to keep deps minimal.
 */
function parsePyprojectToml(content: string): PyProjectToml {
  const result: PyProjectToml = { dependencies: [] };

  // Extract project name
  const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (nameMatch) result.projectName = nameMatch[1];

  // Extract requires-python
  const pyVerMatch = content.match(/^\s*requires-python\s*=\s*"([^"]+)"/m);
  if (pyVerMatch) result.pythonVersion = pyVerMatch[1];

  // Parse [project] dependencies = [...]
  const depsBlockMatch = content.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (depsBlockMatch) {
    const block = depsBlockMatch[1]!;
    // Each line is a quoted string
    const lineRegex = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = lineRegex.exec(block)) !== null) {
      const dep = parseRequirementLine(m[1]!);
      if (dep) result.dependencies.push(dep);
    }
  }

  // Parse [tool.poetry.dependencies] section
  const poetrySection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\s*\[|\n*$)/);
  if (poetrySection) {
    const lines = poetrySection[1]!.split('\n');
    for (const line of lines) {
      const kv = line.match(/^\s*([A-Za-z0-9][-A-Za-z0-9_.]*)\s*=\s*(?:"([^"]+)"|{.*?version\s*=\s*"([^"]+)".*?})/);
      if (kv) {
        const name = kv[1]!;
        if (name.toLowerCase() === 'python') {
          result.pythonVersion = kv[2] ?? kv[3] ?? undefined;
          continue;
        }
        const ver = kv[2] ?? kv[3] ?? '';
        const normalisedName = name.toLowerCase().replace(/[_.]+/g, '-');
        result.dependencies.push({ name, spec: ver ? `==${ver}` : '', normalisedName });
      }
    }
  }

  return result;
}

function parsePipfile(content: string): PythonDependency[] {
  const deps: PythonDependency[] = [];
  // Find [packages] section
  const packagesMatch = content.match(/\[packages\]([\s\S]*?)(?=\n\s*\[|\n*$)/);
  if (packagesMatch) {
    const lines = packagesMatch[1]!.split('\n');
    for (const line of lines) {
      const kv = line.match(/^\s*([A-Za-z0-9][-A-Za-z0-9_.]*)\s*=\s*(?:"([^"]+)"|{.*?version\s*=\s*"([^"]+)".*?}|\*|"[*]")/);
      if (kv) {
        const name = kv[1]!;
        const ver = kv[2] ?? kv[3] ?? '';
        const normalisedName = name.toLowerCase().replace(/[_.]+/g, '-');
        deps.push({ name, spec: ver || '*', normalisedName });
      }
    }
  }

  // Find [dev-packages] section
  const devMatch = content.match(/\[dev-packages\]([\s\S]*?)(?=\n\s*\[|\n*$)/);
  if (devMatch) {
    const lines = devMatch[1]!.split('\n');
    for (const line of lines) {
      const kv = line.match(/^\s*([A-Za-z0-9][-A-Za-z0-9_.]*)\s*=\s*(?:"([^"]+)"|{.*?version\s*=\s*"([^"]+)".*?}|\*|"[*]")/);
      if (kv) {
        const name = kv[1]!;
        const ver = kv[2] ?? kv[3] ?? '';
        const normalisedName = name.toLowerCase().replace(/[_.]+/g, '-');
        deps.push({ name, spec: ver || '*', normalisedName });
      }
    }
  }

  return deps;
}

function parseSetupCfg(content: string): { deps: PythonDependency[]; pythonVersion?: string; name?: string } {
  const result: { deps: PythonDependency[]; pythonVersion?: string; name?: string } = { deps: [] };

  // Extract name from [metadata] section
  const metadataSection = content.match(/\[metadata\]([\s\S]*?)(?=\n\s*\[|\n*$)/);
  if (metadataSection) {
    const nameMatch = metadataSection[1]!.match(/^\s*name\s*=\s*(.+)$/m);
    if (nameMatch) result.name = nameMatch[1]!.trim();
  }

  // Extract python_requires from [options] section
  const optionsSection = content.match(/\[options\]([\s\S]*?)(?=\n\s*\[|\n*$)/);
  if (optionsSection) {
    const pyReqMatch = optionsSection[1]!.match(/^\s*python_requires\s*=\s*(.+)$/m);
    if (pyReqMatch) result.pythonVersion = pyReqMatch[1]!.trim();

    // Parse install_requires — multiline continuation with indented lines
    const installReqMatch = optionsSection[1]!.match(/install_requires\s*=\s*\n((?:\s+.*\n?)*)/);
    if (installReqMatch) {
      const block = installReqMatch[1]!;
      for (const line of block.split('\n')) {
        const dep = parseRequirementLine(line);
        if (dep) result.deps.push(dep);
      }
    }
  }

  return result;
}

// ── Python project file names ──

const PYTHON_MANIFEST_FILES = new Set([
  'requirements.txt',
  'requirements-dev.txt',
  'requirements_dev.txt',
  'requirements-test.txt',
  'dev-requirements.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
]);

/**
 * Discover and scan all Python projects in the workspace.
 */
export async function scanPythonProjects(
  rootDir: string,
  pypiCache: PyPICache,
  cache?: FileCache,
  projectScanTimeout?: number,
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
): Promise<ProjectScan[]> {
  // Find Python manifest files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => PYTHON_MANIFEST_FILES.has(name) || /^requirements.*\.txt$/.test(name))
    : await findPythonManifests(rootDir);

  // Group manifests by directory to form "projects"
  const projectDirs = new Map<string, string[]>();
  for (const f of manifestFiles) {
    const dir = path.dirname(f);
    if (!projectDirs.has(dir)) projectDirs.set(dir, []);
    projectDirs.get(dir)!.push(f);
  }

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const [dir, files] of projectDirs) {
    try {
      const scanPromise = scanOnePythonProject(dir, files, rootDir, pypiCache, cache, catalog);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Python project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Python project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findPythonManifests(rootDir: string): Promise<string[]> {
  // Import findFiles dynamically to avoid circular deps
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => PYTHON_MANIFEST_FILES.has(name) || /^requirements.*\.txt$/.test(name));
}

async function scanOnePythonProject(
  dir: string,
  manifestFiles: string[],
  rootDir: string,
  pypiCache: PyPICache,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  let projectName = path.basename(dir === rootDir ? rootDir : dir);
  let pythonVersion: string | undefined;
  const allDeps = new Map<string, PythonDependency>();

  // Parse each manifest file, preferring pyproject.toml > setup.cfg > requirements.txt
  for (const f of manifestFiles) {
    const fileName = path.basename(f);
    const content = cache ? await cache.readTextFile(f) : await readTextFile(f);

    if (fileName === 'pyproject.toml') {
      const parsed = parsePyprojectToml(content);
      if (parsed.projectName) projectName = parsed.projectName;
      if (parsed.pythonVersion) pythonVersion = parsed.pythonVersion;
      for (const dep of parsed.dependencies) {
        if (!allDeps.has(dep.normalisedName)) allDeps.set(dep.normalisedName, dep);
      }
    } else if (fileName === 'setup.cfg') {
      const parsed = parseSetupCfg(content);
      if (parsed.name) projectName = parsed.name;
      if (parsed.pythonVersion && !pythonVersion) pythonVersion = parsed.pythonVersion;
      for (const dep of parsed.deps) {
        if (!allDeps.has(dep.normalisedName)) allDeps.set(dep.normalisedName, dep);
      }
    } else if (fileName === 'Pipfile') {
      for (const dep of parsePipfile(content)) {
        if (!allDeps.has(dep.normalisedName)) allDeps.set(dep.normalisedName, dep);
      }
    } else if (fileName.startsWith('requirements') && fileName.endsWith('.txt')) {
      for (const dep of parseRequirementsTxt(content)) {
        if (!allDeps.has(dep.normalisedName)) allDeps.set(dep.normalisedName, dep);
      }
    }
  }

  // Determine Python runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;
  let runtimeEol: boolean | null | undefined;
  let runtimeEolDate: string | undefined;

  if (pythonVersion) {
    // Extract minimum required version from specifier (e.g. ">=3.9" → 3.9)
    const verMatch = pythonVersion.match(/(\d+)\.(\d+)/);
    if (verMatch) {
      const reqMajor = parseInt(verMatch[1]!, 10);
      const reqMinor = parseInt(verMatch[2]!, 10);
      const LATEST_PYTHON_MINOR = latestStable(catalog, 'python');
      if (LATEST_PYTHON_MINOR) {
        if (reqMajor === LATEST_PYTHON_MINOR.major) {
          runtimeMajorsBehind = Math.max(0, LATEST_PYTHON_MINOR.minor - reqMinor);
        } else if (reqMajor < LATEST_PYTHON_MINOR.major) {
          // Python 2 is very behind
          runtimeMajorsBehind = LATEST_PYTHON_MINOR.minor + (LATEST_PYTHON_MINOR.major - reqMajor) * 10;
        }
        runtimeLatest = `${LATEST_PYTHON_MINOR.major}.${LATEST_PYTHON_MINOR.minor}`;
      }
    }
    runtimeEol = runtimeEolStatus(catalog, 'python', pythonVersion);
    const cycle = extractCycle('python', pythonVersion);
    if (cycle) runtimeEolDate = eolDate(catalog, 'python', cycle);
  }

  // Resolve dependencies against PyPI
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const depEntries = [...allDeps.values()];
  const metaPromises = depEntries.map(async (dep) => {
    const meta = await pypiCache.get(dep.normalisedName);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    const pinnedVersion = extractPinnedVersion(dep.spec);
    const resolvedVersion = pinnedVersion ? pep440ToSemver(pinnedVersion) : null;
    const latestStable = meta.latestStableOverall;

    let majorsBehind: number | null = null;
    let drift: DependencyRow['drift'] = 'unknown';

    if (resolvedVersion && latestStable) {
      const currentMajor = semver.major(resolvedVersion);
      const latestMajor = semver.major(latestStable);
      majorsBehind = latestMajor - currentMajor;

      if (majorsBehind === 0) {
        drift = semver.eq(resolvedVersion, latestStable) ? 'current' : 'minor-behind';
      } else if (majorsBehind > 0) {
        drift = 'major-behind';
      } else {
        drift = 'current'; // somehow ahead
      }

      if (majorsBehind <= 0) buckets.current++;
      else if (majorsBehind === 1) buckets.oneBehind++;
      else buckets.twoPlusBehind++;
    } else {
      buckets.unknown++;
    }

    dependencies.push({
      package: dep.name,
      section: 'dependencies',
      currentSpec: dep.spec || '*',
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Detect known frameworks
    if (dep.normalisedName in KNOWN_PYTHON_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_PYTHON_FRAMEWORKS[dep.normalisedName]!,
        currentVersion: resolvedVersion,
        latestVersion: latestStable,
        majorsBehind,
      });
    }
  }

  // Sort: worst drift first
  dependencies.sort((a, b) => {
    const order = { 'major-behind': 0, 'minor-behind': 1, 'current': 2, 'unknown': 3 };
    const diff = (order[a.drift] ?? 9) - (order[b.drift] ?? 9);
    if (diff !== 0) return diff;
    return a.package.localeCompare(b.package);
  });

  // Count files (use cached walk to avoid redundant I/O)
  let fileCount: number | undefined;
  try {
    fileCount = cache
      ? await cache.countFilesUnder(rootDir, dir)
      : undefined;
  } catch { /* ignore */ }

  return {
    type: 'python',
    path: relDir,
    name: projectName,
    runtime: pythonVersion,
    runtimeLatest,
    runtimeMajorsBehind,
    runtimeEol,
    runtimeEolDate,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
