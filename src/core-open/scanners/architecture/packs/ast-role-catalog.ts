// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { AstRoleQuery } from '../types.js';

/**
 * Pack-scoped tree-sitter role queries. Data only — no parser runtime.
 *
 * `languages` uses graph/parse ids (`java`, `cs`, `py`, `go`, `ts`, `tsx`, `js`)
 * so the public-CLI extract can filter without remapping.
 */

function q(
  languages: readonly string[],
  query: string,
  needle: string,
  role: AstRoleQuery['role'],
  layer: AstRoleQuery['layer'],
  confidence: number,
  signal: string,
): AstRoleQuery {
  return { languages, query, needle, role, layer, confidence, signal };
}

const JAVA = ['java'] as const;
const CS = ['cs'] as const;
const PY = ['py'] as const;
const GO = ['go'] as const;
const TS = ['ts', 'tsx', 'js'] as const;

const JAVA_ANN = (name: string, role: AstRoleQuery['role'], layer: AstRoleQuery['layer'], signal: string): AstRoleQuery =>
  q(
    JAVA,
    [
      `(marker_annotation name: (identifier) @hit (#eq? @hit "${name}"))`,
      `(annotation name: (identifier) @hit (#eq? @hit "${name}"))`,
      `(marker_annotation name: (scoped_identifier name: (identifier) @hit (#eq? @hit "${name}")))`,
    ].join('\n'),
    `@${name}`,
    role,
    layer,
    0.9,
    signal,
  );

export const JAVA_AST_ROLES: readonly AstRoleQuery[] = Object.freeze([
  JAVA_ANN('RestController', 'controller', 'routing', 'java @RestController'),
  JAVA_ANN('Controller', 'controller', 'routing', 'java @Controller'),
  JAVA_ANN('Service', 'service', 'services', 'java @Service'),
  JAVA_ANN('Repository', 'repository', 'data-access', 'java @Repository'),
  JAVA_ANN('Entity', 'entity', 'domain', 'java @Entity'),
]);

export const SPRING_AST_ROLES: readonly AstRoleQuery[] = JAVA_AST_ROLES;

export const DOTNET_AST_ROLES: readonly AstRoleQuery[] = Object.freeze([
  q(
    CS,
    [
      `(attribute name: (identifier) @hit (#eq? @hit "ApiController"))`,
      `(attribute name: (qualified_name (identifier) @hit (#eq? @hit "ApiController")))`,
    ].join('\n'),
    '[ApiController]',
    'controller',
    'routing',
    0.9,
    'dotnet [ApiController]',
  ),
  q(
    CS,
    [
      `(base_list (identifier) @hit (#eq? @hit "DbContext"))`,
      `(base_list (generic_name (identifier) @hit (#eq? @hit "DbContext")))`,
    ].join('\n'),
    'DbContext',
    'repository',
    'data-access',
    0.86,
    'dotnet : DbContext',
  ),
  q(
    CS,
    [
      `(base_list (identifier) @hit (#eq? @hit "IRequestHandler"))`,
      `(base_list (generic_name (identifier) @hit (#eq? @hit "IRequestHandler")))`,
    ].join('\n'),
    'IRequestHandler',
    'handler',
    'services',
    0.86,
    'dotnet IRequestHandler',
  ),
]);

export const FASTAPI_AST_ROLES: readonly AstRoleQuery[] = Object.freeze([
  q(
    PY,
    '(call function: (identifier) @hit (#eq? @hit "APIRouter"))',
    'APIRouter(',
    'router',
    'routing',
    0.88,
    'fastapi APIRouter()',
  ),
]);

export const DJANGO_AST_ROLES: readonly AstRoleQuery[] = Object.freeze([
  q(
    PY,
    '(assignment left: (identifier) @hit (#eq? @hit "urlpatterns"))',
    'urlpatterns',
    'router',
    'routing',
    0.9,
    'django urlpatterns',
  ),
  q(
    PY,
    [
      '(class_definition superclasses: (argument_list (attribute object: (identifier) @obj attribute: (identifier) @hit (#eq? @obj "models") (#eq? @hit "Model"))))',
      '(class_definition superclasses: (argument_list (identifier) @hit (#eq? @hit "Model")))',
    ].join('\n'),
    'models.Model',
    'entity',
    'domain',
    0.88,
    'django models.Model',
  ),
]);

export const GO_AST_ROLES: readonly AstRoleQuery[] = Object.freeze([
  q(
    GO,
    '(method_declaration name: (field_identifier) @hit (#eq? @hit "ServeHTTP"))',
    'ServeHTTP',
    'handler',
    'routing',
    0.9,
    'go ServeHTTP',
  ),
  q(
    GO,
    '(call_expression function: (selector_expression field: (field_identifier) @hit (#eq? @hit "NewRouter")))',
    'chi.NewRouter',
    'router',
    'routing',
    0.86,
    'go chi.NewRouter',
  ),
  q(
    GO,
    '(call_expression function: (selector_expression operand: (identifier) @hit (#eq? @hit "gin")))',
    'gin.',
    'router',
    'routing',
    0.86,
    'go gin',
  ),
]);

export const NESTJS_AST_ROLES: readonly AstRoleQuery[] = Object.freeze([
  q(
    TS,
    [
      '(decorator (identifier) @hit (#eq? @hit "Controller"))',
      '(decorator (call_expression function: (identifier) @hit (#eq? @hit "Controller")))',
    ].join('\n'),
    '@Controller(',
    'controller',
    'routing',
    0.9,
    'nestjs @Controller(',
  ),
  q(
    TS,
    [
      '(decorator (identifier) @hit (#eq? @hit "Injectable"))',
      '(decorator (call_expression function: (identifier) @hit (#eq? @hit "Injectable")))',
    ].join('\n'),
    '@Injectable(',
    'service',
    'services',
    0.88,
    'nestjs @Injectable(',
  ),
]);

export interface AstRoleCatalogEntry extends AstRoleQuery {
  packId: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `needle` occurs as a structural token in `source`. */
export function sourceHasRoleNeedle(source: string, needle: string): boolean {
  if (!needle) return false;
  if (needle.startsWith('@') || needle.startsWith('[')) {
    return source.includes(needle);
  }
  if (needle.endsWith('(') || needle.endsWith('.')) {
    return source.includes(needle);
  }
  const escaped = escapeRegExp(needle);
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(source);
}

export function catalogForLanguage(lang: string): readonly AstRoleCatalogEntry[] {
  return AST_ROLE_CATALOG.filter((q) => q.languages.includes(lang));
}

function withPack(packId: string, roles: readonly AstRoleQuery[]): AstRoleCatalogEntry[] {
  return roles.map((role) => ({ ...role, packId }));
}

/** Flat catalog used by the public-CLI extract (and the tree-sitter-free matcher). */
export const AST_ROLE_CATALOG: readonly AstRoleCatalogEntry[] = Object.freeze([
  ...withPack('language/java', JAVA_AST_ROLES),
  ...withPack('framework/spring', SPRING_AST_ROLES),
  ...withPack('language/cs', DOTNET_AST_ROLES),
  ...withPack('framework/aspnet', DOTNET_AST_ROLES),
  ...withPack('framework/fastapi', FASTAPI_AST_ROLES),
  ...withPack('framework/django', DJANGO_AST_ROLES),
  ...withPack('language/go', GO_AST_ROLES),
  ...withPack('framework/nestjs', NESTJS_AST_ROLES),
]);
