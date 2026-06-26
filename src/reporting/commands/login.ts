import { Command } from 'commander';
import chalk from 'chalk';
import { availableRegionIds } from '../regions.js';
import { resolveIngestHost } from './dsn.js';
import { writeStoredCredentials, credentialsPath } from '../credentials.js';
import { openUrl } from '../utils/open-url.js';

interface StartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface TokenResponse {
  status:
    | 'authorization_pending'
    | 'complete'
    | 'access_denied'
    | 'expired'
    | 'invalid'
    | 'error';
  dsn?: string;
  keyId?: string;
  workspaceId?: string;
  ingestHost?: string;
  error?: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const loginCommand = new Command('login')
  .description('Authenticate the CLI with your Vibgrate workspace via the browser')
  .option('--ingest <url>', 'Ingest API URL (overrides --region)')
  .option('--region <region>', `Data residency region (${availableRegionIds().join(', ')})`, 'us')
  .option('--no-browser', 'Do not attempt to open a browser automatically')
  .action(async (opts: { ingest?: string; region: string; browser: boolean }) => {
    let ingestHost: string;
    try {
      ingestHost = resolveIngestHost(opts.region, opts.ingest);
    } catch (e: unknown) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }

    const base = `https://${ingestHost}/v1/auth/device`;

    // 1. Start the device authorization request.
    let start: StartResponse;
    try {
      const res = await fetch(`${base}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: '{}',
      });
      if (!res.ok) {
        console.error(chalk.red(`Failed to start login (HTTP ${res.status}).`));
        process.exit(1);
      }
      start = (await res.json()) as StartResponse;
    } catch (e: unknown) {
      console.error(chalk.red(`Could not reach ${ingestHost}: ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
    }

    // 2. Prompt the user to approve in the browser.
    console.log('');
    console.log('To finish signing in, open this URL and approve the request:');
    console.log('');
    console.log('  ' + chalk.cyan(start.verificationUri));
    console.log('');
    console.log('  Your code: ' + chalk.bold(start.userCode));
    console.log('');

    if (opts.browser) {
      const opened = openUrl(start.verificationUriComplete);
      if (opened) {
        console.log(chalk.dim('Opening your browser… (if it does not open, use the URL above)'));
      }
    }
    console.log(chalk.dim('Waiting for approval…'));

    // 3. Poll for completion.
    const intervalMs = Math.max(2, start.interval || 5) * 1000;
    const deadline = Date.now() + (start.expiresIn || 900) * 1000;

    while (Date.now() < deadline) {
      await delay(intervalMs);
      let token: TokenResponse;
      try {
        const res = await fetch(`${base}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
          body: JSON.stringify({ deviceCode: start.deviceCode }),
        });
        token = (await res.json()) as TokenResponse;
      } catch {
        // Transient network error — keep polling until the deadline.
        continue;
      }

      if (token.status === 'authorization_pending') continue;

      if (token.status === 'complete' && token.dsn) {
        writeStoredCredentials({
          dsn: token.dsn,
          workspaceId: token.workspaceId,
          keyId: token.keyId,
          ingestHost: token.ingestHost ?? ingestHost,
          savedAt: new Date().toISOString(),
        });
        console.log('');
        console.log(chalk.green('✔') + ' Logged in.');
        if (token.workspaceId) {
          console.log('  Workspace: ' + chalk.bold(token.workspaceId));
        }
        console.log(chalk.dim(`  Credentials saved to ${credentialsPath()}`));
        console.log(chalk.dim('  You can now run "vibgrate scan --push".'));
        return;
      }

      if (token.status === 'access_denied') {
        console.error(chalk.red('✖ Login was denied in the browser.'));
        process.exit(1);
      }
      if (token.status === 'expired' || token.status === 'invalid') {
        console.error(chalk.red('✖ Login request expired. Run "vibgrate login" again.'));
        process.exit(1);
      }
      if (token.status === 'error') {
        console.error(chalk.red(`✖ ${token.error ?? 'Login failed.'}`));
        process.exit(1);
      }
    }

    console.error(chalk.red('✖ Timed out waiting for approval. Run "vibgrate login" again.'));
    process.exit(1);
  });
