import type { Node } from 'web-tree-sitter';
import { toolchainParser } from './grammars.js';
import { LineIndex, safeDoc, TOOLCHAIN_NODES_PER_FILE_MAX } from './util.js';
import { redactSecrets } from '../../core-open/utils/redact.js';
import { isSecretShapedKey } from '../../security/secret-keys.js';
import type {
  ToolchainEdgeDraft,
  ToolchainExtraction,
  ToolchainExtractor,
  ToolchainNodeDraft,
} from './types.js';

/**
 * Terraform / OpenTofu extraction over the HCL concrete syntax tree.
 *
 * This replaces regex scraping. The regexes it supersedes
 * (`core-open/scanners/terraform-scanner.ts`) used patterns of the form
 * `/required_providers\s*\{([^}]+)\}/s`, where `[^}]+` stops at the *first*
 * closing brace — so the extremely common nested form
 *
 *     required_providers {
 *       aws = { source = "hashicorp/aws" }   ← inner `}` ends the match
 *       azurerm = { source = "hashicorp/azurerm" }   ← never seen
 *     }
 *
 * silently dropped every provider after the first. A CST has no such failure
 * mode: nesting is structure, not a character class.
 *
 * ## What is extracted
 *
 * | Block | Node kind | Address |
 * |---|---|---|
 * | `resource "T" "N"` | `resource` | `T.N` |
 * | `data "T" "N"` | `resource` | `data.T.N` |
 * | `module "N"` | `module` | `module.N` |
 * | `variable "N"` | `property` | `var.N` |
 * | `output "N"` | `property` | `output.N` |
 * | `provider "N"` | `package` | `provider.N` |
 *
 * Edges come from two sources, both declared rather than guessed: an explicit
 * `depends_on` list, and interpolation references (`subnet_id =
 * aws_subnet.main.id` ⇒ `aws_instance.web depends_on aws_subnet.main`). Both
 * are `depends_on`; a module block additionally `provisions` nothing until the
 * linker sees the module's own files, so we do not invent that edge here.
 */

/**
 * Reference prefixes that name something other than a graph node: loop and
 * context builtins, plus `terraform`/`path` metadata. Referencing them is not
 * a dependency on anything we can point at.
 */
const BUILTIN_REF_PREFIXES = new Set([
  'count',
  'each',
  'self',
  'path',
  'terraform',
]);

/** Block types that declare a named, addressable object. */
type BlockSpec = {
  kind: ToolchainNodeDraft['kind'];
  /** Number of quoted labels the block carries. */
  labels: 1 | 2;
  /** Build the Terraform address from the labels. */
  address: (labels: string[]) => string;
  signature: string;
  importance: number;
};

const BLOCK_SPECS: Record<string, BlockSpec> = {
  resource: {
    kind: 'resource',
    labels: 2,
    address: ([type, name]) => `${type}.${name}`,
    signature: 'terraform.resource',
    importance: 0.5,
  },
  data: {
    kind: 'resource',
    labels: 2,
    address: ([type, name]) => `data.${type}.${name}`,
    signature: 'terraform.data',
    importance: 0.3,
  },
  module: {
    kind: 'module',
    labels: 1,
    address: ([name]) => `module.${name}`,
    signature: 'terraform.module',
    importance: 0.6,
  },
  variable: {
    kind: 'property',
    labels: 1,
    address: ([name]) => `var.${name}`,
    signature: 'terraform.variable',
    importance: 0.2,
  },
  output: {
    kind: 'property',
    labels: 1,
    address: ([name]) => `output.${name}`,
    signature: 'terraform.output',
    importance: 0.3,
  },
  provider: {
    kind: 'package',
    labels: 1,
    address: ([name]) => `provider.${name}`,
    signature: 'terraform.provider',
    importance: 0.4,
  },
};

/** Unquote an HCL `string_lit` node by reading its `template_literal` child. */
function stringLitValue(node: Node): string {
  for (const child of node.namedChildren) {
    if (child?.type === 'template_literal') return child.text;
  }
  // An empty string literal ("") has no template_literal child.
  return '';
}

