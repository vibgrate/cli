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
  /**
   * Constructor-parameter / field declared types captured as @typeref — a
   * structural dependency (e.g. Spring constructor/field injection) that never
   * appears as a `call_expression`/`object_creation_expression`, so it needs its
   * own capture. Resolved to a `references` edge (not `call`) in resolve.ts.
   */
  typeRefs?: string[];
  /**
   * Namespace declarations captured as @namespace — the namespaces a file
   * declares its types in. For languages where a namespace is decoupled from
   * the directory (C#), this lets the resolver connect a cross-directory
   * reference when the caller `using`-imports that namespace. Absent for
   * languages that have no namespace concept or where package == directory.
   */
  namespaces?: string[];
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
  // Spring-style dependency injection wires a collaborator via a constructor
  // parameter or a field, never a `new`/method call — so without these, an
  // injected repository/service shows zero callers even when it is the sole
  // reason five other classes exist.
  typeRefs: [
    '(constructor_declaration parameters: (formal_parameters (formal_parameter type: (type_identifier) @typeref)))',
    '(field_declaration type: (type_identifier) @typeref)',
  ],
  // A Java package is a directory, so cross-directory (cross-package) DI
  // resolves through `import a.b.Foo`. Capturing the package lets the resolver
  // reach the implementation in another package when the caller imports it.
  namespaces: ['(package_declaration (scoped_identifier) @namespace)', '(package_declaration (identifier) @namespace)'],
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
    // Enums and records are load-bearing lookup targets in real C# codebases
    // (permission enums, DTO records); without these captures a `Privilege`-
    // style lookup only ever resolves via the literal text fallthrough.
    // 'class' is this engine's established kind for enum-like types (see the
    // Rust enum_item and C enum_specifier mappings).
    { kind: 'class', query: '(enum_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(record_declaration name: (identifier) @name) @def' },
  ],
  calls: [
    '(invocation_expression function: (member_access_expression name: (identifier) @callee))',
    '(invocation_expression function: (identifier) @callee)',
    // `new Foo(...)` is an instantiation dependency (the caller depends on Foo),
    // and it is how a test most directly links to the class under test — without
    // it a test that only constructs the service showed up as no coverage.
    '(object_creation_expression type: (identifier) @callee)',
  ],
  imports: ['(using_directive (qualified_name) @source)', '(using_directive (identifier) @source)'],
  heritage: ['(base_list (identifier) @extends)'],
  // Dependency-injection wiring: the interface a class depends on appears as a
  // constructor-parameter type or a readonly field type, never as a call — so
  // without these captures a controller/service injected through an interface
  // looks like it references nothing. Simple (identifier) types only; generics/
  // qualified names are left to a precise rung. Mirrors the Java DI captures.
  typeRefs: [
    '(constructor_declaration (parameter_list (parameter type: (identifier) @typeref)))',
    '(field_declaration (variable_declaration type: (identifier) @typeref))',
  ],
  // A namespace is decoupled from the directory in C#, so cross-namespace
  // resolution needs to know which namespace a file declares. Both block-scoped
  // (`namespace N { }`) and file-scoped (`namespace N;`) forms.
  namespaces: [
    '(namespace_declaration name: [(identifier) (qualified_name)] @namespace)',
    '(file_scoped_namespace_declaration name: [(identifier) (qualified_name)] @namespace)',
  ],
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


const PHP: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_definition name: (name) @name) @def' },
    {
      kind: 'function',
      query:
        '(assignment_expression left: (variable_name (name) @name) right: [(anonymous_function_creation_expression) (arrow_function)]) @def',
    },
    { kind: 'method', query: '(method_declaration name: (name) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (name) @name) @def' },
    { kind: 'class', query: '(trait_declaration name: (name) @name) @def' },
    { kind: 'interface', query: '(interface_declaration name: (name) @name) @def' },
  ],
  calls: [
    '(function_call_expression function: (name) @callee)',
    '(member_call_expression name: (name) @callee)',
    '(nullsafe_member_call_expression name: (name) @callee)',
    '(scoped_call_expression name: (name) @callee)',
    '(object_creation_expression (name) @callee)',
  ],
  imports: [
    '(namespace_use_clause (qualified_name) @source)',
    '(namespace_use_clause (name) @source)',
    '[(require_expression (string) @source) (require_once_expression (string) @source) (include_expression (string) @source) (include_once_expression (string) @source)]',
  ],
  heritage: ['(base_clause (name) @extends)', '(class_interface_clause (name) @implements)'],
  // PHP namespaces are decoupled from directories (PSR-4 maps them, but the
  // resolver has no composer.json), so cross-namespace DI resolves through
  // `use`. Constructor-parameter and typed-property types are the injection
  // points.
  namespaces: ['(namespace_definition name: (namespace_name) @namespace)'],
  typeRefs: [
    '(simple_parameter type: (named_type (name) @typeref))',
    '(property_declaration type: (named_type (name) @typeref))',
  ],
  guards: ['(function_call_expression function: (name) @_g (#eq? @_g "assert")) @guard'],
};

