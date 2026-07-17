import type { DatabaseField } from '../../core-open/index.js';

/**
 * Best-effort structural parser for `CREATE TABLE <name> (...)` statements in
 * raw SQL text. Shared by the raw-SQL-migrations source and the SQL Server
 * Database Project (`.sqlproj`) source in `database-schema.ts` — both hand it
 * whole-file text and get back structured table facts only: table name,
 * column name + a best-effort type string, and PRIMARY KEY/NOT NULL/
 * UNIQUE/REFERENCES flags detected via keyword matching.
 *
 * This is deliberately not a full SQL parser. `ALTER TABLE` statements are
 * never parsed (the first `CREATE TABLE` per table name wins), and any
 * top-level item inside the parens that isn't cleanly a `<name> <type> ...`
 * column definition (composite `PRIMARY KEY (...)`, `FOREIGN KEY (...)`,
 * `CONSTRAINT ...`, `CHECK (...)`, table-level `UNIQUE (...)`/`INDEX (...)`)
 * is skipped rather than guessed at.
 *
 * Defense in depth: even though hand-written SQL files don't normally embed
 * credentials, any line that looks like a URL with embedded credentials
 * (`scheme://user:pass@host`) is stripped before parsing, so one can never
 * propagate into the result — see the doc comment at the top of
 * `advanced-analysis.ts` for why that discipline matters here.
 */

export interface ParsedSqlTable {
  name: string;
  fields: DatabaseField[];
}

/** Matches `scheme://user:pass@host` — a URL with embedded credentials. */
const CREDENTIAL_URL_RE = /:\/\/[^/\s'"]*:[^/\s'"]*@/;

export function stripCredentialLines(sql: string): string {
  return sql
    .split('\n')
    .map((line) => (CREDENTIAL_URL_RE.test(line) ? '' : line))
    .join('\n');
}

/** Table-level constraint keywords — a top-level item starting with one of
 * these is a constraint clause, not a column definition. */
const TABLE_LEVEL_KEYWORDS = new Set(['PRIMARY', 'FOREIGN', 'CONSTRAINT', 'UNIQUE', 'CHECK', 'INDEX', 'KEY']);

/** Keywords that end the "type" portion of a column definition and begin its
 * constraint/modifier clauses. */
const CONSTRAINT_KEYWORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT',
  'GENERATED', 'IDENTITY', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COLLATE', 'ON', 'COMMENT',
  'ENCODE', 'DISTKEY', 'SORTKEY', 'WITH',
]);

/** Strip surrounding quoting (`` ` ``/`"`/`[]`) and a schema qualifier
 * (`dbo.Users` → `Users`) from a raw SQL identifier. */
function cleanIdentifier(raw: string): string {
  const parts = raw.split('.');
  const last = (parts[parts.length - 1] ?? raw).trim();
  return last.replace(/^[["'`]+/, '').replace(/[\]"'`;]+$/, '').trim();
}

/** Extract the text between a `(` at `openParenIdx` and its matching `)`,
 * respecting nesting (e.g. `DECIMAL(10, 2)`). Returns `null` if unbalanced. */
function extractBalanced(sql: string, openParenIdx: number): string | null {
  let depth = 0;
  for (let i = openParenIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

/** Split a column-list body on top-level commas only (commas nested inside
 * `(...)`, e.g. `DECIMAL(10, 2)`, are not split points). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a single column definition, treating a `word(...)` group (e.g.
 * `DECIMAL(10, 2)`, `VARCHAR(255)`) as one token even though it contains
 * whitespace/commas internally. */
function tokenize(def: string): string[] {
  const tokens: string[] = [];
  const re = /[^\s(]+\([^)]*\)|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(def)) !== null) tokens.push(m[0]);
  return tokens;
}

function containsSeq(tokens: string[], seq: string[]): boolean {
  for (let i = 0; i + seq.length <= tokens.length; i++) {
    if (seq.every((s, j) => tokens[i + j] === s)) return true;
  }
  return false;
}

function parseColumnDef(def: string): DatabaseField | null {
  const tokens = tokenize(def);
  if (tokens.length < 2) return null;
  const first = tokens[0]!.toUpperCase();
  if (TABLE_LEVEL_KEYWORDS.has(first)) return null; // table-level constraint, not a column

  const name = cleanIdentifier(tokens[0]!);
  if (!name) return null;

  const rest = tokens.slice(1);
  const typeTokens: string[] = [];
  for (const t of rest) {
    if (CONSTRAINT_KEYWORDS.has(t.toUpperCase())) break;
    typeTokens.push(t);
  }
  const type = typeTokens.join(' ').trim();
  if (!type) return null; // couldn't cleanly separate a type — skip rather than guess

  const upperRest = rest.map((t) => t.toUpperCase());
  const isPrimaryKey = containsSeq(upperRest, ['PRIMARY', 'KEY']);
  const isNotNull = containsSeq(upperRest, ['NOT', 'NULL']);
  const isUnique = upperRest.includes('UNIQUE');
  const isReference = upperRest.includes('REFERENCES');

  return {
    name,
    type,
    isList: false,
    isOptional: !isNotNull && !isPrimaryKey,
    isRelation: isReference,
    isId: isPrimaryKey,
    isUnique,
  };
}

/**
 * Parse all `CREATE TABLE <name> (...)` statements out of raw SQL text.
 * `ALTER TABLE` is never parsed. When the same table name appears in more
 * than one `CREATE TABLE` within the same text, the first one wins.
 */
export function parseCreateTableStatements(rawSql: string): ParsedSqlTable[] {
  const sql = stripCredentialLines(rawSql);
  const results: ParsedSqlTable[] = [];
  const seen = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."[\]`]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const openParenIdx = re.lastIndex - 1;
    const body = extractBalanced(sql, openParenIdx);
    if (body === null) continue;
    re.lastIndex = openParenIdx + body.length + 2;

    const name = cleanIdentifier(m[1]!);
    if (!name || seen.has(name)) continue; // first CREATE TABLE per table wins
    seen.add(name);

    const fields: DatabaseField[] = [];
    const fieldNames = new Set<string>();
    for (const part of splitTopLevel(body)) {
      const field = parseColumnDef(part);
      if (field && !fieldNames.has(field.name)) {
        fields.push(field);
        fieldNames.add(field.name);
      }
    }
    results.push({ name, fields });
  }
  return results;
}