/** Top-level `block` nodes of an HCL document, in source order. */
function topLevelBlocks(root: Node): Node[] {
  const out: Node[] = [];
  // config_file → body → block*
  for (const bodyCandidate of root.namedChildren) {
    if (!bodyCandidate) continue;
    const body = bodyCandidate.type === 'body' ? bodyCandidate : null;
    if (!body) continue;
    for (const child of body.namedChildren) {
      if (child?.type === 'block') out.push(child);
    }
  }
  return out;
}

/** The `body` child of a block, if present. */
function blockBody(block: Node): Node | null {
  for (const child of block.namedChildren) {
    if (child?.type === 'body') return child;
  }
  return null;
}

/** Direct `attribute` children of a body, as `[name, expressionNode]`. */
function attributes(body: Node): { name: string; expr: Node | null; node: Node }[] {
  const out: { name: string; expr: Node | null; node: Node }[] = [];
  for (const child of body.namedChildren) {
    if (child?.type !== 'attribute') continue;
    let name = '';
    let expr: Node | null = null;
    for (const part of child.namedChildren) {
      if (!part) continue;
      if (!name && part.type === 'identifier') name = part.text;
      else if (part.type === 'expression') expr = part;
    }
    if (name) out.push({ name, expr, node: child });
  }
  return out;
}

/** Direct nested `block` children of a body. */
function nestedBlocks(body: Node): Node[] {
  const out: Node[] = [];
  for (const child of body.namedChildren) {
    if (child?.type === 'block') out.push(child);
  }
  return out;
}

/** A block's `identifier` (its type) and its quoted labels. */
function blockHead(block: Node): { type: string; labels: string[] } {
  let type = '';
  const labels: string[] = [];
  for (const child of block.namedChildren) {
    if (!child) continue;
    if (!type && child.type === 'identifier') type = child.text;
    else if (child.type === 'string_lit') labels.push(stringLitValue(child));
    else if (child.type === 'body') break;
  }
  return { type, labels };
}

/**
 * Collect every Terraform address referenced inside an expression subtree.
 *
 * A reference in HCL is a `variable_expr` (the root name) followed by
 * `get_attr` siblings (the dotted path). `aws_subnet.main.id` yields
 * `aws_subnet` + `main` + `id`; the addressable prefix is `aws_subnet.main`.
 */
function referencedAddresses(expr: Node | null, out: Set<string>): void {
  if (!expr) return;
  const stack: Node[] = [expr];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'variable_expr') {
      const root = node.text;
      // Walk the get_attr chain that follows this variable_expr among its siblings.
      const parts: string[] = [root];
      let sibling = node.nextNamedSibling;
      while (sibling && sibling.type === 'get_attr') {
        const id = sibling.namedChildren.find((c) => c?.type === 'identifier');
        if (!id) break;
        parts.push(id.text);
        sibling = sibling.nextNamedSibling;
      }
      const address = terraformAddress(parts);
      if (address) out.add(address);
      // Do not descend into this variable_expr; its identifier child is the name.
      continue;
    }
    for (const child of node.namedChildren) {
      if (child) stack.push(child);
    }
  }
}

/**
 * Reduce a dotted reference path to the address of the thing it points at, or
 * null when it points at nothing we model.
 *
 *   ['var','ami_id']                  → 'var.ami_id'
 *   ['aws_subnet','main','id']        → 'aws_subnet.main'
 *   ['data','aws_ami','ubuntu','id']  → 'data.aws_ami.ubuntu'
 *   ['module','vpc','vpc_id']         → 'module.vpc'
 *   ['each','key']                    → null (builtin)
 */
function terraformAddress(parts: string[]): string | null {
  const [head, ...rest] = parts;
  if (!head || BUILTIN_REF_PREFIXES.has(head)) return null;
  if (head === 'var' || head === 'local') return rest.length ? `${head}.${rest[0]}` : null;
  if (head === 'module') return rest.length ? `module.${rest[0]}` : null;
  if (head === 'data') return rest.length >= 2 ? `data.${rest[0]}.${rest[1]}` : null;
  // A managed resource reference: `<type>.<name>[.attr…]`. A bare identifier
  // with no attribute is not an address (it is a local name in scope).
  return rest.length ? `${head}.${rest[0]}` : null;
}

