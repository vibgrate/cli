import { parseSource } from './parse.js';
import { setGrammarsOverride, resetParser } from './grammars.js';
import type { FileParse } from './types.js';
import { NON_UTF8_SKIP_MARK, readUtf8SourceSync } from '../core-open/utils/source-text.js';
import { stampWarning, WARNING_CODES } from '../core-open/warnings.js';

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
      const source = readUtf8SourceSync(task.abs);
      if (source === null) {
        out.push({
          rel: task.rel,
          lang: task.lang,
          hash: '',
          bytes: 0,
          defs: [],
          calls: [],
          imports: [],
          heritage: [],
          typeRefs: [],
          guards: [],
          warnings: [NON_UTF8_SKIP_MARK],
        });
        continue;
      }
      out.push(await parseSource(task.rel, task.lang, source));
    } catch (err) {
      // A wasm-level parse crash can leave the language's reused parser
      // mid-state; drop it so the failure stays contained to this file.
      resetParser(task.lang);
      out.push({
        rel: task.rel,
        lang: task.lang,
        hash: '',
        bytes: 0,
        defs: [],
        calls: [],
        imports: [],
        heritage: [],
        typeRefs: [],
        guards: [],
        warnings: [stampWarning(WARNING_CODES.PARSE_FAILED, `parse failed: ${(err as Error).message}`)],
      });
    }
  }
  return out;
}
