import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { ensureDir, pathExists } from '../utils/fs.js';
import { writeDefaultConfig } from '../../core-open/index.js';

export const initCommand = new Command('init')
  .description('Initialize vibgrate in a project')
  .argument('[path]', 'Path to initialize', '.')
  .option('--baseline', 'Create initial baseline after init')
  .option('--yes', 'Skip confirmation prompts')
  .action(async (targetPath: string, opts: { baseline?: boolean; yes?: boolean }) => {
    const rootDir = path.resolve(targetPath);
    const vibgrateDir = path.join(rootDir, '.vibgrate');

    await ensureDir(vibgrateDir);
    console.log(chalk.green('✔') + ` Created ${chalk.bold('.vibgrate/')} directory`);

    const configPath = path.join(rootDir, 'vibgrate.config.ts');
    if (await pathExists(configPath)) {
      console.log(chalk.dim('  vibgrate.config.ts already exists, skipping'));
    } else {
      await writeDefaultConfig(rootDir);
      console.log(chalk.green('✔') + ` Created ${chalk.bold('vibgrate.config.ts')}`);
    }

    if (opts.baseline) {
      const { runBaseline } = await import('./baseline.js');
      await runBaseline(rootDir);
    }

    console.log('');
    console.log(chalk.bold('Next steps:'));
    console.log(`  ${chalk.cyan('vibgrate scan')}            Scan for upgrade drift`);
    console.log(`  ${chalk.cyan('vibgrate baseline')}        Create a drift baseline`);
    console.log('');
  });