// fwcd grammar: no field names — captures are positional; each def pattern binds
// exactly one @name (params live under function_value_parameters). `class` vs
// `interface` are both class_declaration, split by the anonymous keyword token.
const KOTLIN: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_declaration (simple_identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration "class" (type_identifier) @name) @def' },
    { kind: 'interface', query: '(class_declaration "interface" (type_identifier) @name) @def' },
    { kind: 'class', query: '(object_declaration (type_identifier) @name) @def' },
  ],
  calls: [
    '(call_expression (simple_identifier) @callee)',
    '(call_expression (navigation_expression (navigation_suffix (simple_identifier) @callee)))',
  ],
  imports: ['(import_header (identifier) @source)'],
  // Kotlin: package for cross-package DI reachability; primary-constructor
  // `val` params and property types are the injection points.
  namespaces: ['(package_header (identifier) @namespace)'],
  typeRefs: [
    '(class_parameter (user_type (type_identifier) @typeref))',
    '(property_declaration (variable_declaration (user_type (type_identifier) @typeref)))',
    '(property_declaration (variable_declaration (nullable_type (user_type (type_identifier) @typeref))))',
  ],
  heritage: [
    '(delegation_specifier (constructor_invocation (user_type (type_identifier) @extends)))',
    '(delegation_specifier (user_type (type_identifier) @implements))',
  ],
  guards: ['(call_expression (simple_identifier) @_g (#match? @_g "^(require|check|assert)$")) @guard'],
};

// class/struct/enum/extension are ALL class_declaration; extensions carry
// name: (user_type …) and so get their own (duplicate-named) class def node.
const SWIFT: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_declaration name: (simple_identifier) @name) @def' },
    { kind: 'method', query: '(protocol_function_declaration name: (simple_identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (type_identifier) @name) @def' },
    { kind: 'class', query: '(class_declaration name: (user_type (type_identifier) @name)) @def' },
    { kind: 'interface', query: '(protocol_declaration name: (type_identifier) @name) @def' },
  ],
  calls: [
    '(call_expression (simple_identifier) @callee)',
    '(call_expression (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @callee)))',
  ],
  imports: ['(import_declaration (identifier) @source)'],
  heritage: ['(inheritance_specifier inherits_from: (user_type (type_identifier) @extends))'],
  // Swift: init-parameter and stored-property types are the injection points
  // (protocol-typed). Whole-module visibility (handled in resolve.ts) makes the
  // conforming implementation reachable cross-file.
  typeRefs: [
    '(parameter (user_type (type_identifier) @typeref))',
    '(type_annotation (user_type (type_identifier) @typeref))',
  ],
  guards: [
    '(call_expression (simple_identifier) @_g (#match? @_g "^(assert|precondition|assertionFailure|preconditionFailure)$")) @guard',
  ],
};

