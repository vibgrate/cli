/**
 * Identifier trie for future logit masking (Approach B sampler hooks).
 *
 * Built from ActiveGraph symbol short/qualified names so constrained generation
 * can refuse identifiers that do not exist in the repo. Pure data structure —
 * no model binding required to unit-test.
 */

export interface TrieNode {
  children: Map<string, TrieNode>;
  terminal: boolean;
}

export function createTrieNode(): TrieNode {
  return { children: new Map(), terminal: false };
}

export function trieInsert(root: TrieNode, word: string): void {
  let node = root;
  for (const ch of word) {
    let next = node.children.get(ch);
    if (!next) {
      next = createTrieNode();
      node.children.set(ch, next);
    }
    node = next;
  }
  node.terminal = true;
}

export function trieHas(root: TrieNode, word: string): boolean {
  let node = root;
  for (const ch of word) {
    const next = node.children.get(ch);
    if (!next) return false;
    node = next;
  }
  return node.terminal;
}

export function trieHasPrefix(root: TrieNode, prefix: string): boolean {
  let node = root;
  for (const ch of prefix) {
    const next = node.children.get(ch);
    if (!next) return false;
    node = next;
  }
  return true;
}

/** Completions that extend `prefix` (capped). */
export function trieComplete(root: TrieNode, prefix: string, limit = 32): string[] {
  let node = root;
  for (const ch of prefix) {
    const next = node.children.get(ch);
    if (!next) return [];
    node = next;
  }
  const out: string[] = [];
  const walk = (n: TrieNode, acc: string): void => {
    if (out.length >= limit) return;
    if (n.terminal) out.push(acc);
    for (const [ch, child] of [...n.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      walk(child, acc + ch);
      if (out.length >= limit) return;
    }
  };
  walk(node, prefix);
  return out;
}

export interface GraphLikeForTrie {
  nodes: Array<{ name?: string; qualifiedName?: string; id?: string }>;
}

/**
 * Build a trie of symbol identifiers from a graph. Includes short names and
 * the last segment of qualified names (e.g. `Foo` from `pkg.Foo`).
 */
export function buildIdentifierTrieFromGraph(graph: GraphLikeForTrie): TrieNode {
  const root = createTrieNode();
  const seen = new Set<string>();
  const add = (s: string | undefined): void => {
    const t = (s ?? '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    trieInsert(root, t);
    // Path segments for dotted / slash-qualified names (e.g. pkg.util.Foo → util, Foo).
    for (const part of t.split(/[./:#]/)) {
      const p = part.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      trieInsert(root, p);
    }
  };
  for (const n of graph.nodes) {
    add(n.name);
    add(n.qualifiedName);
    add(n.id);
  }
  return root;
}

/** Characters allowed to continue after `prefix` under the trie (for logit mask). */
export function trieAllowedNextChars(root: TrieNode, prefix: string): string[] {
  let node = root;
  for (const ch of prefix) {
    const next = node.children.get(ch);
    if (!next) return [];
    node = next;
  }
  return [...node.children.keys()].sort();
}

/**
 * Enumerate terminal words in the trie (capped). Used to positively bias known
 * graph identifiers when building a TokenBias without scanning the full vocab.
 */
export function trieEnumerateWords(root: TrieNode, limit = 4096): string[] {
  const out: string[] = [];
  const walk = (n: TrieNode, acc: string): void => {
    if (out.length >= limit) return;
    if (n.terminal && acc.length > 0) out.push(acc);
    for (const [ch, child] of [...n.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      walk(child, acc + ch);
      if (out.length >= limit) return;
    }
  };
  walk(root, '');
  return out;
}
