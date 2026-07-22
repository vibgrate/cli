/**
 * Thin I/O wrappers around the local model runtime (Ollama / GPU) for the
 * `vg code` guided flow (VG-CLI-CODE §10). The pure parsing/estimation these
 * feed lives in capability.ts and is unit-tested; this file just gathers real
 * system state and wraps the noisy `ollama pull` behind a single clean status
 * line (no raw progress spam), per the "clean UI for devs" requirement.
 */

import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parseOllamaPs, parseNvidiaSmi, type SystemMemory } from './capability.js';
import type { Spinner } from './ui.js';

/** Gather current system memory, loaded models, and (best-effort) GPU VRAM. */
export function gatherSystemMemory(): SystemMemory {
  const loaded = safeRun('ollama', ['ps']).map(parseOllamaPs).flat();
  const smi = safeRun('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'])
    .map(parseNvidiaSmi)
    .find(Boolean);
  const sys: SystemMemory = {
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    loaded,
  };
  if (smi) {
    sys.vramTotalBytes = smi.totalBytes;
    sys.vramFreeBytes = Math.max(0, smi.totalBytes - smi.usedBytes);
  }
  return sys;
}

/** True if the `ollama` binary is on PATH. */
export function hasOllama(): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { stdio: 'ignore' }).status === 0;
}

/** Unload a running model to free memory. Returns true on success. */
export function stopModel(name: string): boolean {
  return spawnSync('ollama', ['stop', name], { stdio: 'ignore' }).status === 0;
}

/**
 * Pull a model, wrapping Ollama's chatty progress in one clean spinner line.
 * We read its stderr, keep only the latest human-meaningful status (e.g.
 * "pulling manifest", "downloading … 42%"), and never echo the raw stream.
 */
export function pullModelClean(name: string, spinner: Spinner): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ollama', ['pull', name]);
    const onData = (buf: Buffer): void => {
      const line = lastMeaningfulLine(buf.toString());
      if (line) spinner.update(`pulling ${name} — ${line}`);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** The last non-empty, de-noised status token from an ollama progress chunk. */
function lastMeaningfulLine(chunk: string): string {
  const lines = chunk
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    // ollama redraws a progress bar with escape codes; strip them and bar glyphs.
    .map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[▏▎▍▌▋▊▉█░▒▓⣀-⣿]/g, '').trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  // Keep a short, meaningful summary (status + any percentage).
  const pct = last.match(/(\d+)\s*%/);
  const status = last.replace(/\s{2,}.*$/, '').slice(0, 48);
  return pct ? `${status} ${pct[1]}%`.trim() : status;
}

/** Run a command and return its stdout lines (or [] if the binary is missing/fails). */
function safeRun(bin: string, args: string[]): string[] {
  try {
    const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || typeof res.stdout !== 'string') return [];
    return [res.stdout];
  } catch {
    return [];
  }
}
