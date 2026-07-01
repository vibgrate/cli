import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { writeTextFile } from '../utils/fs.js';
import { findGitRoot, ensureGitignored } from '../utils/gitignore.js';
import { availableRegionIds, resolveIngestHost } from '../regions.js';

// Re-exported for backwards compatibility with existing importers/tests.
export { resolveIngestHost };

/** A freshly provisioned workspace and the credential needed to ingest into it. */
export interface ProvisionedWorkspace {
  /** The full DSN string (`vibgrate+https://<keyId>:<secret>@<host>/<workspaceId>`). */
  dsn: string;
  keyId: string;
  workspaceId: string;
  /** The ingest host the workspace was provisioned against (the "ingest URL"). */
  ingestHost: string;
  /** The pinned region, or `undefined` for a custom `--ingest` host. */
  region?: string;
}

/** Mint a fresh keyId/secret pair (keyId: 12 bytes = 24 hex, matches API validation). */
function generateKeyMaterial(): { keyId: string; secret: string } {
  return {
    keyId: crypto.randomBytes(12).toString('hex'),
    secret: crypto.randomBytes(32).toString('hex'),
  };
}

/** Build a DSN string from its parts. */
export function buildDsn(keyId: string, secret: string, ingestHost: string, workspaceId: string): string {
  return `vibgrate+https://${keyId}:${secret}@${ingestHost}/${workspaceId}`;
}

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

/**
 * Provision a brand-new workspace and mint its DSN in the chosen region.
 *
 * Shared by `dsn create --workspace new` and by `login`, which calls this
 * automatically when a freshly-created account has no workspace/DSN yet — so a
 * first-time user is never required to run `dsn create` by hand. Throws an Error
 * with an actionable message (GUARDRAILS §1.3) when resolution or provisioning
 * fails; the caller decides how to surface it.
 */
export async function createWorkspaceDsn(opts: { region?: string; ingest?: string }): Promise<ProvisionedWorkspace> {
  const ingestHost = resolveIngestHost(opts.region, opts.ingest);
  const { keyId, secret } = generateKeyMaterial();
  // 16 hex char workspace ID (8 bytes).
  const workspaceId = crypto.randomBytes(8).toString('hex');
  // For a known region we pin it explicitly; for a custom --ingest host the
  // region is left to the API to derive from the host.
  const region = opts.ingest ? undefined : (opts.region ?? 'us').toLowerCase();

  const result = await provisionDsn(keyId, secret, workspaceId, ingestHost, region);
  if (!result.success) {
    throw new Error(`Failed to provision workspace: ${result.error}`);
  }

  return { dsn: buildDsn(keyId, secret, ingestHost, workspaceId), keyId, workspaceId, ingestHost, region };
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

    const dsn = buildDsn(keyId, secret, ingestHost, workspaceId);

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

      // The DSN is a credential — keep it out of version control automatically
      // (GUARDRAILS §1.1) rather than relying on the user to remember.
      const root = findGitRoot(path.dirname(writePath));
      const rel = root ? path.relative(root, writePath).split(path.sep).join('/') : '';
      if (root && rel && !rel.startsWith('..')) {
        const res = ensureGitignored(rel, path.dirname(writePath));
        if (res.status === 'created') {
          console.log(chalk.green('✔') + ` Created .gitignore and ignored ${rel}`);
        } else if (res.status === 'added') {
          console.log(chalk.green('✔') + ` Added ${rel} to .gitignore`);
        } else if (res.status === 'present') {
          console.log(chalk.dim(`  ${rel} is already in .gitignore`));
        }
      } else {
        console.log(
          chalk.yellow('⚠') +
            ' Add this file to .gitignore to keep the DSN out of version control.',
        );
      }
    }
  });
