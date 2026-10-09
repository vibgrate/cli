/**
 * Scripted check for issue #301. Runs the same `parseFiles` pool `vg build`
 * and `vg scan` use, then exits. The parent test asserts the process is gone
 * and that no parse worker is left in the process list.
 *
 *   tsx test/fixtures/parse-pool-harness.ts <crash|hang|budget> [worker_threads|child_process]
 */
import { fileURLToPath } from 'node:url';
import type { DiscoveredFile } from '../../src/engine/discover.js';
import { parseFiles } from '../../src/engine/pool.js';

const mode = process.argv[2] || 'crash';
const runtime = process.argv[3] === 'child_process' ? 'child_process' : 'worker_threads';
process.env.VG_POOL_WORKER_MODE = mode === 'crash' || mode === 'hang' ? mode : '';

const workerFile = fileURLToPath(new URL('./parse-pool-worker.mjs', import.meta.url));
const lang = { id: 'ts' } as DiscoveredFile['lang'];
const files: DiscoveredFile[] = ['b.ts', 'a.ts'].map((rel) => ({ rel, abs: rel, lang }));

let announced = false;
try {
  await parseFiles(files, {
    jobs: 2,
    workerFile,
    workerRuntime: runtime,
    memoryBudgetMb: mode === 'budget' ? 1 : 0,
    onProgress: () => {
      if (!announced && mode === 'hang') {
        announced = true;
        process.stdout.write('READY\n');
      }
    },
  });
  if (mode === 'hang' || mode === 'crash' || mode === 'budget') {
    process.stderr.write(`expected ${mode} to fail\n`);
    process.exit(2);
  }
  process.stdout.write('OK\n');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
