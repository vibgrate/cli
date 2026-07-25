#!/usr/bin/env node
/**
 * Offline Fusion FCS / ZNS@1 harness runner.
 *
 * Runs the scripted fusion task pack (no network, no model) and prints an FCS
 * report. Extend the pack via trajectory-harness.ts for SWE-bench Lite scale.
 *
 * Usage (from packages/vibgrate-cli-public):
 *   node --import tsx bench/fusion-fcs.mjs
 *   # or after build: node dist/bench/... (prefer vitest path in CI)
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

async function main() {
  // Prefer compiled dist if present; else dynamic import via vitest-style path.
  let runFusionTaskPack;
  try {
    ({ runFusionTaskPack } = await import(pathToFileURL(path.join(root, 'dist/code/trajectory-harness.js')).href));
  } catch {
    // Development: load through the package's vitest-compatible source graph is
    // not available as ESM without a loader — print how to run tests instead.
    console.log(`# Fusion FCS harness

Run offline via vitest (recommended):

  pnpm exec vitest run src/code/trajectory.test.ts

Or import runFusionTaskPack from src/code/trajectory-harness.ts in a TS runner.

Default pack: fixture-timeout-zns, fixture-timeout-fail-repair, fixture-format-report
(arms: capsule / metadata / oracle).
`);
    process.exit(0);
  }
  const { report, markdown } = await runFusionTaskPack();
  process.stdout.write(markdown);
  if (report.fcs != null) {
    console.error(`FCS=${report.fcs} ZNS@1=${report.znsAt1Rate}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
