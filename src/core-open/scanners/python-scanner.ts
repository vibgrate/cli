// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, readJsonFile, pathExists, FileCache } from '../utils/fs.js';
import { recordedSemver, splitBuildMetadata } from '../utils/recorded-semver.js';
import { rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import { loadPythonLockIndex, type PythonLockIndex } from './python-lockfile.js';
import type { LockfileIo } from './npm-lockfile.js';
import { withTimeout } from '../utils/timeout.js';
import { PyPICache } from './pypi-cache.js';
import { latestStable, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework, DepSection } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

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
  /**
   * Manifest section. Omitted means `dependencies`.
   * PEP 621 extras and a Poetry inline table with `optional = true`
   * both set `optionalDependencies` on this field.
   * PEP 735 dependency groups, Poetry dependency groups, the legacy
   * Poetry dev-dependencies table, Pipfile `[dev-packages]`, and a
   * dev or test requirements filename set `devDependencies`.
   */
  section?: DepSection;
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
  const stripped = ver.replace(/^[vV]/, '').trim();
  // A `+local` suffix is build metadata, not a PEP 440 pre-release. Test the
  // numeric core only, or `+post.1` / `+build.7` is rejected or truncated.
  const { core, build } = splitBuildMetadata(stripped);
  if (/(?:a\d|b\d|rc\d|alpha|beta|dev|post)/i.test(core)) return null;
  const parts = core.split('.');
  while (parts.length < 3) parts.push('0');
  const v = parts.slice(0, 3).join('.');
  return recordedSemver(build ? `${v}${build}` : v);
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

/**
 * Requirements filenames that are development dependencies.
 * `dev-requirements.txt` is included so a row is classified once that
 * file is parsed. Other names, including `requirements.txt`, stay
 * production (section omitted).
 */
const DEV_REQUIREMENTS_FILES = new Set([
  'requirements-dev.txt',
  'requirements_dev.txt',
  'requirements-test.txt',
  'dev-requirements.txt',
]);

export function requirementsSection(fileName: string): DepSection | undefined {
  return DEV_REQUIREMENTS_FILES.has(fileName) ? 'devDependencies' : undefined;
}

interface PyProjectToml {
  pythonVersion?: string;
  dependencies: PythonDependency[];
  projectName?: string;
}

function declaredSection(dep: PythonDependency): DepSection {
  return dep.section ?? 'dependencies';
}

/**
 * One row per normalised name.
 * `optionalDependencies` wins over a production listing. `devDependencies`
 * wins only when the name is not also in `dependencies` (including a
 * dev-only optional name). A name in a dependency group and an optional
 * extra, with no production row, is stored as `devDependencies`. A name
 * that also has a production row (`[project] dependencies` or a required
 * `[tool.poetry.dependencies]` entry) is stored as `dependencies`. When
 * that name is in all three sections, `optionalDependencies` wins, the
 * same way an extra that repeats a production requirement does.
 * Two optional rows keep the code-unit-smaller spec, then the smaller raw
 * name, so extra order does not matter. Two rows in any other winning
 * section keep the first one parsed.
 */
function pickPythonDep(rows: PythonDependency[]): PythonDependency {
  if (rows.length === 1) return rows[0]!;
  const sections = new Set(rows.map(declaredSection));
  let winning: DepSection = 'dependencies';
  if (sections.has('devDependencies') && !sections.has('dependencies')) winning = 'devDependencies';
  else if (sections.has('optionalDependencies')) winning = 'optionalDependencies';

  const candidates = rows.filter((row) => declaredSection(row) === winning);
  if (candidates.length === 0) return rows[0]!;
  if (winning !== 'optionalDependencies') return candidates[0]!;
  return candidates.slice().sort((a, b) => {
    const bySpec = compareCodeUnits(a.spec, b.spec);
    if (bySpec !== 0) return bySpec;
    return compareCodeUnits(a.name, b.name);
  })[0]!;
}

function collapsePythonDeps(rows: PythonDependency[]): PythonDependency[] {
  const groups = new Map<string, PythonDependency[]>();
  const order: string[] = [];
  for (const row of rows) {
    const list = groups.get(row.normalisedName);
    if (list) list.push(row);
    else {
      groups.set(row.normalisedName, [row]);
      order.push(row.normalisedName);
    }
  }
  return order.map((key) => pickPythonDep(groups.get(key)!));
}

/** Body of a TOML table, up to the next header. The header line itself is excluded. */
function tomlTableBody(content: string, header: string): string | null {
  const escaped = header.replace(/\./g, '\\.');
  const re = new RegExp(`^[ \\t]*\\[\\s*${escaped}\\s*\\][^\\n]*(?:\\n|$)`, 'm');
  const match = re.exec(content);
  if (!match) return null;
  const after = content.slice(match.index + match[0].length);
  const next = after.search(/\n[ \t]*\[/);
  return next === -1 ? after : after.slice(0, next);
}

function skipTomlString(text: string, start: number): number {
  const quote = text[start]!;
  if (text.startsWith(quote + quote + quote, start)) {
    const end = text.indexOf(quote + quote + quote, start + 3);
    return end === -1 ? text.length : end + 3;
  }
  let i = start + 1;
  while (i < text.length) {
    if (quote === '"' && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    if (text[i] === '\n') return i;
    i++;
  }
  return text.length;
}

/** Index of the `]` that closes an array starting at `start` (the first character inside the array). */
function indexOfClosingBracket(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipTomlString(text, i);
      continue;
    }
    if (ch === ']') return i;
    i++;
  }
  return -1;
}

/** Index just past the `}` that closes an inline table whose `{` is at `start`. */
function skipTomlInlineTable(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipTomlString(text, i);
      continue;
    }
    if (ch === '{') {
      i = skipTomlInlineTable(text, i);
      continue;
    }
    if (ch === '}') return i + 1;
    i++;
  }
  return text.length;
}

