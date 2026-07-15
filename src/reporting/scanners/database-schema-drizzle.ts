import ts from 'typescript';
import type { DatabaseField } from '../../core-open/index.js';

/**
 * Structural parser for Drizzle ORM table definitions
 * (`pgTable`/`mysqlTable`/`sqliteTable` calls imported from `drizzle-orm`),
 * via the TypeScript compiler API's syntactic parser (same tool as
 * `engine/ts-resolver.ts`, but no `ts.Program`/type-checker needed — this is
 * a pure per-file AST walk, so it stays fast even over a large repo).
 *
 * Extracts only: the table name (the first string-literal argument), and per
 * column — the object-literal key as the column name, the column-builder
 * function name (e.g. `text`, `integer`, `varchar`) as its "type", and
 * whether `.primaryKey()`/`.notNull()`/`.unique()`/`.references(...)` are
 * chained on it (presence-only — a `.references(...)` argument's contents are
 * never inspected, only that a relation was declared).
 */

export interface ParsedDrizzleTable {
  name: string;
  fields: DatabaseField[];
}

const DRIZZLE_TABLE_FUNCS = new Set(['pgTable', 'mysqlTable', 'sqliteTable']);

/** Local identifiers bound to a drizzle-orm table-builder import in this file
 * (handles `import { pgTable as table } from 'drizzle-orm/pg-core'`-style aliasing). */
function collectDrizzleTableImportNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !spec.text.startsWith('drizzle-orm')) continue;
    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (DRIZZLE_TABLE_FUNCS.has(imported)) names.add(el.name.text);
    }
  }
  return names;
}

function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Walk a column-builder call chain, e.g. `integer('id').primaryKey().notNull()`,
 * to find the base builder function name and which modifiers are chained on it. */
function parseColumnBuilderExpr(colName: string, expr: ts.Expression): DatabaseField | null {
  let node: ts.Expression = expr;
  let builderName: string | null = null;
  let isPrimaryKey = false;
  let isNotNull = false;
  let isUnique = false;
  let isReference = false;

  while (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      builderName = callee.text;
      break;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      switch (callee.name.text) {
        case 'primaryKey': isPrimaryKey = true; break;
        case 'notNull': isNotNull = true; break;
        case 'unique': isUnique = true; break;
        case 'references': isReference = true; break;
        default: break;
      }
      node = callee.expression;
      continue;
    }
    break;
  }
  if (!builderName) return null;

  return {
    name: colName,
    type: builderName,
    isList: false,
    isOptional: !isNotNull && !isPrimaryKey,
    isRelation: isReference,
    isId: isPrimaryKey,
    isUnique,
  };
}

function parseDrizzleTableCall(call: ts.CallExpression): ParsedDrizzleTable | null {
  const [nameArg, columnsArg] = call.arguments;
  if (!nameArg || !ts.isStringLiteral(nameArg)) return null;

  const fields: DatabaseField[] = [];
  if (columnsArg && ts.isObjectLiteralExpression(columnsArg)) {
    for (const prop of columnsArg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const colName = propertyKeyName(prop.name);
      if (!colName) continue;
      const field = parseColumnBuilderExpr(colName, prop.initializer);
      if (field) fields.push(field);
    }
  }
  return { name: nameArg.text, fields };
}

/** Parse one TS/TSX source file's text for Drizzle table definitions. */
export function parseDrizzleFile(sourceText: string, fileName: string): ParsedDrizzleTable[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const tableImportNames = collectDrizzleTableImportNames(sf);
  if (tableImportNames.size === 0) return [];

  const tables: ParsedDrizzleTable[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && tableImportNames.has(node.expression.text)) {
      const table = parseDrizzleTableCall(node);
      if (table) tables.push(table);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return tables;
}