// ── `attrs` projection (packages/vibgrate-haile/docs/facts.md §2.2) ─────────
//
// A closed, literal-only view of a block body for the security fact builder.
// Literals become JSON values, nested blocks become arrays grouped by block
// type, and *anything* the file does not state literally — an interpolation,
// a reference, a function call, a conditional — becomes `{ expr }` so a rule
// can abstain instead of guessing. Never serialised into the graph.

/** Caps the host enforces on a projection (facts.md §2 "Caps"). */
const ATTRS_MAX_DEPTH = 6;
const ATTRS_MAX_KEYS = 64;
const ATTRS_MAX_ITEMS = 64;
const ATTRS_MAX_STRING = 256;

/**
 * A projected string: credential-shaped substrings are redacted at ingest
 * (GUARDRAILS §1.1 — the projection is in-memory only, but it crosses into
 * the module and feeds a digest, so it is scrubbed before it does), then
 * length-capped.
 */
function projectedString(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > ATTRS_MAX_STRING ? redacted.slice(0, ATTRS_MAX_STRING) : redacted;
}

/**
 * The `{ expr }` placeholder for a non-literal expression. Whitespace is
 * collapsed so a CRLF checkout of the same file yields the same text (and so
 * the same finding id) as an LF one.
 */
function exprPlaceholder(expr: Node): { expr: string } {
  return { expr: projectedString(expr.text.replace(/\s+/g, ' ').trim()) };
}

