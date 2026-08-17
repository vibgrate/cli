import { Query, type Language, type Node } from 'web-tree-sitter';
import {
  catalogForLanguage,
  sourceHasRoleNeedle,
  type AstRoleCatalogEntry,
} from '../core-open/scanners/architecture/packs/ast-role-catalog.js';
import type { AstRoleHit } from '../core-open/scanners/architecture/ast-roles.js';
import type { FileParse } from './types.js';
import { loadCache } from './cache.js';
import { grammarSetVersion } from './grammars.js';
import { toolchainGrammarSetVersion } from './toolchain/grammars.js';
import { VERSION } from '../version.js';

/**
 * Run pack-scoped role queries against the tree `buildGraph` already paid for.
 * A compile miss falls back to the needle matcher — never a second parse.
 */

const compiledCache = new Map<string, Query | null>();

function compile(lang: Language, langId: string, source: string): Query | null {
  const key = `${langId}::${source}`;
  if (compiledCache.has(key)) return compiledCache.get(key) ?? null;
  let q: Query | null = null;
  try {
    q = new Query(lang, source);
  } catch {
    q = null;
  }
  compiledCache.set(key, q);
  return q;
}

function entryHits(
  lang: Language,
  langId: string,
  root: Node,
  source: string,
  entry: AstRoleCatalogEntry,
): boolean {
  const compiled = compile(lang, langId, entry.query);
  if (!compiled) return sourceHasRoleNeedle(source, entry.needle);
  try {
    return compiled.captures(root).length > 0;
  } catch {
    return sourceHasRoleNeedle(source, entry.needle);
  }
}

export function extractAstRolesFromTree(
  _rel: string,
  langId: string,
  language: Language,
  root: Node,
  source: string,
): FileParse['roles'] {
  const catalog = catalogForLanguage(langId);
  if (catalog.length === 0) return undefined;
  const hits: NonNullable<FileParse['roles']> = [];
  for (const entry of catalog) {
    if (!entryHits(language, langId, root, source, entry)) continue;
    hits.push({
      role: entry.role,
      layer: entry.layer,
      confidence: entry.confidence,
      signal: entry.signal,
      packId: entry.packId,
    });
  }
  if (hits.length === 0) return undefined;
  hits.sort((a, b) =>
    b.confidence - a.confidence
    || a.packId.localeCompare(b.packId)
    || a.role.localeCompare(b.role),
  );
  return hits;
}

export function fileRolesFromParses(parses: readonly FileParse[]): AstRoleHit[] {
  const hits: AstRoleHit[] = [];
  for (const parse of parses) {
    if (!parse.roles?.length) continue;
    const rel = (parse.rel || '.').replace(/\\/g, '/');
    for (const role of parse.roles) {
      hits.push({
        filePath: rel,
        role: role.role,
        layer: role.layer,
        confidence: role.confidence,
        signal: role.signal,
        packId: role.packId,
      });
    }
  }
  return hits;
}

/**
 * Recover architecture role hits from the versioned parse cache.
 * Used by the LSP when the map is loaded from disk (no in-process build).
 */
export function fileRolesFromParseCache(root: string): AstRoleHit[] {
  const grammars = `${grammarSetVersion()}+${toolchainGrammarSetVersion()}`;
  const cache = loadCache(root, { toolVersion: VERSION, grammars });
  return fileRolesFromParses(cache.allParses());
}