const SCALA: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_definition name: (identifier) @name) @def' },
    { kind: 'method', query: '(function_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(class_definition name: (identifier) @name) @def' },
    { kind: 'interface', query: '(trait_definition name: (identifier) @name) @def' },
    { kind: 'module', query: '(object_definition name: (identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (field_expression field: (identifier) @callee))',
  ],
  imports: [
    '(import_declaration path: (stable_identifier) @source)',
    '(import_declaration path: (identifier) @source)',
  ],
  heritage: [
    '(extends_clause type: (type_identifier) @extends)',
    '(extends_clause type: (generic_type type: (type_identifier) @extends))',
    '(extends_clause type: (compound_type base: (type_identifier) @extends))',
    '(extends_clause type: (compound_type extra: (type_identifier) @implements))',
  ],
  // Scala: package for cross-package DI reachability; class-parameter and val
  // types are the injection points.
  namespaces: ['(package_clause name: (package_identifier) @namespace)'],
  typeRefs: [
    '(class_parameter type: (type_identifier) @typeref)',
    '(val_definition type: (type_identifier) @typeref)',
  ],
  guards: ['(call_expression function: (identifier) @_g (#match? @_g "^(require|assert|assume)$")) @guard'],
};

// No call_expression node in this grammar: a call is an identifier followed by a
// sibling selector(argument_part), hence the anchored sibling patterns.
const DART: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_signature name: (identifier) @name) @def' },
    { kind: 'method', query: '(constructor_signature name: (identifier) @name) @def' },
    { kind: 'class', query: '(class_definition name: (identifier) @name) @def' },
    { kind: 'class', query: '(mixin_declaration (identifier) @name) @def' },
  ],
  calls: [
    '(_ (identifier) @callee . (selector (argument_part)))',
    '(_ (selector (unconditional_assignable_selector (identifier) @callee)) . (selector (argument_part)))',
    '(_ (selector (conditional_assignable_selector (identifier) @callee)) . (selector (argument_part)))',
    '(cascade_section (cascade_selector (identifier) @callee) . (argument_part))',
  ],
  imports: ['(import_specification (configurable_uri (uri (string_literal) @source)))'],
  // Dart: constructor/method parameter types and typed field declarations are
  // the injection points (Dart resolves cross-file via `import`, so no
  // namespace query is needed — the import rung already reaches the impl).
  typeRefs: [
    '(formal_parameter (type_identifier) @typeref)',
    '(declaration (type_identifier) @typeref)',
  ],
  heritage: [
    '(superclass (type_identifier) @extends)',
    '(interfaces (type_identifier) @implements)',
    '(mixins (type_identifier) @implements)',
  ],
  guards: ['(assert_statement) @guard'],
};

const LUA: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_definition_statement name: (identifier) @name) @def' },
    { kind: 'function', query: '(function_definition_statement name: (variable field: (identifier) @name)) @def' },
    { kind: 'method', query: '(function_definition_statement name: (variable method: (identifier) @name)) @def' },
    { kind: 'function', query: '(local_function_definition_statement name: (identifier) @name) @def' },
    {
      kind: 'function',
      query:
        '(variable_assignment (variable_list (variable field: (identifier) @name)) (expression_list value: (function_definition))) @def',
    },
    {
      kind: 'function',
      query:
        '(local_variable_declaration (variable_list (variable name: (identifier) @name)) (expression_list value: (function_definition))) @def',
    },
  ],
  calls: [
    '(call function: (variable name: (identifier) @callee))',
    '(call function: (variable field: (identifier) @callee))',
    '(call function: (variable method: (identifier) @callee))',
  ],
  imports: [
    '(call function: (variable name: (identifier) @_r (#eq? @_r "require")) arguments: (argument_list (expression_list (string) @source)))',
  ],
  heritage: [],
  guards: ['(call function: (variable name: (identifier) @_g (#eq? @_g "assert"))) @guard'],
};