/** Unescape the common HCL quoted-template escapes (`\"`, `\\`, `\n`, `\r`, `\t`). */
function unescapeTemplateLiteral(raw: string): string {
  return raw.replace(/\\(["\\nrt])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
  );
}

/**
 * Strip `expression` wrappers (including parentheses) down to the node that
 * says what the expression *is*. An expression with several named children
 * (`aws_s3_bucket.logs.id` is `variable_expr` + `get_attr`s) is returned as
 * is — it is a reference, not a literal.
 */
function unwrapExpression(expr: Node): Node {
  let current = expr;
  while (current.type === 'expression') {
    const named = current.namedChildren.filter((c): c is Node => !!c);
    if (named.length !== 1) return current;
    current = named[0];
  }
  return current;
}

/** A `literal_value` node → string | number | boolean | null, or a placeholder when it is none of those. */
function projectLiteral(literal: Node, expr: Node): unknown {
  const child = literal.namedChildren.find((c): c is Node => !!c);
  if (!child) return exprPlaceholder(expr);
  switch (child.type) {
    case 'string_lit':
      return projectedString(unescapeTemplateLiteral(stringLitValue(child)));
    case 'numeric_lit': {
      const value = Number(child.text);
      return Number.isFinite(value) ? value : exprPlaceholder(expr);
    }
    case 'bool_lit':
      return child.text === 'true';
    case 'null_lit':
      return null;
    default:
      return exprPlaceholder(expr);
  }
}

/**
 * Project one expression at nesting `depth` (the depth of the value itself;
 * `body` is depth 1, its values depth 2). Beyond the cap everything is a
 * placeholder, so the projection is bounded whatever the file does.
 */
function projectExpr(expr: Node, depth: number): unknown {
  if (depth > ATTRS_MAX_DEPTH) return exprPlaceholder(expr);
  const node = unwrapExpression(expr);
  switch (node.type) {
    case 'literal_value':
      return projectLiteral(node, expr);
    case 'collection_value': {
      const inner = node.namedChildren.find((c): c is Node => !!c && (c.type === 'tuple' || c.type === 'object'));
      if (inner?.type === 'tuple') return projectTuple(inner, depth);
      if (inner?.type === 'object') return projectObjectLiteral(inner, depth);
      return exprPlaceholder(expr);
    }
    case 'operation': {
      // `-1` parses as a unary operation over a numeric literal; it is still a
      // literal number (`from_port = -1`), not something to abstain on.
      const unary = node.namedChildren.find((c): c is Node => !!c && c.type === 'unary_operation');
      if (unary && unary.text.startsWith('-')) {
        const operands = unary.namedChildren.filter((c): c is Node => !!c);
        const literal = operands.length === 1 && operands[0].type === 'literal_value' ? operands[0] : null;
        const numeric = literal?.namedChildren.find((c): c is Node => !!c && c.type === 'numeric_lit');
        if (numeric) {
          const value = -Number(numeric.text);
          if (Number.isFinite(value)) return value;
        }
      }
      return exprPlaceholder(expr);
    }
    default:
      return exprPlaceholder(expr);
  }
}

/** `[a, b, …]` → array, capped. */
function projectTuple(tuple: Node, depth: number): unknown[] {
  const out: unknown[] = [];
  for (const child of tuple.namedChildren) {
    if (child?.type !== 'expression') continue;
    if (out.length >= ATTRS_MAX_ITEMS) break;
    out.push(projectExpr(child, depth + 1));
  }
  return out;
}

/** The key of an `object_elem`: a bare identifier, a quoted string, or the expression text. */
function objectElemKey(keyExpr: Node): string {
  const node = unwrapExpression(keyExpr);
  if (node.type === 'variable_expr') return node.text;
  if (node.type === 'literal_value') {
    const lit = node.namedChildren.find((c): c is Node => !!c && c.type === 'string_lit');
    if (lit) return unescapeTemplateLiteral(stringLitValue(lit));
  }
  return keyExpr.text.trim();
}

/** `{ k = v, … }` → object, capped; secret-shaped keys keep their presence, never their value. */
function projectObjectLiteral(object: Node, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const elem of object.namedChildren) {
    if (elem?.type !== 'object_elem') continue;
    const parts = elem.namedChildren.filter((c): c is Node => !!c && c.type === 'expression');
    if (parts.length < 2) continue;
    const key = objectElemKey(parts[0]);
    if (!key || Object.hasOwn(out, key)) continue;
    if (keys >= ATTRS_MAX_KEYS) break;
    out[key] = isSecretShapedKey(key) ? { redacted: true } : projectExpr(parts[1], depth + 1);
    keys++;
  }
  return out;
}

/**
 * Project a block body: attributes as values, nested blocks grouped by block
 * type into arrays in source order (`ingress: [{…}, {…}]`), `dynamic "x" {}`
 * recorded as `{ dynamic: "x" }` under `x`, and secret-shaped attribute keys
 * as `{ redacted: true }`. `depth` is the depth of the object being built.
 */
function projectBody(body: Node, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (child.type === 'attribute') {
      let name = '';
      let expr: Node | null = null;
      for (const part of child.namedChildren) {
        if (!part) continue;
        if (!name && part.type === 'identifier') name = part.text;
        else if (part.type === 'expression') expr = part;
      }
      // A repeated attribute is an HCL error; the first declaration wins here.
      if (!name || !expr || Object.hasOwn(out, name)) continue;
      if (keys >= ATTRS_MAX_KEYS) continue;
      out[name] = isSecretShapedKey(name) ? { redacted: true } : projectExpr(expr, depth + 1);
      keys++;
      continue;
    }
    if (child.type !== 'block') continue;
    const { type, labels } = blockHead(child);
    if (!type) continue;
    // The array sits at depth + 1 and each entry at depth + 2.
    if (depth + 2 > ATTRS_MAX_DEPTH) continue;
    let key = type;
    let entry: Record<string, unknown>;
    if (type === 'dynamic') {
      if (!labels[0]) continue;
      key = labels[0];
      entry = { dynamic: labels[0] };
    } else {
      const inner = blockBody(child);
      entry = inner ? projectBody(inner, depth + 2) : {};
    }
    const existing = out[key];
    if (Array.isArray(existing)) {
      if (existing.length < ATTRS_MAX_ITEMS) existing.push(entry);
    } else if (existing === undefined) {
      if (keys >= ATTRS_MAX_KEYS) continue;
      out[key] = [entry];
      keys++;
    }
    // An attribute already owns this key: the attribute wins, the block is dropped.
  }
  return out;
}

