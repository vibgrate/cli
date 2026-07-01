import { Command } from 'commander';
import chalk from 'chalk';
import { availableRegionIds } from '../regions.js';
import { resolveIngestHost, createWorkspaceDsn } from './dsn.js';
import { writeStoredCredentials, credentialsPath, gitignoreEntryForCredentials } from '../credentials.js';
import type { StoredCredentials } from '../credentials.js';
import { findGitRoot, ensureGitignored } from '../utils/gitignore.js';
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

      if (token.status === 'complete') {
        // Resolve the DSN. An existing account comes back with one from the
        // device flow; a brand-new account has no workspace yet, so we
        // provision one automatically in the user's region rather than making
        // the user run "dsn create" by hand. Login itself already succeeded —
        // only the workspace setup can still fail here.
        let creds: StoredCredentials;
        if (token.dsn) {
          creds = {
            dsn: token.dsn,
            workspaceId: token.workspaceId,
            keyId: token.keyId,
            ingestHost: token.ingestHost ?? ingestHost,
            savedAt: new Date().toISOString(),
          };
        } else {
          console.log(chalk.dim('Setting up your workspace…'));
          try {
            const provisioned = await createWorkspaceDsn({
              region: opts.region,
              ingest: opts.ingest,
            });
            creds = {
              dsn: provisioned.dsn,
              workspaceId: provisioned.workspaceId,
              keyId: provisioned.keyId,
              ingestHost: provisioned.ingestHost,
              savedAt: new Date().toISOString(),
            };
          } catch (e: unknown) {
            console.error(
              chalk.red('✖ Signed in, but workspace setup failed: ') +
                (e instanceof Error ? e.message : String(e)),
            );
            console.error(
              chalk.dim('  Finish setup with "vibgrate dsn create --workspace new".'),
            );
            process.exit(1);
          }
        }

        writeStoredCredentials(creds);
        console.log('');
        console.log(chalk.green('✔') + ' Logged in.');
        if (creds.workspaceId) {
          console.log('  Workspace: ' + chalk.bold(creds.workspaceId));
        }
        console.log(chalk.dim(`  Credentials saved to ${credentialsPath()}`));

        // Defense in depth (GUARDRAILS §1.1): the DSN we just stored is a
        // credential and must never be committed. When run inside a git repo,
        // make sure the credentials file is git-ignored, creating .gitignore if
        // the repo doesn't have one. This is best-effort — never fail an
        // otherwise-successful login over .gitignore housekeeping.
        try {
          const root = findGitRoot();
          if (root) {
            const res = ensureGitignored(gitignoreEntryForCredentials(root), root);
            if (res.status === 'created') {
              console.log(chalk.dim(`  Created .gitignore and ignored ${res.entry}`));
            } else if (res.status === 'added') {
              console.log(chalk.dim(`  Added ${res.entry} to .gitignore`));
            }
          }
        } catch {
          /* non-fatal */
        }

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
