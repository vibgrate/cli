/**
 * Resolve a GGUF path for embedded llama.cpp — best-in-breed default path.
 *
 * Order (first hit wins):
 *  1. Explicit path (exists on disk)
 *  2. VG_CODE_MODEL_PATH / env override
 *  3. First-party weight store (catalogued ref or basename)
 *  4. Discovered local fleet (gguf / lm-studio)
 *
 * Pure path resolution — never downloads (install is `vg models install`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverModels, type LocalModel } from '../engine/models.js';
import { isWeightCached, listCachedWeights, lookupCatalog, weightPathForRef } from './weight-store.js';

export interface ResolveGgufOptions {
  /** Explicit --model-path or absolute path. */
  modelPath?: string;
  /** Model id / weightsRef (e.g. qwen2.5-coder-3b-q4_k_m.gguf or qwen2.5-coder:3b). */
  modelRef?: string;
  env?: NodeJS.ProcessEnv;
  discover?: () => LocalModel[];
}

export interface ResolveGgufResult {
  path: string;
  source: 'explicit' | 'env' | 'weight-store' | 'fleet' | 'catalog-path';
  ref?: string;
}

/**
 * Resolve an on-disk GGUF for local inference. Returns null when nothing is ready
 * (caller should fall back to Ollama or ask user to install).
 */
export function resolveGgufPath(opts: ResolveGgufOptions = {}): ResolveGgufResult | null {
  const env = opts.env ?? process.env;

  if (opts.modelPath && fs.existsSync(opts.modelPath) && fs.statSync(opts.modelPath).isFile()) {
    return { path: path.resolve(opts.modelPath), source: 'explicit', ref: opts.modelRef };
  }

  const envPath = env.VG_CODE_MODEL_PATH;
  if (envPath && fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
    return { path: path.resolve(envPath), source: 'env', ref: opts.modelRef };
  }

  const ref = opts.modelRef?.trim();
  if (ref) {
    // Direct weight-store hit.
    if (isWeightCached(ref, env)) {
      return { path: weightPathForRef(ref, env), source: 'weight-store', ref };
    }
    // Catalog basename may differ slightly from ollama-style refs.
    const catalog = lookupCatalog(ref);
    if (catalog && isWeightCached(catalog.ref, env)) {
      return { path: weightPathForRef(catalog.ref, env), source: 'weight-store', ref: catalog.ref };
    }
    // Ollama-style "name:tag" → try catalog aliases.
    const normalized = ref.includes(':')
      ? `${ref.replace(':', '-').replace(/\//g, '-')}-q4_k_m.gguf`
      : ref.endsWith('.gguf')
        ? ref
        : `${ref}.gguf`;
    if (isWeightCached(normalized, env)) {
      return { path: weightPathForRef(normalized, env), source: 'weight-store', ref: normalized };
    }
    const cat2 = lookupCatalog(normalized);
    if (cat2 && isWeightCached(cat2.ref, env)) {
      return { path: weightPathForRef(cat2.ref, env), source: 'weight-store', ref: cat2.ref };
    }
    // Absolute path-looking ref
    if ((ref.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ref)) && fs.existsSync(ref)) {
      return { path: path.resolve(ref), source: 'explicit', ref };
    }
  }

  // Any cached first-party weight (prefer matching ref substring).
  const cached = listCachedWeights(env);
  if (ref) {
    const hit = cached.find((w) => w.name.toLowerCase().includes(ref.toLowerCase().replace(/[:/]/g, '-')));
    if (hit) return { path: hit.path, source: 'weight-store', ref: hit.name };
  }

  // Fleet discovery: gguf / lm-studio paths.
  const fleet = (() => {
    try {
      return (opts.discover ?? discoverModels)();
    } catch {
      return [] as LocalModel[];
    }
  })();
  if (ref) {
    const want = ref.toLowerCase();
    const match = fleet.find(
      (m) =>
        (m.runtime === 'gguf' || m.runtime === 'lm-studio') &&
        (m.name.toLowerCase().includes(want) || m.path.toLowerCase().includes(want) || want.includes(m.name.toLowerCase())),
    );
    if (match && fs.existsSync(match.path)) {
      return { path: match.path, source: 'fleet', ref: match.name };
    }
  }
  const anyGguf = fleet.find((m) => (m.runtime === 'gguf' || m.runtime === 'lm-studio') && fs.existsSync(m.path));
  if (anyGguf) return { path: anyGguf.path, source: 'fleet', ref: anyGguf.name };

  // If only one weight in store, use it when no ref.
  if (!ref && cached.length === 1) {
    return { path: cached[0].path, source: 'weight-store', ref: cached[0].name };
  }

  return null;
}

/** Whether embedded llama.cpp is ready for this ref without a network install. */
export function embeddedLlamaReady(opts: ResolveGgufOptions = {}): boolean {
  return resolveGgufPath(opts) != null;
}
