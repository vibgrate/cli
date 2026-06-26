import { Command } from 'commander';
import chalk from 'chalk';
import { clearStoredCredentials, credentialsPath } from '../credentials.js';

export const logoutCommand = new Command('logout')
  .description('Clear stored Vibgrate login credentials')
  .action(() => {
    const cleared = clearStoredCredentials();
    if (cleared) {
      console.log(chalk.green('✔') + ' Logged out. Stored credentials removed.');
    } else {
      console.log(chalk.dim(`No stored credentials found at ${credentialsPath()}.`));
    }
  });