function collectQuotedStrings(body: string, out: string[], skipInlineTables = false): void {
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '#') {
      const nl = body.indexOf('\n', i);
      i = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (skipInlineTables && ch === '{') {
      i = skipTomlInlineTable(body, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (body.startsWith(ch + ch + ch, i)) {
        const end = body.indexOf(ch + ch + ch, i + 3);
        if (end === -1) return;
        out.push(body.slice(i + 3, end));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < body.length) {
        if (ch === '"' && body[j] === '\\') {
          const escaped = body[j + 1];
          if (escaped === undefined) break;
          value += escaped;
          j += 2;
          continue;
        }
        if (body[j] === ch || body[j] === '\n') break;
        value += body[j];
        j++;
      }
      out.push(value);
      i = body[j] === ch ? j + 1 : j;
      continue;
    }
    i++;
  }
}

/**
 * Requirement strings from every array in a TOML table body.
 * A `]` inside a quoted requirement (an extra marker) does not end the array.
 * Comments are skipped. When `skipInlineTables` is set, a `{...}` entry is
 * not a requirement: PEP 735 `{include-group = "..."}` is skipped and is not
 * expanded. The quoted group name inside that table is not a package name.
 * Packages written in the included group's own array are still collected
 * when that array is walked.
 */
function requirementStringsFromTomlArrays(section: string, skipInlineTables = false): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < section.length) {
    const ch = section[i]!;
    if (ch === '#') {
      const nl = section.indexOf('\n', i);
      i = nl === -1 ? section.length : nl + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipTomlString(section, i);
      continue;
    }
    if (ch === '[') {
      const end = indexOfClosingBracket(section, i + 1);
      if (end === -1) break;
      collectQuotedStrings(section.slice(i + 1, end), out, skipInlineTables);
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * True when a Poetry inline table sets `optional = true`.
 * `optional = false` and a quoted version spec stay required.
 */
function poetryInlineOptional(line: string): boolean {
  const table = /\{([^}]*)\}/.exec(line);
  if (!table?.[1]) return false;
  return /(?:^|[,{\s])optional\s*=\s*true\b/.test(table[1]);
}

/** Bodies of every TOML table whose header matches `header` (the inside of `[...]`). */
function tomlBodiesForHeader(content: string, header: string): string[] {
  const re = new RegExp(`^[ \\t]*\\[\\s*${header}\\s*\\]`, 'gm');
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const headerEnd = match.index + match[0].length;
    const nl = content.indexOf('\n', headerEnd);
    if (nl === -1) {
      bodies.push('');
      continue;
    }
    const rest = content.slice(nl + 1);
    const next = rest.search(/^[ \t]*\[/m);
    bodies.push(next === -1 ? rest : rest.slice(0, next));
  }
  return bodies;
}

/**
 * Poetry `name = "version"` and `name = { version = "..." }` rows.
 * The `python` key is never a package. On the main dependencies table it
 * records the project Python version. On a dev table it is ignored, so a
 * group constraint does not replace `requires-python` or the main table.
 * `optional = true` is read only on the main table. A dev table stores
 * every other row as `devDependencies`, including an inline `optional = true`.
 */
function appendPoetryDependencyTable(
  body: string,
  rows: PythonDependency[],
  result: PyProjectToml,
  dev: boolean,
): void {
  for (const line of body.split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9][-A-Za-z0-9_.]*)\s*=\s*(?:"([^"]+)"|{.*?version\s*=\s*"([^"]+)".*?})/);
    if (!kv) continue;
    const name = kv[1]!;
    if (name.toLowerCase() === 'python') {
      if (!dev) result.pythonVersion = kv[2] ?? kv[3] ?? undefined;
      continue;
    }
    const ver = kv[2] ?? kv[3] ?? '';
    const normalisedName = name.toLowerCase().replace(/[_.]+/g, '-');
    const spec = ver ? `==${ver}` : '';
    // Quoted specs stay required. `optional = true` is read only from an
    // inline table on `[tool.poetry.dependencies]`
    // (`psycopg = { version = "^3.1", optional = true }`).
    const optional = !dev && kv[3] !== undefined && poetryInlineOptional(line);
    rows.push({
      name,
      spec,
      normalisedName,
      ...(dev ? { section: 'devDependencies' as const } : {}),
      ...(optional ? { section: 'optionalDependencies' as const } : {}),
    });
  }
}

