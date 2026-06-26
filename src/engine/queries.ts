import type { NodeKind } from '../schema.js';

/**
 * Per-language tree-sitter queries driving extraction. Each query uses a small,
 * fixed capture vocabulary so the generic extractor (parse.ts) stays
 * language-agnostic:
 *
 *   @def   — a definition node (its kind comes from the rule)
 *   @name  — the name node of that definition
 *   @callee — a called name node (a call edge, resolved later)
 *   @source — an import/require source string node (incl. quotes)
 *   @extends / @implements — a base type name node (a heritage edge)
 *
 * Queries are best-effort per language: if a pattern fails to compile against a
 * grammar it is skipped (logged once), so one bad rule never disables a whole
 * language. Coverage is deepest for the TS/JS-first audience and a solid
 * baseline elsewhere — honestly recorded as `heuristic` resolution.
 */

export interface DefRule {
  kind: NodeKind;
  query: string;
}

export interface LangQueries {
  defs: DefRule[];
  calls: string[];
  imports: string[];
  heritage: string[];
  /** Assert/guard expressions captured as @guard → invariant facts (--deep). */
  guards?: string[];
}

// assert-like call detection, shared by the C-family languages.
const ASSERT_CALLS = [
  '(call_expression function: (identifier) @_g (#match? @_g "^(assert|invariant|require|precondition|invariantViolation)$")) @guard',
];

const TS_JS_CALLS = [
  '(call_expression function: (identifier) @callee)',
  '(call_expression function: (member_expression property: (property_identifier) @callee))',
  '(new_expression constructor: (identifier) @callee)',
];

const TS_JS_IMPORTS = [
  '(import_statement source: (string) @source)',
  '(call_expression function: (identifier) @_req (#eq? @_req "require") arguments: (arguments (string) @source))',
];

const TYPESCRIPT: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_declaration name: (identifier) @name) @def' },
    {
      kind: 'function',
      query: '(generator_function_declaration name: (identifier) @name) @def',
    },
    {
      kind: 'function',
      query:
        '(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def',
    },
    { kind: 'method', query: '(method_definition name: (property_identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (type_identifier) @name) @def' },
    { kind: 'class', query: '(abstract_class_declaration name: (type_identifier) @name) @def' },
    { kind: 'interface', query: '(interface_declaration name: (type_identifier) @name) @def' },
  ],
  calls: TS_JS_CALLS,
  imports: TS_JS_IMPORTS,
  heritage: [
    '(class_heritage (extends_clause value: (identifier) @extends))',
    '(class_heritage (extends_clause value: (member_expression property: (property_identifier) @extends)))',
    '(class_heritage (implements_clause (type_identifier) @implements))',
    '(extends_type_clause type: (type_identifier) @extends)',
  ],
  guards: ASSERT_CALLS,
};

const JAVASCRIPT: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_declaration name: (identifier) @name) @def' },
    {
      kind: 'function',
      query: '(generator_function_declaration name: (identifier) @name) @def',
    },
    {
      kind: 'function',
      query:
        '(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def',
    },
    { kind: 'method', query: '(method_definition name: (property_identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (identifier) @name) @def' },
  ],
  calls: TS_JS_CALLS,
  imports: TS_JS_IMPORTS,
  heritage: [
    '(class_heritage (identifier) @extends)',
    '(class_heritage (member_expression property: (property_identifier) @extends))',
  ],
  guards: ASSERT_CALLS,
};

const PYTHON: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_definition name: (identifier) @name) @def' },
    { kind: 'class', query: '(class_definition name: (identifier) @name) @def' },
  ],
  calls: [
    '(call function: (identifier) @callee)',
    '(call function: (attribute attribute: (identifier) @callee))',
  ],
  imports: [
    '(import_statement name: (dotted_name) @source)',
    '(import_from_statement module_name: (dotted_name) @source)',
    // Relative imports (`from .models import X`, `from ..core.utils import Y`) —
    // the module is a `relative_import` node, not a `dotted_name`. These are the
    // bulk of intra-package edges and were previously dropped entirely.
    '(import_from_statement module_name: (relative_import) @source)',
  ],
  heritage: ['(class_definition superclasses: (argument_list (identifier) @extends))'],
  guards: ['(assert_statement) @guard'],
};

const GO: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_declaration name: (identifier) @name) @def' },
    { kind: 'method', query: '(method_declaration name: (field_identifier) @name) @def' },
    { kind: 'class', query: '(type_declaration (type_spec name: (type_identifier) @name)) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (selector_expression field: (field_identifier) @callee))',
  ],
  imports: ['(import_spec path: (interpreted_string_literal) @source)'],
  heritage: [],
};

const JAVA: LangQueries = {
  defs: [
    { kind: 'method', query: '(method_declaration name: (identifier) @name) @def' },
    { kind: 'method', query: '(constructor_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (identifier) @name) @def' },
    { kind: 'interface', query: '(interface_declaration name: (identifier) @name) @def' },
  ],
  calls: ['(method_invocation name: (identifier) @callee)', '(object_creation_expression type: (type_identifier) @callee)'],
  imports: ['(import_declaration (scoped_identifier) @source)'],
  heritage: [
    '(superclass (type_identifier) @extends)',
    '(super_interfaces (type_list (type_identifier) @implements))',
  ],
};

const RUST: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_item name: (identifier) @name) @def' },
    { kind: 'class', query: '(struct_item name: (type_identifier) @name) @def' },
    { kind: 'class', query: '(enum_item name: (type_identifier) @name) @def' },
    { kind: 'interface', query: '(trait_item name: (type_identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (field_expression field: (field_identifier) @callee))',
    '(call_expression function: (scoped_identifier name: (identifier) @callee))',
  ],
  imports: ['(use_declaration (scoped_identifier) @source)'],
  heritage: [],
};

const C_SHARP: LangQueries = {
  defs: [
    { kind: 'method', query: '(method_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (identifier) @name) @def' },
    { kind: 'interface', query: '(interface_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(struct_declaration name: (identifier) @name) @def' },
  ],
  calls: ['(invocation_expression function: (member_access_expression name: (identifier) @callee))', '(invocation_expression function: (identifier) @callee)'],
  imports: ['(using_directive (qualified_name) @source)', '(using_directive (identifier) @source)'],
  heritage: ['(base_list (identifier) @extends)'],
};

const RUBY: LangQueries = {
  defs: [
    { kind: 'method', query: '(method name: (identifier) @name) @def' },
    { kind: 'class', query: '(class name: (constant) @name) @def' },
    { kind: 'module', query: '(module name: (constant) @name) @def' },
  ],
  calls: ['(call method: (identifier) @callee)', '(command method: (identifier) @callee)'],
  imports: [
    '(call method: (identifier) @_m (#match? @_m "require") arguments: (argument_list (string (string_content) @source)))',
  ],
  heritage: ['(class (superclass (constant) @extends))'],
};

const BY_LANG: Record<string, LangQueries> = {
  ts: TYPESCRIPT,
  tsx: TYPESCRIPT,
  js: JAVASCRIPT,
  py: PYTHON,
  go: GO,
  java: JAVA,
  rust: RUST,
  cs: C_SHARP,
  rb: RUBY,
};

export function queriesFor(langId: string): LangQueries | undefined {
  return BY_LANG[langId];
}
