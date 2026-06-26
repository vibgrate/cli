import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { formatText } from '../formatters/text.js';
import { formatMarkdown } from '../formatters/markdown.js';
import type { ScanArtifact, ReportOptions } from '../types.js';

export const reportCommand = new Command('report')
  .description('Generate a drift report from a scan artifact')
  .option('--in <file>', 'Input artifact file', '.vibgrate/scan_result.json')
  .option('--format <format>', 'Output format (md|text|json)', 'text')
  .action(async (opts: { in: string; format: string }) => {
    const artifactPath = path.resolve(opts.in);

    if (!(await pathExists(artifactPath))) {
      console.error(chalk.red(`Artifact not found: ${artifactPath}`));
      console.error(chalk.dim('Run "vibgrate scan" first to generate a scan artifact.'));
      process.exit(1);
    }

    const artifact = await readJsonFile<ScanArtifact>(artifactPath);

    switch (opts.format) {
      case 'md':
        console.log(formatMarkdown(artifact));
        break;
      case 'json':
        console.log(JSON.stringify(artifact, null, 2));
        break;
      case 'text':
      default:
        console.log(formatText(artifact));
        break;
    }
  });
