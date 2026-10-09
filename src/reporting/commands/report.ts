import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { usageError } from '../../util/exit.js';
import { redactHomePaths, scanRootFromArtifactFile } from '../../core-open/utils/shareable-path.js';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { formatText } from '../formatters/text.js';
import { formatMarkdown } from '../formatters/markdown.js';
import { formatHtmlReport } from '../formatters/html.js';
import type { ReportFormat, ScanArtifact } from '../types.js';

/** Formats `vg report` accepts. `text` is the default. */
export const REPORT_FORMATS = ['md', 'text', 'json', 'html'] as const satisfies readonly ReportFormat[];

function assertReportFormat(format: string): asserts format is ReportFormat {
  if ((REPORT_FORMATS as readonly string[]).includes(format)) return;
  throw usageError(`unknown --format ${JSON.stringify(format)} (expected ${REPORT_FORMATS.join(', ')})`);
}

export const reportCommand = new Command('report')
  .description('Generate a drift report from a scan artifact')
  .option('--in <file>', 'Input artifact file', '.vibgrate/scan_result.json')
  .option('--format <format>', `Output format (${REPORT_FORMATS.join('|')})`, 'text')
  .action(async (opts: { in: string; format: string }) => {
    // Before the artifact is read, so an unknown value never renders as text.
    assertReportFormat(opts.format);

    const artifactPath = path.resolve(opts.in);

    if (!(await pathExists(artifactPath))) {
      console.error(chalk.red(`Artifact not found: ${artifactPath}`));
      console.error(chalk.dim('Run "vibgrate scan" first to generate a scan artifact.'));
      process.exit(1);
    }

    const artifact = await readJsonFile<ScanArtifact>(artifactPath);
    // Only a result written under `.vibgrate/` has a known scan root. A file
    // passed in from elsewhere keeps its paths unless they are home prefixes,
    // which still collapse to `~/…` inside the formatters.
    const shareRoot = scanRootFromArtifactFile(artifactPath);
    const shareable = redactHomePaths(artifact, shareRoot);

    switch (opts.format) {
      case 'md':
        console.log(formatMarkdown(shareable, shareRoot));
        break;
      case 'json':
        console.log(JSON.stringify(shareable, null, 2));
        break;
      case 'text':
        console.log(formatText(artifact));
        break;
      case 'html':
        console.log(formatHtmlReport(shareable, shareRoot));
        break;
    }
  });