// Expression-based grammar: defmodule/def/defp are ordinary `call` nodes keyed by
// their target identifier, so every rule is predicate-gated. A parenthesized def
// head is itself a call and yields one benign same-line self-capture; the
// resolver's qualified-call/enclosing-def rules keep it from becoming an edge.
const ELIXIR: LangQueries = {
  defs: [
    { kind: 'module', query: '(call target: (identifier) @_kw (#eq? @_kw "defmodule") (arguments (alias) @name)) @def' },
    {
      kind: 'function',
      query:
        '(call target: (identifier) @_kw (#match? @_kw "^(def|defp|defmacro|defmacrop|defguard|defguardp)$") (arguments (call target: (identifier) @name))) @def',
    },
    {
      kind: 'function',
      query:
        '(call target: (identifier) @_kw (#match? @_kw "^(def|defp|defmacro|defmacrop)$") (arguments (identifier) @name)) @def',
    },
    {
      kind: 'function',
      query:
        '(call target: (identifier) @_kw (#match? @_kw "^(def|defp|defmacro|defmacrop|defguard|defguardp)$") (arguments (binary_operator left: (call target: (identifier) @name)))) @def',
    },
  ],
  calls: [
    '(call target: (dot right: (identifier) @callee))',
    '(call target: (identifier) @callee (#not-match? @callee "^(def|defp|defmacro|defmacrop|defmodule|defstruct|defprotocol|defimpl|defguard|defguardp|defdelegate|defexception|defoverridable|alias|import|require|use|quote|unquote|moduledoc|doc|spec|type|typep|typedoc|opaque|behaviour|impl|derive|enforce_keys|callback|macrocallback|optional_callbacks|compile|deprecated|dialyzer|external_resource|on_definition|on_load|after_compile|before_compile)$"))',
  ],
  imports: [
    '(call target: (identifier) @_kw (#match? @_kw "^(alias|import|require|use)$") (arguments (alias) @source))',
    '(call target: (identifier) @_kw (#match? @_kw "^(alias|import|require|use)$") (arguments (dot left: (alias) @source)))',
  ],
  heritage: [],
};

// Every shell command is a `command` node, so callees include external binaries
// (rsync, git, …). Safe: the resolver has no global-name fallback, so only
// callees matching a reachable function_definition become edges.
const BASH: LangQueries = {
  defs: [{ kind: 'function', query: '(function_definition name: (word) @name) @def' }],
  calls: ['(command name: (command_name (word) @callee))'],
  imports: [
    '(command name: (command_name (word) @_c (#match? @_c "^(source|\\.)$")) argument: [(word) (string) (raw_string) (concatenation)] @source)',
  ],
  heritage: [],
};

const ZIG: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(variable_declaration (identifier) @name (struct_declaration)) @def' },
    { kind: 'class', query: '(variable_declaration (identifier) @name (enum_declaration)) @def' },
    { kind: 'class', query: '(variable_declaration (identifier) @name (union_declaration)) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (field_expression member: (identifier) @callee))',
  ],
  imports: ['(builtin_function (builtin_identifier) @_i (#eq? @_i "@import") (arguments (string) @source))'],
  heritage: [],
  guards: ['(call_expression function: (field_expression member: (identifier) @_g (#eq? @_g "assert"))) @guard'],
};

