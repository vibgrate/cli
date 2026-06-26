import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { buildEnvelope } from '../engine/push.js';
import { stableStringify } from '../engine/serialize.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg push` (VG-CLI-SPEC §5) — the deferred, decoupled cloud seam. In the open
 * CLI it assembles + redacts the upload envelope and prints a notice; it performs
 * **no network upload** (nothing leaves your machine). `--out` writes the
 * redacted envelope for inspection; `--json` prints it. Exit 0.
 */
export function registerPush(program: Command): void {
  const cmd = program
    .command('push')
    .description('(deferred, decoupled) prepare the cloud upload envelope — no upload in the open CLI')
    .option('--out <file>', 'write the redacted envelope to a file for inspection')
    .option('--scan-ingest-id <id>', 'correlate to a scan push at the same commit')
    .action(function (this: Command, opts: { out?: string; scanIngestId?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const { graph } = requireGraph(global);
      const envelope = buildEnvelope(root, graph, opts.scanIngestId);

      if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(opts.out, `${stableStringify(envelope, 2)}\n`);
        info(`${c.green('✔')} wrote redacted envelope → ${opts.out}`);
      }

      if (global.json) {
        json({ uploaded: false, envelope });
        return;
      }

      info(`${c.cyan('vg push')} · ${c.dim('decoupled cloud seam — specified, not built in the open CLI')}`);
      info(`  prepared a redacted graph envelope for ${envelope.vcs.branch}@${envelope.vcs.shortSha}`);
      info(c.green('  nothing left your machine.') + c.dim(' Drift-over-time, governance and portfolio are the Vibgrate platform.'));
      info(c.dim('  use --out <file> to inspect the envelope, or --json to print it'));
    });
  applyGlobalOptions(cmd);
}
