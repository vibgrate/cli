/** graph.arch.json reader + module launcher. Never classifies in-process. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VgGraph } from '../../schema.js';
import { kernelDisabled } from '../../install/module-core.js';
import { haileModuleDir, haileModulePathOverride } from './haile-provider.js';
import type { HaileModuleSummary, HaileProfile, HaileSidecar, HaileSymbol } from './types.js';
import {
  DEFAULT_PROFILE,
  HAILE_ENGINE_VERSION,
  HAILE_IR,
  HAILE_MAGIC,
  HAILE_MAGIC_LEGACY,
  HAILE_TAXONOMY,
  HAILE_TAXONOMY_LEGACY,
  type HailePolicy,
} from './types.js';
import { architecturePolicyFor } from './policy-config.js';

function sidecarPathWithSuffix(graphPath: string, suffix: string): string {
  if (graphPath.endsWith('.json')) return `${graphPath.slice(0, -5)}${suffix}`;
  if (graphPath.endsWith('.snap')) return `${graphPath.slice(0, -5)}${suffix}`;
  return `${graphPath}${suffix}`;
}

/** `graph.arch.json` next to the graph — the public sidecar name. */
export function haileSidecarPathFor(graphPath: string): string {
  return sidecarPathWithSuffix(graphPath, '.arch.json');
}

/** `graph.haile.json` — the pre-rename name. Read for one release, never written. */
export function legacyHaileSidecarPathFor(graphPath: string): string {
  return sidecarPathWithSuffix(graphPath, '.haile.json');
}

export function deleteHaileSidecarFor(graphPath: string): void {
  for (const file of [haileSidecarPathFor(graphPath), legacyHaileSidecarPathFor(graphPath)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Installed module entry: VIBGRATE_ARCH_PATH (or the legacy VIBGRATE_HAILE_PATH) or the modules cache. */
function resolveHaileModuleEntry(): string | null {
  if (kernelDisabled()) return null;
  const custom = haileModulePathOverride();
  if (custom) {
    const p = path.resolve(custom);
    try {
      if (fs.statSync(p).isDirectory()) {
        const idx = path.join(p, 'index.js');
        return fs.existsSync(idx) ? idx : null;
      }
    } catch {
      /* treat as a file path */
    }
    return fs.existsSync(p) ? p : null;
  }
  const idx = path.join(haileModuleDir(), 'index.js');
  return fs.existsSync(idx) ? idx : null;
}

export function serializeSidecar(sidecar: HaileSidecar): string {
  return `${JSON.stringify(sidecar)}\n`;
}

/** Write an already-built classify document. Does not classify. */
export function writeSidecarDocument(sidecar: HaileSidecar, graphPath: string): string | null {
  try {
    const file = haileSidecarPathFor(graphPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializeSidecar(sidecar));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

/**
 * Derive the classify file from an in-memory graph by launching the
 * installed module. Returns null when the module is missing — never a
 * TypeScript lexicon copy, never a PATH/`HAILE_BIN` fallback.
 */
export function writeHaileSidecarFor(
  graph: VgGraph,
  graphPath: string,
  options: { profile?: HaileProfile; policy?: HailePolicy; root?: string } = {},
): string | null {
  try {
    const entry = resolveHaileModuleEntry();
    if (!entry) return null;
    const file = haileSidecarPathFor(graphPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const profile = options.profile ?? DEFAULT_PROFILE;
    // The policy comes from the flag, then the environment, then
    // `.vibgrate/architecture.toml` next to the graph's repository root.
    const policy = architecturePolicyFor(options.root ?? path.dirname(path.dirname(graphPath)), options.policy);
    const result = spawnSync(
      process.execPath,
      [entry, 'sidecar', '--stdin', '--out', file, '--profile', profile, '--policy', policy],
      {
        input: JSON.stringify(graph),
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.status !== 0) return null;
    if (!fs.existsSync(file)) return null;
    return file;
  } catch {
    return null;
  }
}

export function readHaileSidecar(
  graphPath: string,
  expect?: { corpusHash?: string; engineVersion?: string },
): HaileSidecar | null {
  try {
    let file = haileSidecarPathFor(graphPath);
    if (!fs.existsSync(file)) {
      // A graph classified before the rename; the next build replaces it.
      file = legacyHaileSidecarPathFor(graphPath);
      if (!fs.existsSync(file)) return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HaileSidecar;
    if (parsed.magic !== HAILE_MAGIC && parsed.magic !== HAILE_MAGIC_LEGACY) return null;
    if (parsed.taxonomy !== HAILE_TAXONOMY && parsed.taxonomy !== HAILE_TAXONOMY_LEGACY) return null;
    if (expect?.corpusHash && parsed.corpus_hash !== expect.corpusHash) return null;
    if (expect?.engineVersion && parsed.engine_version !== expect.engineVersion) return null;
    if (!Array.isArray(parsed.symbols)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function findHaileSymbol(sidecar: HaileSidecar | null, nodeId: string): HaileSymbol | undefined {
  return sidecar?.symbols.find((s) => s.node_id === nodeId);
}

/** Test helper: a schema-valid empty classify document. Not a classifier. */
export function emptySidecar(corpusHash = '', profile: HaileProfile = DEFAULT_PROFILE): HaileSidecar {
  return {
    magic: HAILE_MAGIC,
    taxonomy: HAILE_TAXONOMY,
    ir: HAILE_IR,
    corpus_hash: corpusHash,
    engine_version: HAILE_ENGINE_VERSION,
    profile,
    symbols: [],
  };
}

export type { HaileModuleSummary };
