/**
 * Interface / service bridge edges (Fusion Runtime Phase 6).
 *
 * Conservative cross-member links from OpenAPI `$ref` paths, Docker Compose
 * `build` contexts, protobuf `import` statements, and GraphQL schema
 * `#import` / path references. Pure over injected file readers — no network.
 * Confidence stays modest so high-stakes capsules can filter via
 * high-confidence package edges.
 */

import * as path from 'node:path';
import {
  BRIDGE_EDGE_SCHEMA_VERSION,
  type BridgeEdge,
  type BridgeMember,
} from './bridge-edges.js';
import { repositoryIdFromRoot } from './paths.js';

export type InterfaceBridgeKind =
  | 'openapi-ref'
  | 'compose-service'
  | 'protobuf-import'
  | 'graphql-ref';

export interface InterfaceBridgeFs {
  /** Read UTF-8 text or null if missing. */
  readFile(absPath: string): string | null;
  /** List file basenames under a directory (non-recursive). */
  readdir(absPath: string): string[];
  /** True when path is a directory. */
  isDirectory(absPath: string): boolean;
}

/**
 * Discover OpenAPI / Compose / protobuf / GraphQL bridges among federation members.
 * Deterministic sort: fromRoot, toRoot, kind, evidence.
 */
export function discoverInterfaceBridges(
  members: BridgeMember[],
  fs: InterfaceBridgeFs,
  options: { minConfidence?: number; maxFilesPerMember?: number } = {},
): BridgeEdge[] {
  const min = options.minConfidence ?? 0;
  const maxFiles = options.maxFilesPerMember ?? 40;
  const resolved = members.map((m) => ({
    root: path.resolve(m.root),
    repositoryId: m.repositoryId ?? repositoryIdFromRoot(m.root),
  }));

  const edges: BridgeEdge[] = [];
  const seen = new Set<string>();

  const push = (edge: BridgeEdge): void => {
    if (edge.confidence < min) return;
    if (edge.fromRoot === edge.toRoot) return;
    const key = `${edge.fromRepositoryId}->${edge.toRepositoryId}:${edge.kind}:${edge.evidence}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const from of resolved) {
    const files = listCandidateFiles(from.root, fs, maxFiles);
    for (const file of files) {
      const rel = path.relative(from.root, file).replace(/\\/g, '/');
      const raw = fs.readFile(file);
      if (!raw) continue;

      if (isOpenApiCandidate(rel, raw)) {
        for (const refPath of extractOpenApiRefs(raw)) {
          const target = resolvePathToMember(from.root, refPath, resolved);
          if (!target || target.root === from.root) continue;
          push({
            schemaVersion: BRIDGE_EDGE_SCHEMA_VERSION,
            fromRepositoryId: from.repositoryId,
            toRepositoryId: target.repositoryId,
            fromRoot: from.root,
            toRoot: target.root,
            kind: 'openapi-ref',
            confidence: 0.7,
            evidence: `openapi $ref in ${rel} → ${refPath}`,
          });
        }
      }

      if (isComposeCandidate(rel)) {
        for (const ctx of extractComposeBuildContexts(raw)) {
          const target = resolvePathToMember(from.root, ctx, resolved);
          if (!target || target.root === from.root) continue;
          push({
            schemaVersion: BRIDGE_EDGE_SCHEMA_VERSION,
            fromRepositoryId: from.repositoryId,
            toRepositoryId: target.repositoryId,
            fromRoot: from.root,
            toRoot: target.root,
            kind: 'compose-service',
            confidence: 0.75,
            evidence: `compose build context in ${rel} → ${ctx}`,
          });
        }
      }

      if (isProtoCandidate(rel)) {
        for (const imp of extractProtoImports(raw)) {
          const target = resolveProtoImportToMember(from.root, imp, resolved, fs);
          if (!target || target.root === from.root) continue;
          push({
            schemaVersion: BRIDGE_EDGE_SCHEMA_VERSION,
            fromRepositoryId: from.repositoryId,
            toRepositoryId: target.repositoryId,
            fromRoot: from.root,
            toRoot: target.root,
            kind: 'protobuf-import',
            confidence: 0.72,
            evidence: `protobuf import in ${rel} → ${imp}`,
          });
        }
      }

      if (isGraphqlCandidate(rel, raw)) {
        for (const refPath of extractGraphqlRefs(raw)) {
          const target = resolvePathToMember(from.root, refPath, resolved);
          if (!target || target.root === from.root) continue;
          push({
            schemaVersion: BRIDGE_EDGE_SCHEMA_VERSION,
            fromRepositoryId: from.repositoryId,
            toRepositoryId: target.repositoryId,
            fromRoot: from.root,
            toRoot: target.root,
            kind: 'graphql-ref',
            confidence: 0.68,
            evidence: `graphql import in ${rel} → ${refPath}`,
          });
        }
      }
    }
  }

  return edges.sort(
    (a, b) =>
      a.fromRoot.localeCompare(b.fromRoot) ||
      a.toRoot.localeCompare(b.toRoot) ||
      a.kind.localeCompare(b.kind) ||
      a.evidence.localeCompare(b.evidence),
  );
}

// ── file discovery ─────────────────────────────────────────────────────────

function listCandidateFiles(root: string, fs: InterfaceBridgeFs, maxFiles: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 4) return;
    let names: string[];
    try {
      names = fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (out.length >= maxFiles) return;
      if (
        name === 'node_modules' ||
        name === '.git' ||
        name === 'dist' ||
        name === 'build' ||
        name === 'coverage' ||
        name === '.next'
      ) {
        continue;
      }
      const abs = path.join(dir, name);
      if (fs.isDirectory(abs)) {
        walk(abs, depth + 1);
        continue;
      }
      const lower = name.toLowerCase();
      if (
        lower.endsWith('.proto') ||
        lower.endsWith('.graphql') ||
        lower.endsWith('.gql') ||
        lower.endsWith('.yaml') ||
        lower.endsWith('.yml') ||
        lower.endsWith('.json') ||
        lower.includes('openapi') ||
        lower.includes('swagger') ||
        lower.includes('compose')
      ) {
        out.push(abs);
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

// ── OpenAPI ────────────────────────────────────────────────────────────────

function isOpenApiCandidate(rel: string, raw: string): boolean {
  const lower = rel.toLowerCase();
  if (lower.includes('openapi') || lower.includes('swagger')) return true;
  if (/"openapi"\s*:/.test(raw) || /openapi:\s*['"]?\d/.test(raw)) return true;
  if (/"swagger"\s*:/.test(raw) || /swagger:\s*['"]?\d/.test(raw)) return true;
  return false;
}

/** Extract relative $ref / $refs that look like file paths (not #/components). */
export function extractOpenApiRefs(raw: string): string[] {
  const out = new Set<string>();
  // JSON: "$ref": "../other/foo.yaml"
  const jsonRef = /"\$ref"\s*:\s*"([^"#][^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = jsonRef.exec(raw)) !== null) {
    if (m[1] && !m[1].startsWith('http')) out.add(m[1]);
  }
  // YAML: $ref: ../other/foo.yaml  or  $ref: '../other/foo.yaml'
  const yamlRef = /\$ref:\s*['"]?([^'"#\s][^'"\s]*)/g;
  while ((m = yamlRef.exec(raw)) !== null) {
    if (m[1] && !m[1].startsWith('http') && !m[1].startsWith('#')) out.add(m[1]);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// ── Compose ────────────────────────────────────────────────────────────────

function isComposeCandidate(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return (
    base === 'docker-compose.yml' ||
    base === 'docker-compose.yaml' ||
    base === 'compose.yml' ||
    base === 'compose.yaml' ||
    base.includes('docker-compose')
  );
}

/**
 * Pull `build: <path>` and `build:\n  context: <path>` from compose-ish YAML.
 * Minimal parser — no full YAML dependency.
 */
export function extractComposeBuildContexts(raw: string): string[] {
  const out = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // build: ./services/api
    const simple = line.match(/^\s*build:\s*['"]?([^'"#\s][^'"#]*?)['"]?\s*(?:#.*)?$/);
    if (simple?.[1] && !simple[1].startsWith('{') && !/^\s*$/.test(simple[1])) {
      const v = simple[1].trim();
      if (v && v !== 'null' && !v.includes(':')) out.add(v);
      continue;
    }
    // build:
    //   context: ../lib
    if (/^\s*build:\s*$/.test(line) || /^\s*build:\s*\{\s*$/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const ctx = (lines[j] ?? '').match(/^\s*context:\s*['"]?([^'"#\s][^'"#]*?)['"]?\s*(?:#.*)?$/);
        if (ctx?.[1]) {
          out.add(ctx[1].trim());
          break;
        }
        // left the build block
        if (/^\S/.test(lines[j] ?? '') || /^\s{0,2}\w/.test(lines[j] ?? '')) {
          // allow nested keys with more indent
          if ((lines[j] ?? '').match(/^\s{0,2}\S/) && !(lines[j] ?? '').match(/^\s{4,}/)) break;
        }
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// ── Protobuf ───────────────────────────────────────────────────────────────

function isProtoCandidate(rel: string): boolean {
  return rel.toLowerCase().endsWith('.proto');
}

// ── GraphQL ────────────────────────────────────────────────────────────────

function isGraphqlCandidate(rel: string, raw: string): boolean {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.graphql') || lower.endsWith('.gql')) return true;
  if (lower.includes('schema') && /#\s*import\b/.test(raw)) return true;
  return false;
}

/**
 * GraphQL import forms: `#import "./user.graphql"`, `#import * from "../shared/x.graphql"`.
 */
export function extractGraphqlRefs(raw: string): string[] {
  const out = new Set<string>();
  const re = /#\s*import\s+(?:\*\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] && !m[1].startsWith('http')) out.add(m[1]);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** `import "foo/bar.proto";` and `import public "…"`. */
export function extractProtoImports(raw: string): string[] {
  const out = new Set<string>();
  const re = /^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] && !m[1].startsWith('google/protobuf/')) out.add(m[1]);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// ── path → member ──────────────────────────────────────────────────────────

function resolvePathToMember(
  fromRoot: string,
  relOrAbs: string,
  members: Array<{ root: string; repositoryId: string }>,
): { root: string; repositoryId: string } | null {
  let abs: string;
  try {
    abs = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(fromRoot, relOrAbs);
  } catch {
    return null;
  }
  // Prefer the most specific (longest) member root containing the path.
  let best: { root: string; repositoryId: string } | null = null;
  for (const m of members) {
    if (abs === m.root || abs.startsWith(m.root + path.sep)) {
      if (!best || m.root.length > best.root.length) best = m;
    }
  }
  return best;
}

function resolveProtoImportToMember(
  fromRoot: string,
  importPath: string,
  members: Array<{ root: string; repositoryId: string }>,
  fs: InterfaceBridgeFs,
): { root: string; repositoryId: string } | null {
  // Try relative to the importing package, then each member root as include path.
  const candidates = [
    path.resolve(fromRoot, importPath),
    ...members.map((m) => path.resolve(m.root, importPath)),
  ];
  for (const abs of candidates) {
    const hit = resolvePathToMember(fromRoot, abs, members);
    if (!hit) continue;
    // Prefer hits where the file exists under another member.
    if (fs.readFile(abs) !== null || pathIsUnder(abs, hit.root)) {
      if (hit.root !== path.resolve(fromRoot)) return hit;
    }
  }
  // Soft match: import path prefix equals a member basename (e.g. services/api/…)
  const parts = importPath.replace(/\\/g, '/').split('/');
  if (parts.length >= 2) {
    const prefix = parts[0]!;
    for (const m of members) {
      if (path.basename(m.root) === prefix && m.root !== path.resolve(fromRoot)) return m;
    }
  }
  return null;
}

function pathIsUnder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
