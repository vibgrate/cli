import * as path from 'node:path';
import { daemonDir } from '../paths.js';

/** Socket (or named-pipe) path for the local vgd instance. */
export function vgdSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return path.join('\\\\.\\pipe', 'vibgrate-vgd');
  }
  return path.join(daemonDir(env, platform), 'vgd.sock');
}

/** PID file for quick status without a round-trip (Unix). */
export function vgdPidPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(daemonDir(env, platform), 'vgd.pid');
}
