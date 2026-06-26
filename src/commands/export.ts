import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { exportGraph, formatForExt, type ExportFormat } from '../engine/export.js';
import { inventory } from '../engine/drift.js';
import { discoverModels } from '../engine/models.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { usageError } from '../util/exit.js';
import { c, info, out } from '../util/output.js';

/**
 * `vg export <file>` (VG-CLI-SPEC §4.2) — one verb, format inferred from the
 * extension: json · ndjson · graphml · dot · cypher · md · html · cdx.json
 * (CycloneDX SBOM/AI-BOM) · spdx.json. `-` writes to stdout.
 */
export function registerExport(program: Command): void {
  const cmd = program
    .command('export')
    .description('export the map (format inferred: json|ndjson|graphml|dot|cypher|md|html|cdx.json|spdx.json)')
    .argument('[file]', 'target file (or - for stdout)', 'map.json')
    .action(function (this: Command, file: string) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const root = rootOf(global);

      const format = detectFormat(file);
      if (!format) throw usageError(`unknown export format for "${file}"`);

      const needsDeps = format === 'cyclonedx' || format === 'spdx';
      const content = exportGraph(format, {
        graph,
        deps: needsDeps ? inventory(root).records : undefined,
        models: needsDeps && !global.local ? discoverModels() : undefined,
        generatedAt: graph.generatedAt,
      });

      if (file === '-') {
        out(content.trimEnd());
        return;
      }
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, content);
      info(`${c.green('✔')} wrote ${file} ${c.dim(`(${format})`)}`);
    });
  applyGlobalOptions(cmd);
}

function detectFormat(file: string): ExportFormat | null {
  const lower = file.toLowerCase();
  if (lower.endsWith('.cdx.json')) return 'cyclonedx';
  if (lower.endsWith('.spdx.json')) return 'spdx';
  if (file === '-') return 'json';
  return formatForExt(path.extname(file));
}
