import type { Node } from 'web-tree-sitter';
import { toolchainParser } from './grammars.js';
import { LineIndex, safeDoc, TOOLCHAIN_NODES_PER_FILE_MAX } from './util.js';
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