/** A literal string attribute of a body, or undefined when absent or not a plain string. */
function literalStringAttribute(body: Node | null, name: string): string | undefined {
  if (!body) return undefined;
  for (const attr of attributes(body)) {
    if (attr.name !== name || !attr.expr) continue;
    const value = projectExpr(attr.expr, ATTRS_MAX_DEPTH);
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * `required_providers` inside a `terraform` block. The nested shape is exactly
 * what the old regex could not read:
 *
 *     terraform { required_providers { aws = { source = "…" version = "…" } } }
 */
function extractRequiredProviders(
  terraformBlock: Node,
  lines: LineIndex,
  nodes: ToolchainNodeDraft[],
  seen: Set<string>,
): void {
  const body = blockBody(terraformBlock);
  if (!body) return;
  for (const nested of nestedBlocks(body)) {
    const { type } = blockHead(nested);
    if (type !== 'required_providers') continue;
    const inner = blockBody(nested);
    if (!inner) continue;
    for (const attr of attributes(inner)) {
      let source: string | undefined;
      let version: string | undefined;

      const objectAttrs = attr.expr ? collectObjectAttributes(attr.expr) : [];
      if (objectAttrs.length) {
        // Modern form: `<localName> = { source = "…", version = "…" }`.
        for (const { key, value } of objectAttrs) {
          if (key === 'source') source = value;
          else if (key === 'version') version = value;
        }
      } else if (attr.expr) {
        // Legacy version-only shorthand: `<localName> = "~> 2.0"`. Still valid,
        // and common in pre-0.13 estates. The source is implicit — an
        // unqualified local name resolves to the `hashicorp` namespace.
        const literal = findFirst(attr.expr, 'string_lit');
        if (literal) {
          version = stringLitValue(literal);
          source = `hashicorp/${attr.name}`;
        }
      }

      const address = `provider.${attr.name}`;
      if (seen.has(address)) continue;
      seen.add(address);
      nodes.push({
        kind: 'package',
        name: attr.name,
        qualifiedName: address,
        span: lines.span(attr.node.startIndex, attr.node.endIndex),
        signature: 'terraform.required_provider',
        doc: safeDoc(
          [source && `source ${source}`, version && `version ${version}`].filter(Boolean).join(', '),
        ),
        importance: 0.4,
        attrs: {
          name: attr.name,
          ...(source !== undefined ? { source: projectedString(source) } : {}),
          ...(version !== undefined ? { version: projectedString(version) } : {}),
        },
      });
    }
  }
}

/** `{ key = "value", … }` object literal → flat string pairs (string values only). */
function collectObjectAttributes(expr: Node): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const stack: Node[] = [expr];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'object_elem') {
      const key = node.namedChildren.find((c) => c?.type === 'expression');
      const rest = node.namedChildren.filter((c) => c?.type === 'expression');
      const valueNode = rest.length > 1 ? rest[1] : null;
      const keyText = key ? plainText(key) : '';
      const valueText = valueNode ? plainText(valueNode) : '';
      if (keyText) out.push({ key: keyText, value: valueText });
      continue;
    }
    for (const child of node.namedChildren) {
      if (child) stack.push(child);
    }
  }
  return out;
}

/** An expression's literal text, unquoted when it is a plain string. */
function plainText(expr: Node): string {
  const lit = findFirst(expr, 'string_lit');
  if (lit) return stringLitValue(lit);
  return expr.text.trim();
}

function findFirst(node: Node, type: string): Node | null {
  const stack: Node[] = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (current.type === type) return current;
    for (const child of current.namedChildren) {
      if (child) stack.push(child);
    }
  }
  return null;
}

/**
 * The `attrs` projection for a top-level block, keyed by block type:
 * `resource` / `data` → `{ type, name, mode, body }`; `module` and
 * `provider` → `{ name, source?, version? }` (present only when literal).
 * Variables and outputs carry none — they are not fact kinds.
 */
function blockAttrs(
  type: string,
  labels: string[],
  body: Node | null,
): { attrs?: Record<string, unknown> } {
  if (type === 'resource' || type === 'data') {
    return {
      attrs: {
        type: labels[0],
        name: labels[1],
        mode: type === 'data' ? 'data' : 'managed',
        body: body ? projectBody(body, 1) : {},
      },
    };
  }
  if (type === 'module' || type === 'provider') {
    const source = literalStringAttribute(body, 'source');
    const version = literalStringAttribute(body, 'version');
    return {
      attrs: {
        name: labels[0],
        ...(source !== undefined ? { source } : {}),
        ...(version !== undefined ? { version } : {}),
      },
    };
  }
  return {};
}

