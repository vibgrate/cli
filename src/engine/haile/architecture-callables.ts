/**
 * Project usable classify-file symbols onto the Architecture panel wire.
 * File-layer stays the interlingua. These rows are omitted when the module
 * did not run, when a symbol is malformed, or when the band is abstain.
 */
import { resolveGraphPath } from '../artifacts.js';
import { isUsableHaileSymbol } from './format.js';
import { readHaileSidecar } from './sidecar.js';

export interface ArchitectureCallableWire {
  file: string;
  name: string;
  role: string;
  purposes: string[];
  intent: string;
  layer?: string;
  /** Boundary findings from the module's policy pack (additive). `line` is the symbol's own offending call, absent when inherited. */
  findings?: { rule: string; severity: string; message: string; line?: number }[];
}

const CALLABLE_CAP = 200;

export interface LoadArchitectureCallablesOptions {
  /**
   * The graph's `provenance.corpusHash`. When given, a sidecar bound to a
   * different corpus is treated as absent (stale → omit, never a stale row on
   * the panel). Pass it whenever the caller holds the graph.
   */
  corpusHash?: string;
  /** Override the map location (the `--graph` flag); defaults to the resolved graph path. */
  graphPath?: string;
}

export function loadArchitectureCallables(
  root: string,
  scopePath?: string,
  options: LoadArchitectureCallablesOptions = {},
): ArchitectureCallableWire[] | undefined {
  const sidecar = readHaileSidecar(options.graphPath ?? resolveGraphPath(root), {
    corpusHash: options.corpusHash,
  });
  if (!sidecar?.symbols.length) return undefined;
  const prefix =
    scopePath && scopePath !== '.' && scopePath !== '__repo__'
      ? scopePath.replace(/\\/g, '/').replace(/\/+$/, '')
      : '';
  const rows: ArchitectureCallableWire[] = [];
  for (const symbol of sidecar.symbols) {
    if (!isUsableHaileSymbol(symbol)) continue;
    if (symbol.role.band === 'abstain' || symbol.role.primary === 'unknown') continue;
    const file = symbol.file_path.replace(/\\/g, '/');
    if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) continue;
    const purposes = symbol.purposes
      .filter((p) => p && typeof p.purpose === 'string' && p.purpose)
      .map((p) => p.purpose);
    const row: ArchitectureCallableWire = {
      file,
      name: symbol.name,
      role: symbol.role.primary,
      purposes,
      intent: symbol.intent.text,
    };
    if (symbol.file_layer) row.layer = symbol.file_layer;
    if (Array.isArray(symbol.findings) && symbol.findings.length) {
      row.findings = symbol.findings
        .filter((f) => f && typeof f.rule === 'string' && typeof f.message === 'string')
        .slice(0, 4)
        .map((f) => ({
          rule: f.rule,
          severity: typeof f.severity === 'string' ? f.severity : 'warn',
          message: f.message,
          ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
        }));
    }
    rows.push(row);
    if (rows.length >= CALLABLE_CAP) break;
  }
  return rows.length ? rows : undefined;
}

/** Symbol count of a usable (magic + corpus-bound) sidecar, for the module-status footnote. */
export function architectureSidecarSummary(
  root: string,
  options: LoadArchitectureCallablesOptions = {},
): { engineVersion: string; symbolCount: number; policy: string } | undefined {
  const sidecar = readHaileSidecar(options.graphPath ?? resolveGraphPath(root), {
    corpusHash: options.corpusHash,
  });
  if (!sidecar) return undefined;
  return { engineVersion: sidecar.engine_version, symbolCount: sidecar.symbols.length, policy: typeof sidecar.policy === 'string' ? sidecar.policy : 'hexagonal-v1' };
}