// Only body-bearing function_definitions match (prototypes are `declaration`s).
const C_LANG: LangQueries = {
  defs: [
    {
      kind: 'function',
      query:
        '(function_definition declarator: [(function_declarator declarator: (identifier) @name) (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))]) @def',
    },
    { kind: 'class', query: '(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @def' },
    { kind: 'class', query: '(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @def' },
    { kind: 'class', query: '(type_definition declarator: (type_identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (field_expression field: (field_identifier) @callee))',
  ],
  imports: ['(preproc_include path: (string_literal) @source)', '(preproc_include path: (system_lib_string) @source)'],
  heritage: [],
  guards: ['(call_expression function: (identifier) @_g (#match? @_g "^(assert|static_assert)$")) @guard'],
};

const CPP: LangQueries = {
  defs: [
    {
      kind: 'function',
      query:
        '(function_definition declarator: [(function_declarator declarator: (identifier) @name) (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)) (reference_declarator (function_declarator declarator: (identifier) @name))]) @def',
    },
    { kind: 'method', query: '(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def' },
    {
      kind: 'method',
      query:
        '(function_definition declarator: [(function_declarator declarator: (qualified_identifier name: (identifier) @name)) (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) (reference_declarator (function_declarator declarator: (qualified_identifier name: (identifier) @name)))]) @def',
    },
    {
      kind: 'method',
      query:
        '(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (qualified_identifier name: (identifier) @name)))) @def',
    },
    { kind: 'class', query: '(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @def' },
    { kind: 'class', query: '(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @def' },
    { kind: 'module', query: '(namespace_definition name: (namespace_identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (field_expression field: (field_identifier) @callee))',
    '(call_expression function: (qualified_identifier name: (identifier) @callee))',
    '(call_expression function: (qualified_identifier name: (qualified_identifier name: (identifier) @callee)))',
    '(new_expression type: (type_identifier) @callee)',
  ],
  imports: ['(preproc_include path: (string_literal) @source)', '(preproc_include path: (system_lib_string) @source)'],
  heritage: [
    '(base_class_clause (type_identifier) @extends)',
    '(base_class_clause (qualified_identifier name: (type_identifier) @extends))',
  ],
  guards: ['(call_expression function: (identifier) @_g (#match? @_g "^(assert|static_assert)$")) @guard'],
};

const OBJC: LangQueries = {
  defs: [
    {
      kind: 'function',
      query: '(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def',
    },
    // The selector segments are the method_definition's direct bare identifiers
    // (param names sit inside method_parameter); the first segment names it.
    { kind: 'method', query: '(method_definition (identifier) @name) @def' },
    { kind: 'class', query: '(class_implementation . (identifier) @name) @def' },
    { kind: 'interface', query: '(class_interface . (identifier) @name) @def' },
    // A @protocol is Objective-C's interface — without this it is not a node, so
    // conformance and protocol-typed DI cannot resolve.
    { kind: 'interface', query: '(protocol_declaration (identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(message_expression method: (identifier) @callee)',
  ],
  imports: [
    '(preproc_include path: (string_literal) @source)',
    '(preproc_include path: (system_lib_string) @source)',
  ],
  // Superclass (`: NSObject`) is `extends`; adopted protocols (`<Servicing>`,
  // captured as parameterized_arguments after the interface name) are the
  // `implements` relationship a DI call disambiguates through.
  heritage: [
    '(class_interface superclass: (identifier) @extends)',
    '(class_interface (parameterized_arguments (type_name (type_identifier) @implements)))',
  ],
  guards: ASSERT_CALLS,
};

const OCAML: LangQueries = {
  defs: [
    // Only parameterised bindings — plain `let x = …` values would drown the
    // graph in constants.
    { kind: 'function', query: '(let_binding pattern: (value_name) @name (parameter)) @def' },
    { kind: 'module', query: '(module_binding name: (module_name) @name) @def' },
  ],
  calls: ['(application_expression function: (value_path (value_name) @callee))'],
  imports: ['(open_module (module_path (module_name) @source))'],
  heritage: [],
};

const RESCRIPT: LangQueries = {
  defs: [
    { kind: 'function', query: '(let_binding pattern: (value_identifier) @name body: (function)) @def' },
    { kind: 'module', query: '(module_binding name: (module_identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (value_identifier) @callee)',
    '(call_expression function: (value_identifier_path (value_identifier) @callee))',
  ],
  imports: ['(open_statement (module_identifier) @source)'],
  heritage: [],
};

const SOLIDITY: LangQueries = {
  defs: [
    { kind: 'function', query: '(function_definition name: (identifier) @name) @def' },
    { kind: 'function', query: '(modifier_definition name: (identifier) @name) @def' },
    { kind: 'class', query: '(contract_declaration name: (identifier) @name) @def' },
    { kind: 'class', query: '(library_declaration name: (identifier) @name) @def' },
    { kind: 'interface', query: '(interface_declaration name: (identifier) @name) @def' },
  ],
  calls: [
    '(call_expression function: (identifier) @callee)',
    '(call_expression function: (member_expression property: (identifier) @callee))',
    '(emit_statement name: (identifier) @callee)',
  ],
  imports: ['(import_directive source: (string) @source)'],
  heritage: ['(inheritance_specifier ancestor: (user_defined_type (identifier) @extends))'],
  guards: [
    '(call_expression function: (identifier) @_g (#match? @_g "^(require|assert)$")) @guard',
  ],
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
  php: PHP,
  kotlin: KOTLIN,
  swift: SWIFT,
  scala: SCALA,
  dart: DART,
  lua: LUA,
  ex: ELIXIR,
  sh: BASH,
  zig: ZIG,
  c: C_LANG,
  cpp: CPP,
  objc: OBJC,
  ocaml: OCAML,
  rescript: RESCRIPT,
  solidity: SOLIDITY,
  // Container formats (vue/svelte/astro/html/erb/ejs) have no entry here on
  // purpose: parse.ts routes them to their embedded language's queries.
};

export function queriesFor(langId: string): LangQueries | undefined {
  return BY_LANG[langId];
}
