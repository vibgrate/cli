import * as path from 'node:path';
import type {
  ProjectScan,
  DatabaseSchemaResult,
  DatabaseSchemaProjectSummary,
  DatabaseModel,
  DatabaseModelSource,
  DatabaseField,
  DatabaseEnum,
} from '../../core-open/index.js';
import { FileCache, findFiles, readTextFile } from '../../core-open/index.js';
import { parseCreateTableStatements } from './database-schema-sql.js';
import { parseDrizzleFile } from './database-schema-drizzle.js';
import { parseTypeOrmFile } from './database-schema-typeorm.js';

/**
 * Structured database-schema scanner, merging facts from five sources into
 * one `DatabaseSchemaResult`:
 *
 * 1. **Prisma** — `schema.prisma` / `*.prisma` files (a small, well-defined DSL).
 * 2. **Raw SQL migrations** — `CREATE TABLE` statements in `.sql` files.
 * 3. **SQL Server Database Projects** — `.sql` table scripts under a `.sqlproj`'s
 *    directory tree, parsed with the same SQL parser as (2).
 * 4. **Drizzle ORM** — `pgTable`/`mysqlTable`/`sqliteTable` calls.
 * 5. **TypeORM** — `@Entity()`-decorated classes.
 *
 * Every source extracts structured schema facts only — table/model/column
 * names, types, relation/key flags — never raw source lines, connection
 * strings, or attribute/annotation *values* beyond what's documented per
 * source. This intentionally never reads or stores the `url` line of a
 * Prisma `datasource` block (a credential/connection string, even when it's
 * `env("DATABASE_URL")`), and the raw-SQL sources additionally strip any line
 * that looks like a URL with embedded credentials as defense in depth. See
 * the doc comment at the top of `advanced-analysis.ts` for why the removed
 * `dataStores` scanner (which regex-scraped raw source lines) was removed and
 * why this discipline matters.
 *
 * Models are tagged with a `source` (`DatabaseModelSource`) and the file(s)
 * they came from, and are **never merged/deduped by name across sources** —
 * a `users` table found in a SQL migration and a `User` Prisma model are not
 * assumed to be the same thing just because their names are similar.
 */

const SCALAR_TYPES = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt',
]);

interface RawField {
  name: string;
  /** Raw type token as written, e.g. `Post[]`, `String?`, `User` */
  rawType: string;
  attrs: string[];
}

interface RawModel {
  name: string;
  fields: RawField[];
}

/** Find all .prisma files under rootDir (respecting the shared file cache / ignore rules). */
async function findPrismaFiles(rootDir: string, cache?: FileCache): Promise<string[]> {
  if (cache) {
    const entries = await cache.walkDir(rootDir);
    return entries.filter((e) => e.isFile && e.name.endsWith('.prisma')).map((e) => e.absPath);
  }
  return findFiles(rootDir, (name) => name.endsWith('.prisma'));
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

/** Extract top-level `keyword Name { ... }` blocks (Prisma blocks never nest braces). */
function extractBlocks(raw: string, keyword: string): Array<{ name: string; body: string }> {
  const re = new RegExp(`${keyword}\\s+(\\w+)\\s*\\{([^}]*)\\}`, 'gs');
  const blocks: Array<{ name: string; body: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    blocks.push({ name: match[1], body: match[2] });
  }
  return blocks;
}

/**
 * Datasource provider only — the `url` line (a connection string / credential,
 * even in its usual `env("DATABASE_URL")` form) is never inspected or captured.
 */
function extractDatasourceProviders(raw: string): string[] {
  const providers: string[] = [];
  for (const block of extractBlocks(raw, 'datasource')) {
    const m = block.body.match(/(?:^|\n)\s*provider\s*=\s*"([^"]+)"/);
    if (m) providers.push(m[1]);
  }
  return providers;
}

function extractModels(raw: string): RawModel[] {
  return extractBlocks(raw, 'model').map((block) => ({
    name: block.name,
    fields: parseFieldLines(block.body),
  }));
}

function extractEnums(raw: string): DatabaseEnum[] {
  return extractBlocks(raw, 'enum').map((block) => {
    const values: string[] = [];
    for (const line of block.body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
      const token = trimmed.split(/\s+/)[0];
      if (token) values.push(token);
    }
    return { name: block.name, values: [...new Set(values)].sort() };
  });
}