/**
 * Very lightweight TOML parser — handles the subset we care about:
 * [project] name, requires-python, dependencies array,
 * [project.optional-dependencies] extra arrays,
 * [dependency-groups] requirement arrays (PEP 735),
 * [tool.poetry.dependencies],
 * [tool.poetry.group.<name>.dependencies],
 * and the legacy [tool.poetry.dev-dependencies] table.
 *
 * `{include-group = "..."}` is skipped, not expanded. A `python` key is not
 * a package. We don't pull in a full TOML parser to keep deps minimal.
 */
function parsePyprojectToml(content: string): PyProjectToml {
  const result: PyProjectToml = { dependencies: [] };
  const rows: PythonDependency[] = [];

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
      if (dep) rows.push(dep);
    }
  }

  // Parse [tool.poetry.dependencies]. The header is not a suffix of
  // [tool.poetry.group.<name>.dependencies] (`tool.poetry.dependencies`
  // does not occur in `tool.poetry.group.`).
  const poetrySection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\s*\[|\n*$)/);
  if (poetrySection) appendPoetryDependencyTable(poetrySection[1]!, rows, result, false);

  // PEP 621 extras. Every extra is optional, including one named `dev`.
  const optionalSection = tomlTableBody(content, 'project.optional-dependencies');
  if (optionalSection) {
    for (const requirement of requirementStringsFromTomlArrays(optionalSection)) {
      const dep = parseRequirementLine(requirement);
      if (dep) rows.push({ ...dep, section: 'optionalDependencies' });
    }
  }

  // PEP 735. `{include-group = "..."}` is skipped; the included group's
  // own requirement strings are read when that group is declared here.
  const groupSection = tomlTableBody(content, 'dependency-groups');
  if (groupSection) {
    for (const requirement of requirementStringsFromTomlArrays(groupSection, true)) {
      const dep = parseRequirementLine(requirement);
      if (dep) rows.push({ ...dep, section: 'devDependencies' });
    }
  }

  // Poetry groups, then the legacy dev-dependencies table. Same simple
  // `name = "version"` / `{ version = "..." }` forms as the main table.
  const poetryGroupHeader =
    'tool\\.poetry\\.group\\.(?:"[^"\\n]+"|\'[^\'\\n]+\'|[A-Za-z0-9_-]+)\\.dependencies';
  for (const body of tomlBodiesForHeader(content, poetryGroupHeader)) {
    appendPoetryDependencyTable(body, rows, result, true);
  }
  for (const body of tomlBodiesForHeader(content, 'tool\\.poetry\\.dev-dependencies')) {
    appendPoetryDependencyTable(body, rows, result, true);
  }

  result.dependencies = collapsePythonDeps(rows);
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
        deps.push({ name, spec: ver || '*', normalisedName, section: 'devDependencies' });
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
      rethrowLockfileParseError(e);
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
  const parsedRows: PythonDependency[] = [];

  // Parse every manifest, then keep one row per name. `pickPythonDep`
  // chooses the section, so a production listing beats a dev listing
  // whichever file is read first.
  for (const f of manifestFiles) {
    const fileName = path.basename(f);
    const content = cache ? await cache.readTextFile(f) : await readTextFile(f);

    if (fileName === 'pyproject.toml') {
      const parsed = parsePyprojectToml(content);
      if (parsed.projectName) projectName = parsed.projectName;
      if (parsed.pythonVersion) pythonVersion = parsed.pythonVersion;
      parsedRows.push(...parsed.dependencies);
    } else if (fileName === 'setup.cfg') {
      const parsed = parseSetupCfg(content);
      if (parsed.name) projectName = parsed.name;
      if (parsed.pythonVersion && !pythonVersion) pythonVersion = parsed.pythonVersion;
      parsedRows.push(...parsed.deps);
    } else if (fileName === 'Pipfile') {
      parsedRows.push(...parsePipfile(content));
    } else if (fileName.startsWith('requirements') && fileName.endsWith('.txt')) {
      const section = requirementsSection(fileName);
      for (const dep of parseRequirementsTxt(content)) {
        parsedRows.push(section === undefined ? dep : { ...dep, section });
      }
    }
  }

  for (const dep of collapsePythonDeps(parsedRows)) {
    allDeps.set(dep.normalisedName, dep);
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

  // A lockfile (poetry.lock / uv.lock / pdm.lock / Pipfile.lock) pins the exact resolved version of
  // every dependency — the only source of a resolved version when the manifest declares a range
  // rather than `==`. It sits beside the manifest, so load it from this project's directory.
  const lockIo: LockfileIo = {
    exists: (p) => (cache ? cache.pathExists(p) : pathExists(p)),
    readText: (p) => (cache ? cache.readTextFile(p) : readTextFile(p)),
    readJson: <T>(p: string) => (cache ? cache.readJsonFile<T>(p) : readJsonFile<T>(p)),
  };
  const lockIndex: PythonLockIndex | null = await loadPythonLockIndex(dir, lockIo).catch((err: unknown) => {
    rethrowLockfileParseError(err);
    return null;
  });

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
    // Prefer the lockfile's exact version; otherwise fall back to a `==`-pinned spec.
    const locked = lockIndex?.resolve(dep.normalisedName) ?? null;
    const pinnedVersion = locked ?? extractPinnedVersion(dep.spec);
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
      section: dep.section ?? 'dependencies',
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
    return compareCodeUnits(a.package, b.package);
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
