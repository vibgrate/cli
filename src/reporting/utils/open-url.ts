import { spawn } from 'node:child_process';

/**
 * Best-effort open of a URL in the user's default browser. Returns true if a
 * launcher was spawned (not a guarantee the browser actually opened). Callers
 * should always print the URL too, in case this fails or we're headless.
 */
export function openUrl(url: string): boolean {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    // `start` needs an empty title arg first when the URL contains special chars.
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* swallow — caller falls back to printing the URL */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
