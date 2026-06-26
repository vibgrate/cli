import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Local-model discovery (VG-LOCAL-MODELS §9.2) — be a no-key *consumer* of the
 * developer's local model fleet. Fully offline and deterministic: inspect the
 * on-disk layouts of Ollama / LM Studio / llama.cpp, never the network. No
 * runtime is built or launched.
 */

export interface LocalModel {
  runtime: 'ollama' | 'lm-studio' | 'gguf';
  name: string;
  path: string;
}

export function discoverModels(home = os.homedir()): LocalModel[] {
  return [...ollama(home), ...lmStudio(home), ...looseGguf(home)].sort(
    (a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name),
  );
}

function ollama(home: string): LocalModel[] {
  const base = path.join(home, '.ollama', 'models', 'manifests');
  const out: LocalModel[] = [];
  walk(base, 4, (file) => {
    // .../library/<model>/<tag>
    const rel = path.relative(base, file).split(path.sep);
    if (rel.length >= 2) {
      const tag = rel[rel.length - 1];
      const model = rel[rel.length - 2];
      out.push({ runtime: 'ollama', name: `${model}:${tag}`, path: file });
    }
  });
  return dedupe(out);
}

function lmStudio(home: string): LocalModel[] {
  const bases = [path.join(home, '.lmstudio', 'models'), path.join(home, '.cache', 'lm-studio', 'models')];
  const out: LocalModel[] = [];
  for (const base of bases) {
    walk(base, 5, (file) => {
      if (!file.endsWith('.gguf')) return;
      const rel = path.relative(base, file).replace(/\\/g, '/');
      out.push({ runtime: 'lm-studio', name: rel, path: file });
    });
  }
  return dedupe(out);
}

function looseGguf(home: string): LocalModel[] {
  const bases = [path.join(home, 'models'), path.join(home, '.cache', 'huggingface')];
  const out: LocalModel[] = [];
  for (const base of bases) {
    walk(base, 4, (file) => {
      if (!file.endsWith('.gguf')) return;
      out.push({ runtime: 'gguf', name: path.basename(file), path: file });
    });
  }
  return dedupe(out);
}

function walk(dir: string, depth: number, onFile: (file: string) => void): void {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, depth - 1, onFile);
    else if (e.isFile()) onFile(abs);
  }
}

function dedupe(models: LocalModel[]): LocalModel[] {
  const seen = new Set<string>();
  const out: LocalModel[] = [];
  for (const m of models) {
    const key = `${m.runtime}:${m.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
