/**
 * Public seam for the HAILE Fast kernel. Mirrors engine/hcs-provider.ts:
 * a capability interface with no lexicon, no weights, no softmax.
 * The CLI loads the separately installed module (`@vibgrate/haile`) from
 * the modules cache and sanitises every result at its own trust boundary.
 *
 *   - VIBGRATE_NO_KERNEL=1 disables the seam.
 *   - VIBGRATE_HAILE_PATH points at a provider module (file, or a directory
 *     containing index.js).
 *   - Otherwise `$VIBGRATE_MODULE_DIR|~/.cache/vibgrate/modules/haile/index.js`.
 *
 * Absent / failed / privacy mode → null. Never a TS lexicon.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { modulesBaseDir } from '../../install/module-core.js';

export type HaileProfile = 'strict' | 'balanced' | 'exploratory';

export interface HaileClassifyInput {
  name: string;
  path: string;
  symbolKind?: string;
  fileKind?: string;
  calls?: readonly string[];
  types?: readonly string[];
  idents?: readonly string[];
  profile?: HaileProfile;
  // Optional richer evidence understood by module kernels ≥ 0.3.0.
  qualifiedName?: string;
  doc?: string;
  signature?: string;
  params?: readonly string[];
  returnType?: string;
  calleePaths?: readonly string[];
  imports?: readonly string[];
  astRole?: string;
  effects?: Readonly<Record<string, number | readonly string[]>>;
  duties?: readonly unknown[];
}

export interface HaileClassification {
  primary: string;
  confidence: number;
  band: string;
  alternatives: { role: string; confidence: number }[];
  purposes: { purpose: string; confidence: number }[];
  intent: { text: string; verbs: string[]; objects: string[] };
  evidence: { kind: string; signal: string; weight: number }[];
  findings?: { rule: string; severity: string; message: string }[];
}

export interface HaileProvider {
  version(): string;
  classify(input: HaileClassifyInput): HaileClassification | null;
}

function disabled(): boolean {
  const v = process.env.VIBGRATE_NO_KERNEL;
  return v === '1' || v === 'true';
}

/** Default install location (shared with install/haile-module.ts). */
export function haileModuleDir(): string {
  return path.join(modulesBaseDir(), 'haile');
}

function candidatePaths(): string[] {
  const custom = process.env.VIBGRATE_HAILE_PATH;
  if (custom) {
    const p = path.resolve(custom);
    try {
      if (fs.statSync(p).isDirectory()) return [path.join(p, 'index.js')];
    } catch {
      /* fall through — treat as a file path */
    }
    return [p];
  }
  return [path.join(haileModuleDir(), 'index.js')];
}

let cached: HaileProvider | null | undefined;

export function resetHaileProviderCache(): void {
  cached = undefined;
}

/**
 * Load the optional HAILE provider. Memoized; returns null when disabled,
 * not installed, or the module fails the contract. Callers treat null as
 * "do not write the classify file" — never as a guess.
 */
export async function loadHaileProvider(): Promise<HaileProvider | null> {
  if (cached !== undefined) return cached;
  cached = null;
  if (disabled()) return cached;
  for (const p of candidatePaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = (await import(pathToFileURL(p).href)) as {
        createHaileProvider?: () => HaileProvider | null;
      };
      const provider = mod.createHaileProvider?.();
      if (provider && typeof provider.version === 'function' && typeof provider.classify === 'function') {
        cached = provider;
        return cached;
      }
    } catch {
      /* broken module reads as absent */
    }
  }
  return cached;
}