export const terraformExtractor: ToolchainExtractor = {
  format: 'terraform',

  matches(rel) {
    const lower = rel.toLowerCase();
    return lower.endsWith('.tf') || lower.endsWith('.tofu');
  },

  async extract(rel, source): Promise<ToolchainExtraction> {
    const parser = await toolchainParser('hcl');
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        warnings: [`${rel}: HCL grammar unavailable — no Terraform structure extracted`],
      };
    }

    const tree = parser.parse(source);
    if (!tree) return { nodes: [], edges: [], warnings: [`${rel}: HCL parse produced no tree`] };

    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];
    const warnings: string[] = [];
    const declared = new Set<string>();
    // Referenced-but-not-declared-here addresses are kept so the linker can
    // join them across files; the framework drops edges whose target never
    // resolves, so a cross-file reference is not silently turned into a node.
    const pendingEdges: ToolchainEdgeDraft[] = [];

    if (tree.rootNode.hasError) {
      warnings.push(`${rel}: HCL parse recovered from a syntax error — extraction may be partial`);
    }

    for (const block of topLevelBlocks(tree.rootNode)) {
      if (nodes.length >= TOOLCHAIN_NODES_PER_FILE_MAX) {
        warnings.push(`${rel}: stopped at ${TOOLCHAIN_NODES_PER_FILE_MAX} nodes`);
        break;
      }
      const { type, labels } = blockHead(block);

      if (type === 'terraform') {
        extractRequiredProviders(block, lines, nodes, declared);
        continue;
      }

      const spec = BLOCK_SPECS[type];
      if (!spec || labels.length < spec.labels) continue;

      const address = spec.address(labels);
      if (declared.has(address)) continue;
      declared.add(address);

      const body = blockBody(block);
      const attrs = body ? attributes(body) : [];

      // A module's `source` / `version` is the one piece of a Terraform block
      // that behaves like a dependency, so it belongs in the summary.
      const summaryParts: string[] = [];
      for (const attr of attrs) {
        if (attr.name === 'source' || attr.name === 'version' || attr.name === 'description') {
          const value = attr.expr ? plainText(attr.expr) : '';
          if (value) summaryParts.push(`${attr.name} ${value}`);
        }
      }

      nodes.push({
        kind: spec.kind,
        name: labels[labels.length - 1] ?? type,
        qualifiedName: address,
        span: lines.span(block.startIndex, block.endIndex),
        signature: spec.signature,
        doc: safeDoc(summaryParts.join(', ')),
        importance: spec.importance,
        ...blockAttrs(type, labels, body),
      });

      if (!body) continue;

      // Explicit `depends_on = [...]` and implicit interpolation references.
      const references = new Set<string>();
      for (const attr of attrs) {
        referencedAddresses(attr.expr, references);
      }
      // Nested blocks (`lifecycle`, `provisioner`, dynamic bodies) carry
      // references too — a resource referenced only from inside `lifecycle`
      // is still a dependency.
      const nestedStack = nestedBlocks(body);
      while (nestedStack.length) {
        const nested = nestedStack.pop();
        if (!nested) continue;
        const innerBody = blockBody(nested);
        if (!innerBody) continue;
        for (const attr of attributes(innerBody)) referencedAddresses(attr.expr, references);
        nestedStack.push(...nestedBlocks(innerBody));
      }

      references.delete(address); // a self-reference is not a dependency
      for (const target of [...references].sort()) {
        pendingEdges.push({ kind: 'depends_on', from: address, to: target, confidence: 1 });
      }
    }

    // Keep only edges whose target is declared in this same file. Cross-file
    // Terraform references are real, but resolving them needs the whole
    // module's file set — that is the linker's job, not this extractor's.
    for (const edge of pendingEdges) {
      if (declared.has(edge.to)) edges.push(edge);
    }

    return { nodes, edges, warnings };
  },
};