function parseFieldLines(body: string): RawField[] {
  const fields: RawField[] = [];
  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@') || trimmed.startsWith('/*')) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) continue;
    const [name, rawType] = tokens;
    // Field names/types in Prisma are plain identifiers; skip anything that
    // doesn't look like one (defensive against malformed/partial lines).
    if (!/^\w+$/.test(name)) continue;

    const attrs = [...trimmed.matchAll(/@(\w+)/g)].map((m) => m[1]);
    fields.push({ name, rawType, attrs });
  }
  return fields;
}

function finalizeField(field: RawField, modelNames: Set<string>): DatabaseField {
  const isList = field.rawType.includes('[]');
  const isOptional = field.rawType.includes('?');
  const baseType = field.rawType.replace(/\[\]/g, '').replace(/\?/g, '');
  const isRelation = field.attrs.includes('relation') || (!SCALAR_TYPES.has(baseType) && modelNames.has(baseType));

  return {
    name: field.name,
    type: baseType,
    isList,
    isOptional,
    isRelation,
    isId: field.attrs.includes('id'),
    isUnique: field.attrs.includes('unique'),
  };
}

function findOwningProject(fileRel: string, projects: ProjectScan[]): ProjectScan | undefined {
  let best: ProjectScan | undefined;
  let bestLen = -1;
  for (const project of projects) {
    const projPath = project.path === '.' ? '' : normalizeRel(project.path).replace(/\/$/, '');
    const matches = projPath === '' || fileRel === projPath || fileRel.startsWith(`${projPath}/`);
    if (matches && projPath.length > bestLen) {
      best = project;
      bestLen = projPath.length;
    }
  }
  return best;
}

function buildProjectBreakdown(
  projects: ProjectScan[],
  filesScanned: string[],
  modelNamesByFile: Map<string, Set<string>>,
  enumNamesByFile: Map<string, Set<string>>,
): DatabaseSchemaProjectSummary[] {
  const byProject = new Map<string, { files: Set<string>; models: Set<string>; enums: Set<string> }>();

  for (const fileRel of filesScanned) {
    const owner = findOwningProject(fileRel, projects);
    const key = owner?.path ?? '.';
    if (!byProject.has(key)) byProject.set(key, { files: new Set(), models: new Set(), enums: new Set() });
    const bucket = byProject.get(key)!;
    bucket.files.add(fileRel);
    for (const name of modelNamesByFile.get(fileRel) ?? []) bucket.models.add(name);
    for (const name of enumNamesByFile.get(fileRel) ?? []) bucket.enums.add(name);
  }

  return [...byProject.entries()]
    .map(([project, bucket]) => ({
      project,
      filesScanned: [...bucket.files].sort(),
      models: [...bucket.models].sort(),
      enums: [...bucket.enums].sort(),
    }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

interface PrismaSourceResult {
  models: DatabaseModel[];
  enums: DatabaseEnum[];
  providers: string[];
  filesScanned: string[];
  enumNamesByFile: Map<string, Set<string>>;
}

/** Scan a repository tree for Prisma schema files and extract structured facts. */
async function scanPrismaSource(rootDir: string, cache?: FileCache): Promise<PrismaSourceResult> {
  const filePaths = await findPrismaFiles(rootDir, cache);

  const providers = new Set<string>();
  const modelsByFile = new Map<string, RawModel[]>();
  const enumsByFile = new Map<string, DatabaseEnum[]>();
  const filesScanned: string[] = [];

  for (const filePath of filePaths) {
    let raw = '';
    try {
      raw = cache ? await cache.readTextFile(filePath) : await readTextFile(filePath);
    } catch {
      continue;
    }
    if (!raw.trim()) continue;

    const rel = normalizeRel(path.relative(rootDir, filePath));
    filesScanned.push(rel);

    for (const provider of extractDatasourceProviders(raw)) providers.add(provider);
    modelsByFile.set(rel, extractModels(raw));
    enumsByFile.set(rel, extractEnums(raw));
  }

  const modelNameSet = new Set<string>();
  for (const models of modelsByFile.values()) {
    for (const m of models) modelNameSet.add(m.name);
  }

  const modelMap = new Map<string, { name: string; fields: DatabaseField[]; files: Set<string> }>();
  for (const [fileRel, rawModels] of modelsByFile.entries()) {
    for (const rawModel of rawModels) {
      const fields = rawModel.fields.map((f) => finalizeField(f, modelNameSet));
      const existing = modelMap.get(rawModel.name);
      if (!existing) {
        modelMap.set(rawModel.name, { name: rawModel.name, fields, files: new Set([fileRel]) });
        continue;
      }
      existing.files.add(fileRel);
      const seen = new Set(existing.fields.map((f) => f.name));
      for (const field of fields) {
        if (!seen.has(field.name)) {
          existing.fields.push(field);
          seen.add(field.name);
        }
      }
    }
  }

  const models: DatabaseModel[] = [...modelMap.values()]
    .map((m) => ({
      name: m.name,
      fields: [...m.fields].sort((a, b) => a.name.localeCompare(b.name)),
      source: 'prisma' as const,
      files: [...m.files].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const enumMap = new Map<string, DatabaseEnum>();
  for (const enums of enumsByFile.values()) {
    for (const e of enums) {
      if (!enumMap.has(e.name)) enumMap.set(e.name, e);
    }
  }
  const enums = [...enumMap.values()]
    .map((e) => ({ name: e.name, values: [...e.values].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const enumNamesByFile = new Map<string, Set<string>>();
  for (const [fileRel, es] of enumsByFile.entries()) {
    enumNamesByFile.set(fileRel, new Set(es.map((e) => e.name)));
  }

  return { models, enums, providers: [...providers].sort(), filesScanned: filesScanned.sort(), enumNamesByFile };
}

interface SourceScanResult {
  models: DatabaseModel[];
  filesScanned: string[];
}

function isSqlFile(name: string): boolean {
  return name.endsWith('.sql');
}

async function readFileSafely(filePath: string, cache?: FileCache): Promise<string | null> {
  try {
    return cache ? await cache.readTextFile(filePath) : await readTextFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Parse `CREATE TABLE` statements out of a set of `.sql` files and turn them
 * into `DatabaseModel`s for the given source. Shared by the raw-SQL-migrations
 * source and the `.sqlproj` source. The first `CREATE TABLE` for a given
 * table name wins — across files too (files are processed in sorted, i.e.
 * deterministic, order) — matching `parseCreateTableStatements`'s
 * within-a-file behaviour.
 */
async function scanSqlSource(
  rootDir: string,
  filePaths: string[],
  source: DatabaseModelSource,
  cache?: FileCache,
): Promise<SourceScanResult> {
  const sortedPaths = [...filePaths].sort((a, b) => a.localeCompare(b));
  const seenTables = new Set<string>();
  const models: DatabaseModel[] = [];
  const filesScanned: string[] = [];

  for (const filePath of sortedPaths) {
    const raw = await readFileSafely(filePath, cache);
    if (raw == null || !raw.trim()) continue;

    const tables = parseCreateTableStatements(raw);
    if (tables.length === 0) continue;

    const rel = normalizeRel(path.relative(rootDir, filePath));
    filesScanned.push(rel);
    for (const t of tables) {
      if (seenTables.has(t.name)) continue;
      seenTables.add(t.name);
      models.push({
        name: t.name,
        fields: [...t.fields].sort((a, b) => a.name.localeCompare(b.name)),
        source,
        files: [rel],
      });
    }
  }

  return { models: models.sort((a, b) => a.name.localeCompare(b.name)), filesScanned: filesScanned.sort() };
}

async function findSqlprojFiles(rootDir: string, cache?: FileCache): Promise<string[]> {
  return cache ? cache.findFiles(rootDir, (name) => name.endsWith('.sqlproj')) : findFiles(rootDir, (name) => name.endsWith('.sqlproj'));
}

/**
 * `.sqlproj` (SQL Server Database Project) table scripts, discovered by
 * globbing for `.sql` files anywhere under a `.sqlproj`'s directory tree
 * (commonly `dbo/Tables/*.sql`, but not assumed — any layout is scanned) and
 * parsed with the same `CREATE TABLE` parser as raw SQL migrations.
 */
async function scanSqlprojSource(rootDir: string, cache?: FileCache): Promise<SourceScanResult & { sqlAbsPaths: Set<string> }> {
  const sqlprojPaths = await findSqlprojFiles(rootDir, cache);
  const sqlAbsPaths = new Set<string>();
  for (const sqlprojPath of sqlprojPaths) {
    const dir = path.dirname(sqlprojPath);
    const files = cache ? await cache.findFiles(dir, isSqlFile) : await findFiles(dir, isSqlFile);
    for (const f of files) sqlAbsPaths.add(f);
  }
  const result = await scanSqlSource(rootDir, [...sqlAbsPaths], 'sqlproj', cache);
  return { ...result, sqlAbsPaths };
}

/**
 * Raw SQL migrations — every other `.sql` file in the repo (commonly under
 * `migrations/`, `db/migrate/`, `sql/`, but scanned repo-wide), excluding any
 * already attributed to a `.sqlproj`'s table scripts so the same file is
 * never double-counted under two sources.
 */
async function scanSqlMigrationsSource(rootDir: string, excludeAbsPaths: Set<string>, cache?: FileCache): Promise<SourceScanResult> {
  const allSqlFiles = cache ? await cache.findFiles(rootDir, isSqlFile) : await findFiles(rootDir, isSqlFile);
  const migrationFiles = allSqlFiles.filter((f) => !excludeAbsPaths.has(f));
  return scanSqlSource(rootDir, migrationFiles, 'sql-migration', cache);
}

function isTsSourceFile(name: string): boolean {
  return (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts');
}

async function findTsSourceFiles(rootDir: string, cache?: FileCache): Promise<string[]> {
  return cache ? cache.findFiles(rootDir, isTsSourceFile) : findFiles(rootDir, isTsSourceFile);
}

/** Drizzle ORM table definitions (`pgTable`/`mysqlTable`/`sqliteTable`). */
async function scanDrizzleSource(rootDir: string, cache?: FileCache): Promise<SourceScanResult> {
  const filePaths = (await findTsSourceFiles(rootDir, cache)).sort((a, b) => a.localeCompare(b));
  const seenTables = new Set<string>();
  const models: DatabaseModel[] = [];
  const filesScanned: string[] = [];

  for (const filePath of filePaths) {
    const raw = await readFileSafely(filePath, cache);
    // Cheap pre-filter before parsing: a Drizzle table file must import from
    // 'drizzle-orm'.
    if (raw == null || !raw.includes('drizzle-orm')) continue;

    const tables = parseDrizzleFile(raw, filePath);
    if (tables.length === 0) continue;

    const rel = normalizeRel(path.relative(rootDir, filePath));
    filesScanned.push(rel);
    for (const t of tables) {
      if (seenTables.has(t.name)) continue;
      seenTables.add(t.name);
      models.push({
        name: t.name,
        fields: [...t.fields].sort((a, b) => a.name.localeCompare(b.name)),
        source: 'drizzle',
        files: [rel],
      });
    }
  }

  return { models: models.sort((a, b) => a.name.localeCompare(b.name)), filesScanned: filesScanned.sort() };
}

/** TypeORM `@Entity()`-decorated classes. */
async function scanTypeOrmSource(rootDir: string, cache?: FileCache): Promise<SourceScanResult> {
  const filePaths = (await findTsSourceFiles(rootDir, cache)).sort((a, b) => a.localeCompare(b));
  const seenTables = new Set<string>();
  const models: DatabaseModel[] = [];
  const filesScanned: string[] = [];

  for (const filePath of filePaths) {
    const raw = await readFileSafely(filePath, cache);
    // Cheap pre-filter before parsing: a TypeORM entity file must use @Entity.
    if (raw == null || !raw.includes('@Entity')) continue;

    const entities = parseTypeOrmFile(raw, filePath);
    if (entities.length === 0) continue;

    const rel = normalizeRel(path.relative(rootDir, filePath));
    filesScanned.push(rel);
    for (const e of entities) {
      if (seenTables.has(e.name)) continue;
      seenTables.add(e.name);
      models.push({ name: e.name, fields: e.fields, source: 'typeorm', files: [rel] });
    }
  }

  return { models: models.sort((a, b) => a.name.localeCompare(b.name)), filesScanned: filesScanned.sort() };
}

/**
 * Scan a repository tree for database schema facts across all supported
 * sources (Prisma, raw SQL migrations, `.sqlproj` table scripts, Drizzle,
 * TypeORM) and merge them into one `DatabaseSchemaResult`. Returns
 * `undefined` when nothing was found in any source (distinct from "scanned
 * and found nothing").
 */
export async function scanDatabaseSchema(
  rootDir: string,
  projects: ProjectScan[],
  cache?: FileCache,
): Promise<DatabaseSchemaResult | undefined> {
  const prisma = await scanPrismaSource(rootDir, cache);
  const sqlproj = await scanSqlprojSource(rootDir, cache);
  const sqlMigrations = await scanSqlMigrationsSource(rootDir, sqlproj.sqlAbsPaths, cache);
  const drizzle = await scanDrizzleSource(rootDir, cache);
  const typeorm = await scanTypeOrmSource(rootDir, cache);

  const models = [...prisma.models, ...sqlMigrations.models, ...sqlproj.models, ...drizzle.models, ...typeorm.models].sort(
    (a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
  );

  if (models.length === 0 && prisma.enums.length === 0) return undefined;

  const filesScanned = [
    ...new Set([...prisma.filesScanned, ...sqlMigrations.filesScanned, ...sqlproj.filesScanned, ...drizzle.filesScanned, ...typeorm.filesScanned]),
  ].sort();

  const modelNamesByFile = new Map<string, Set<string>>();
  for (const m of models) {
    for (const f of m.files) {
      if (!modelNamesByFile.has(f)) modelNamesByFile.set(f, new Set());
      modelNamesByFile.get(f)!.add(m.name);
    }
  }

  return {
    providers: prisma.providers,
    models,
    enums: prisma.enums,
    filesScanned,
    projects: buildProjectBreakdown(projects, filesScanned, modelNamesByFile, prisma.enumNamesByFile),
  };
}
