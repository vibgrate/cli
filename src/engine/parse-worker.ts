import * as fs from 'node:fs';
import { parseSource } from './parse.js';
import { setGrammarsOverride } from './grammars.js';
import type { FileParse } from './types.js';

/**
 * tinypool worker entry. Receives a chunk of files, reads and parses each, and
 * returns the FileParse table. Each worker owns its own web-tree-sitter instance
 * (initialized lazily inside parseSource/grammars). Results are plain data, so
 * they serialize cleanly back to the main thread.
 *
 * The `--grammars <dir>` override is passed in the payload (env vars don't cross
 * into worker threads in a controlled way) and applied per worker before parsing.
 */

export interface ParseTask {
  rel: string;
  abs: string;
  lang: string;
}

export interface ParsePayload {
  tasks: ParseTask[];
  grammarsDir?: string;
}

export default async function run(payload: ParsePayload): Promise<FileParse[]> {
  setGrammarsOverride(payload.grammarsDir);
  const out: FileParse[] = [];
  for (const task of payload.tasks) {
    try {
      const source = fs.readFileSync(task.abs, 'utf8');
      out.push(await parseSource(task.rel, task.lang, source));
    } catch (err) {
      out.push({
        rel: task.rel,
        lang: task.lang,
        hash: '',
        bytes: 0,
        defs: [],
        calls: [],
        imports: [],
        heritage: [],
        guards: [],
        warnings: [`parse failed: ${(err as Error).message}`],
      });
    }
  }
  return out;
}
