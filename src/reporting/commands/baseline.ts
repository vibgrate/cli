import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { runCoreScan } from '../../core-open/index.js';
import { writeJsonFile } from '../utils/fs.js';
import { loadAdvancedScanHook } from '../advanced-hook.js';

export async function runBaseline(rootDir: string): Promise<void> {
  console.log(chalk.dim('Creating baseline...'));

  const advanced = await loadAdvancedScanHook();
  const artifact = await runCoreScan(rootDir, {
    format: 'text',
    concurrency: 8,
  }, advanced);

  const baselinePath = path.join(rootDir, '.vibgrate', 'baseline.json');
  await writeJsonFile(baselinePath, artifact);
  console.log(chalk.green('✔') + ` Baseline saved to ${chalk.bold('.vibgrate/baseline.json')}`);
  console.log(chalk.dim(`  Baseline score: ${artifact.drift.score}/100`));
}

export const baselineCommand = new Command('baseline')
  .description('Create a drift baseline snapshot')
  .argument('[path]', 'Path to baseline', '.')
  .action(async (targetPath: string) => {
    const rootDir = path.resolve(targetPath);
    await runBaseline(rootDir);
  });
