import { Command } from 'commander';
import chalk from 'chalk';
import { clearStoredCredentials, credentialsPath } from '../credentials.js';
import { unsetEnvCommand } from '../utils/shell.js';

export const logoutCommand = new Command('logout')
  .description('Clear stored Vibgrate login credentials')
  .action(() => {
    const cleared = clearStoredCredentials();
    if (cleared) {
      console.log(chalk.green('✔') + ' Logged out. Stored credentials removed.');
    } else {
      console.log(chalk.dim(`No stored credentials found at ${credentialsPath()}.`));
    }

    // The stored file is not the only DSN source: resolveDsn() also honors the
    // VIBGRATE_DSN env var (and a --dsn flag). Deleting the file does not clear
    // those, so the user can still be authenticated after "logout". Warn them —
    // but never echo the value itself (GUARDRAILS §1.1), only that it is set.
    if (process.env.VIBGRATE_DSN) {
      console.log('');
      console.log(
        chalk.yellow('⚠') +
          ' VIBGRATE_DSN is still set in your environment, so commands will keep using it.',
      );
      console.log(
        chalk.dim(`  Unset it to fully sign out: ${unsetEnvCommand('VIBGRATE_DSN')}`),
      );
    }
  });
