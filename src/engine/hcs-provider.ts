/**
 * Optional HCS engine seam for the `vg hcs` command group.
 *
 * The HCS engine is an OPTIONAL, separately installed local module
 * (`@vibgrate/hcs-engine`) that performs every HCS computation — fact
 * extraction, digest rendering, System Map building, the governance gate, and
 * model validation — inside a WASM sandbox. The CLI side is plumbing only:
 * read input → call the engine → write output / set exit code. No fact
 * parsing, scoring, diffing, or rendering ever happens here.
 *
 * Loading mirrors the relevance-provider seam:
 *  - `VIBGRATE_NO_KERNEL=1` disables the seam entirely.
 *  - `VIBGRATE_HCS_PATH` points at an engine module (a file, or a directory
 *    containing `index.js`).
 *  - Otherwise the default module location is probed:
 *    `$XDG_CACHE_HOME|~/.cache /vibgrate/modules/hcs/index.js`.
 * The module contract: it exports `createHcsEngine()` returning an object
 * whose methods are string-in/string-out mirrors of the WASM entry points.
 *
 * Unlike relevance (a silent enhancement), HCS commands REQUIRE the engine:
 * callers translate a `null` here into ExitCode.ENGINE_UNAVAILABLE (6) with an
 * actionable message — loud by design, so CI can never mistake "engine
 * missing" for a gate verdict.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { modulesBaseDir } from '../install/module-core.js';

/**
 * String-in/string-out mirror of the engine's WASM entry points. All results
 * and options cross the seam as JSON/NDJSON text — the CLI never interprets
 * fact content, only relays it. Optional methods may be absent from older
 * engines; commands that need one degrade with a clear message.
 */
export interface HcsEngine {
  version(): string;
  /** Render an NDJSON fact stream as md/json/html. */
  renderDigest(ndjson: string, optionsJson: string): string;
  /** Build the System Map (json/md/mermaid, optional consumer profile). */
  buildMap(ndjson: string, optionsJson: string): string;
  /** Diff two fact streams; returns the gate result in the requested format. */
  evaluateGate(beforeNdjson: string, afterNdjson: string, optionsJson: string): string;
  /** Comma-separated languages the engine extracts natively. */
  supportedLanguages?(): string;
  /** Extract facts from source text; request/response per the engine ABI. */
  extractFacts?(requestJson: string): string;
  /** Validate an NDJSON model; returns a ValidationReport as JSON. */
  validateLines?(linesJson: string): string;
  /**
   * Plan an incremental extraction: diff the current files (JSON array of
   * `{path, content|hash}`) against the `FileHashIndex` preamble of the
   * previous result stream. Returns the plan as JSON — extract
   * `added`+`changed` only; `mode` is "full" when the previous stream has no
   * index.
   */
  planExtract?(previousNdjson: string, currentFilesJson: string): string;
  /**
   * Merge the previous result stream with a fresh stream extracted from only
   * the changed/added files, reusing unchanged facts byte-for-byte and
   * stamping a fresh `FileHashIndex`. Returns `{ndjson, stats}` as JSON.
   */
  mergeExtract?(previousNdjson: string, freshNdjson: string, currentFilesJson: string): string;
}

function disabled(): boolean {
  const v = process.env.VIBGRATE_NO_KERNEL;
  return v === '1' || v === 'true';
}

/** Default install location for the optional HCS engine module (shared with
 *  the install flow in install/hcs-module.ts). */
export function hcsModuleDir(): string {
  return path.join(modulesBaseDir(), 'hcs');
}

function candidatePaths(): string[] {
  const custom = process.env.VIBGRATE_HCS_PATH;
  if (custom) {
    const p = path.resolve(custom);
    try {
      if (fs.statSync(p).isDirectory()) return [path.join(p, 'index.js')];
    } catch {
      /* fall through — treat as a file path */
    }
    return [p];
  }
  return [path.join(hcsModuleDir(), 'index.js')];
}

let cached: HcsEngine | null | undefined;

/** Reset the memoized engine (tests, and after install/remove). */
export function resetHcsEngineCache(): void {
  cached = undefined;
}

/**
 * Load the optional HCS engine. Memoized per process; returns `null` when
 * disabled, not installed, or the module fails to load or violates the
 * contract — callers turn `null` into an ENGINE_UNAVAILABLE error, never a
 * silent skip.
 */
export async function loadHcsEngine(): Promise<HcsEngine | null> {
  if (cached !== undefined) return cached;
  cached = null;
  if (disabled()) return cached;
  for (const p of candidatePaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = (await import(pathToFileURL(p).href)) as {
        createHcsEngine?: () => HcsEngine | Promise<HcsEngine>;
      };
      const engine = await mod.createHcsEngine?.();
      if (
        engine &&
        typeof engine.version === 'function' &&
        typeof engine.renderDigest === 'function' &&
        typeof engine.buildMap === 'function' &&
        typeof engine.evaluateGate === 'function'
      ) {
        cached = engine;
        return cached;
      }
    } catch {
      // A broken module reads as "no engine" — the command layer reports it
      // loudly with the install hint; it must never crash with a raw stack.
    }
  }
  return cached;
}
