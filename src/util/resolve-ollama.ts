/**
 * Locate the Ollama CLI for install/uninstall/pull.
 *
 * Dock-launched GUI apps (VS Code, Cursor) often inherit a stripped PATH that
 * omits Homebrew (`/opt/homebrew/bin`) and the official installer locations.
 * Discovery of models still works (on-disk manifests under ~/.ollama), so the
 * UI lists models that then fail to uninstall with "ollama not on PATH".
 * Resolve the binary via PATH first, then well-known install prefixes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { whichOnPath } from './cli-invocation.js';

/** Absolute path to the ollama binary, or null if not found. */
export function resolveOllamaBinary(): string | null {
  const names = process.platform === 'win32' ? ['ollama.exe', 'ollama'] : ['ollama'];
  for (const name of names) {
    const hit = whichOnPath(name);
    if (hit) return hit;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
        ]
      : [
          '/opt/homebrew/bin/ollama',
          '/usr/local/bin/ollama',
          '/usr/bin/ollama',
          path.join(os.homedir(), '.local', 'bin', 'ollama'),
        ];

  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** True when the Ollama CLI is on PATH or at a known install location. */
export function hasOllamaBinary(): boolean {
  return resolveOllamaBinary() !== null;
}
