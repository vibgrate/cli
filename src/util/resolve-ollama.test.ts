import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { hasOllamaBinary, resolveOllamaBinary } from './resolve-ollama.js';

describe('resolveOllamaBinary', () => {
  it('returns a path when ollama is installed (PATH or well-known location)', () => {
    const bin = resolveOllamaBinary();
    // CI images may not ship ollama — only assert shape when present.
    if (!bin) {
      expect(hasOllamaBinary()).toBe(false);
      return;
    }
    expect(bin.length).toBeGreaterThan(0);
    expect(fs.existsSync(bin)).toBe(true);
    expect(hasOllamaBinary()).toBe(true);
  });

  it('prefers a real executable path over a bare name', () => {
    const bin = resolveOllamaBinary();
    if (!bin) return;
    // Never return a bare "ollama" that still needs PATH lookup at spawn time.
    expect(bin.includes(pathSep()) || bin.endsWith('.exe')).toBe(true);
  });
});

function pathSep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
