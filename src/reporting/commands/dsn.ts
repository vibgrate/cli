import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { writeTextFile } from '../utils/fs.js';
import { availableRegionIds, resolveIngestHost } from '../regions.js';

// Re-exported for backwards compatibility with existing importers/tests.
export { resolveIngestHost };

/**
 * Provision a DSN by calling the API to register the key.
 * This is required when using --workspace new to auto-provision a workspace.
 */
async function provisionDsn(
  keyId: string,
  secret: string,
  workspaceId: string,
  ingestHost: string,
  region?: string
): Promise<{ success: boolean; error?: string }> {
  const url = `https://${ingestHost}/v1/provision`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close', // Prevent keep-alive delays on exit
      },
      // Pin the workspace to the selected region. The API rejects the request
      // if `region` doesn't match the endpoint host (residency guard). For a
      // custom --ingest host we omit it and let the API derive it from the host.
      body: JSON.stringify(region ? { keyId, secret, workspaceId, region } : { keyId, secret, workspaceId }),
    });

    if (!response.ok) {
      const result = await response.json() as { error?: string };
      return { success: false, error: result.error || `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const dsnCommand = new Command('dsn')
  .description('Manage DSN tokens');

dsnCommand
  .command('create')
  .description('Create a new DSN token')
  .option('--ingest <url>', 'Ingest API URL (overrides --region)')
  .option('--region <region>', `Data residency region (${availableRegionIds().join(', ')})`, 'us')
  .requiredOption('--workspace <id>', 'Workspace ID (use "new" to auto-generate)')
  .option('--write <path>', 'Write DSN to file')
  .action(async (opts: { ingest?: string; region: string; workspace: string; write?: string }) => {
    // Generate credentials
    // keyId: 12 bytes = 24 hex chars (matches API validation)
    const keyId = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');

    let ingestHost: string;
    try {
      ingestHost = resolveIngestHost(opts.region, opts.ingest);
    } catch (e: unknown) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }

    // Handle --workspace new: auto-generate a workspace ID
    let workspaceId = opts.workspace;
    const isNewWorkspace = opts.workspace.toLowerCase() === 'new';
    
    if (isNewWorkspace) {
      // Generate a 16 hex char workspace ID (8 bytes)
      workspaceId = crypto.randomBytes(8).toString('hex');
      console.log(chalk.dim(`Provisioning new workspace ${workspaceId}...`));
    }

    // For a known region we pin it explicitly; for a custom --ingest host the
    // region is left to the API to derive from the host.
    const region = opts.ingest ? undefined : opts.region.toLowerCase();

    // When using 'new', we must call the provision API
    if (isNewWorkspace) {
      const result = await provisionDsn(keyId, secret, workspaceId, ingestHost, region);
      if (!result.success) {
        console.error(chalk.red(`Failed to provision DSN: ${result.error}`));
        process.exit(1);
      }
    }

    const dsn = `vibgrate+https://${keyId}:${secret}@${ingestHost}/${workspaceId}`;

    console.log(chalk.green('✔') + ' DSN created');
    console.log('');
    console.log(chalk.bold('Region:'));
    console.log(`  ${region ?? 'custom'} (${ingestHost})`);
    console.log('');
    console.log(chalk.bold('DSN:'));
    console.log(`  ${dsn}`);
    console.log('');
    console.log(chalk.bold('Key ID:'));
    console.log(`  ${keyId}`);
    if (isNewWorkspace) {
      console.log('');
      console.log(chalk.bold('Workspace ID:'));
      console.log(`  ${workspaceId}`);
    }
    console.log('');
    console.log(chalk.dim('Set this as VIBGRATE_DSN in your CI environment.'));
    if (!isNewWorkspace) {
      console.log(chalk.dim('The secret must be registered on your Vibgrate ingest API.'));
    }

    if (opts.write) {
      const writePath = path.resolve(opts.write);
      await writeTextFile(writePath, dsn + '\n');
      console.log('');
      console.log(chalk.green('✔') + ` DSN written to ${opts.write}`);
      console.log(chalk.yellow('⚠') + ' Add this file to .gitignore!');
    }
  });
