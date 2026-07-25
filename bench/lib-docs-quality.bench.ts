/**
 * Layer A — library docs slice quality (no model).
 *
 * Ingests fixture markdown via addLibrary and asserts resolveLib + readDoc
 * return the version-correct fragment (strict options form).
 *
 *   pnpm --filter @vibgrate/cli-public exec tsx bench/lib-docs-quality.bench.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addLibrary, loadCatalog, resolveLib, readDoc } from '../src/engine/lib.js';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-libdocs-bench-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'libdocs-bench',
        dependencies: { 'tiny-validate': '1.2.0' },
      }),
    );
    fs.mkdirSync(path.join(root, 'node_modules/tiny-validate'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'node_modules/tiny-validate/package.json'),
      JSON.stringify({ name: 'tiny-validate', version: '1.2.0' }),
    );
    const docPath = path.join(root, 'TINY_VALIDATE.md');
    fs.writeFileSync(
      docPath,
      `# tiny-validate 1.2.0

## API

Use \`validate(value, { strict: true })\`.

The positional form \`validate(value, true)\` was **removed** in 1.2.
`,
    );

    const entry = await addLibrary(docPath, { root, name: 'tiny-validate', version: '1.2.0' });
    const catalog = loadCatalog(root);
    const resolved = resolveLib(catalog, 'tiny-validate');
    if (!resolved) {
      console.error('resolveLib failed for tiny-validate');
      process.exit(2);
    }

    const text = readDoc(root, entry);
    const hasStrict = /strict\s*:\s*true|options object|\{ strict/i.test(text);
    const mentionsRemoved = /removed|1\.2/i.test(text);

    console.log('\nLib-docs quality\n');
    console.log(`  resolve: ${resolved.name} @ ${resolved.version}`);
    console.log(`  ${hasStrict ? '✓' : '✗'} docs mention strict options form`);
    console.log(`  ${mentionsRemoved ? '✓' : '○'} docs mention 1.2 / removed API`);
    console.log(`  bytes: ${text.length}\n`);

    if (!hasStrict) process.exit(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
