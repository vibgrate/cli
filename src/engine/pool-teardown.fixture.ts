/**
 * Child entry for the parse-pool teardown check. Spawned by
 * pool-teardown.test.ts — not a test, and not a CLI command.
 *
 * argv: <hang|fail|ok> <worker module>
 */
import type { DiscoveredFile } from './discover.js';
import type { LanguageDef } from './languages.js';
import { parseFiles } from './pool.js';

const mode = process.argv[2];
const workerFile = process.argv[3];
if (!mode || !workerFile) {
  process.stderr.write('usage: pool-teardown.fixture.ts <hang|fail|ok> <worker>\n');
  process.exit(2);
}
process.env.VG_POOL_TEST_MODE = mode;

const lang = { id: 'typescript' } as LanguageDef;
const files: DiscoveredFile[] = [
  { rel: 'a.ts', abs: '/tmp/vg-pool-a.ts', lang },
  { rel: 'b.ts', abs: '/tmp/vg-pool-b.ts', lang },
];

try {
  await parseFiles(files, { jobs: 2, inlineThreshold: 0, workerFile });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
