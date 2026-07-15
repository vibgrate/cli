import ts from 'typescript';
import type { DatabaseField } from '../../core-open/index.js';

/**
 * Structural parser for TypeORM `@Entity()`-decorated classes, via the
 * TypeScript compiler API's syntactic parser (same tool as
 * `engine/ts-resolver.ts`, no `ts.Program`/type-checker required for a
 * per-file decorator/property walk).
 *
 * Extracts only: the table name (the decorator's string arg, or its `name`
 * option, or else the class name), and per property carrying a recognized
 * column/relation decorator — the property name, its declared TS type
 * (never evaluated), and which decorator flags apply. It never reads a
 * decorator argument's contents beyond a literal `name`/table-name string —
 * see `packages/vibgrate-hcs/node/src/extractors/entities.ts` for a design
 * reference (a different package's TypeORM-facing extractor); this is a
 * fresh implementation using this package's TS-compiler-API conventions.
 */

export interface ParsedTypeOrmEntity {
  name: string;
  fields: DatabaseField[];
}

const COLUMN_DECORATORS = new Set(['Column', 'PrimaryColumn', 'PrimaryGeneratedColumn']);
const RELATION_DECORATORS = new Set(['OneToMany', 'ManyToOne', 'ManyToMany', 'OneToOne', 'JoinColumn']);
const MANY_RELATION_DECORATORS = new Set(['OneToMany', 'ManyToMany']);
const ID_DECORATORS = new Set(['PrimaryColumn', 'PrimaryGeneratedColumn']);

interface DecoratorInfo {
  name: string;
  args: readonly ts.Expression[];
}

function decoratorInfo(dec: ts.Decorator): DecoratorInfo | null {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { name: expr.expression.text, args: expr.arguments };
  }
  if (ts.isIdentifier(expr)) return { name: expr.text, args: [] };
  return null;
}

function decoratorsOf(node: ts.HasDecorators): DecoratorInfo[] {
  const decs = ts.getDecorators(node) ?? [];
  const out: DecoratorInfo[] = [];
  for (const d of decs) {
    const info = decoratorInfo(d);
    if (info) out.push(info);
  }
  return out;
}

/** Read a string literal from either the decorator's first positional arg
 * (`@Entity('users')`) or a named option on an object-literal first arg
 * (`@Entity({ name: 'users' })`) — never anything beyond that literal. */
function stringOrNamedArg(args: readonly ts.Expression[], propName: string): string | null {
  const first = args[0];
  if (!first) return null;
  if (ts.isStringLiteral(first)) return first.text;
  if (ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === propName &&
        ts.isStringLiteral(prop.initializer)
      ) {
        return prop.initializer.text;
      }
    }
  }
  return null;
}

function parseEntity(cls: ts.ClassDeclaration, entityDec: DecoratorInfo): ParsedTypeOrmEntity {
  const tableName = stringOrNamedArg(entityDec.args, 'name') ?? cls.name!.text;
  const fields: DatabaseField[] = [];

  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const decNames = new Set(decoratorsOf(member).map((d) => d.name));
    const isColumn = [...decNames].some((n) => COLUMN_DECORATORS.has(n));
    const isRelation = [...decNames].some((n) => RELATION_DECORATORS.has(n));
    if (!isColumn && !isRelation) continue; // not a recognized column/relation property

    fields.push({
      name: member.name.text,
      type: member.type ? member.type.getText() : 'unknown',
      isList: [...decNames].some((n) => MANY_RELATION_DECORATORS.has(n)),
      isOptional: member.questionToken !== undefined,
      isRelation,
      isId: [...decNames].some((n) => ID_DECORATORS.has(n)),
      isUnique: false,
    });
  }

  return { name: tableName, fields: fields.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Parse one TS source file's text for TypeORM `@Entity()` classes. */
export function parseTypeOrmFile(sourceText: string, fileName: string): ParsedTypeOrmEntity[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const entities: ParsedTypeOrmEntity[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const entityDec = decoratorsOf(node).find((d) => d.name === 'Entity');
      if (entityDec) entities.push(parseEntity(node, entityDec));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return entities;
}
