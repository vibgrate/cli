import { env as knobEnv } from '../compress/config.js';

/**
 * In-loop compression for `vg code`.
 *
 * The agent's own tool results are the bulkiest thing in its context: a
 * `run_command` that prints a full test log, a `web_fetch` of a documentation
 * page, a `search_code` sweep over a large repo. Every one of those is re-billed
 * on every subsequent step, so compressing them once — on the way back from the
 * tool, before the result becomes part of the transcript — is worth more than
 * anything done later.
 *
 * This is deliberately not the proxy: `vg code` talks to the model itself, so
 * there is no wire to sit on. It is the same compression engine, called at the
 * one seam where a tool result enters the conversation.
 *
 * Two rules keep it safe:
 *
 *  1. **Reads stay byte-exact.** `read_file`, `read_notebook` and the file
 *     inspection tools feed edits; an edit computed against a summarised file
 *     corrupts the file. They are never compressed, whatever their size.
 *  2. **Failures stay whole.** A failed tool result is what the model needs in
 *     full to recover, and it is usually short anyway.
 *
 * Everything else is compressed only once it is genuinely large, and the
 * original stays in the local retrievable store so `retrieve_original` can pull
 * back any slice the model still wants.
 */

/** Tool results that an edit may be computed from — never summarised. */
const BYTE_EXACT_TOOLS = new Set([
  'read_file',
  'read_notebook',
  'inspect_change',
  'edit_file',
  'create_file',
  'apply_patch',
  'edit_notebook_cell',
]);

/** Which content router hint fits each tool's output shape. */
const ROUTER_HINT: Readonly<Record<string, string>> = {
  run_command: 'Bash',
  search_code: 'Grep',
  list_files: 'Glob',
  graph_impact: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  library_docs: 'WebFetch',
  browser_snapshot: 'WebFetch',
  inspect_task: 'Bash',
  spawn_subagent: 'Bash',
  verify_change: 'Bash',
};

export interface ToolOutputCompressor {
  /**
   * Compress one tool result. Returns the original string unchanged whenever
   * compression is off, the tool is byte-exact, the result is small, the result
   * failed, or anything at all goes wrong — this must never be the reason a
   * coding session breaks.
   */
  compress(toolName: string, content: string, opts: { failed?: boolean; query?: string }): string;
  /** Tokens saved so far this session, for `/cost` and the run summary. */
  readonly saved: number;
}

const OFF: ToolOutputCompressor = { compress: (_n, content) => content, saved: 0 };

/**
 * Build the in-loop compressor, or the identity when compression is disabled.
 *
 * On by default: an agent loop is exactly the case the layer exists for. Set
 * `VG_CODE_COMPRESS=0` to turn it off, or raise `VG_CODE_COMPRESS_MIN_CHARS` to
 * only touch very large results.
 */
export function createToolOutputCompressor(deps: {
  /** The router call — injected so tests need no module graph. */
  compress: (input: { content: string; toolName?: string; query?: string }) => { content: string; tokensSaved: number };
  env?: NodeJS.ProcessEnv;
}): ToolOutputCompressor {
  const env = deps.env ?? process.env;
  if (!knobEnv.bool('VG_CODE_COMPRESS', env)) return OFF;
  const minChars = knobEnv.int('VG_CODE_COMPRESS_MIN_CHARS', env, { min: 0 });
  let saved = 0;
  return {
    get saved() {
      return saved;
    },
    compress(toolName, content, opts) {
      if (!shouldCompress(toolName, content, opts, minChars)) return content;
      try {
        const res = deps.compress({ content, toolName: ROUTER_HINT[toolName] ?? toolName, query: opts.query });
        // A compressor that grew the content, or produced nothing, is a no-op.
        if (!res.content || res.content.length >= content.length) return content;
        saved += Math.max(0, res.tokensSaved);
        return res.content;
      } catch {
        return content;
      }
    },
  };
}

/** The decision, split out so it can be asserted directly. */
export function shouldCompress(
  toolName: string,
  content: string,
  opts: { failed?: boolean },
  minChars: number,
): boolean {
  if (opts.failed) return false;
  if (BYTE_EXACT_TOOLS.has(toolName)) return false;
  return content.length >= minChars;
}

export { BYTE_EXACT_TOOLS, ROUTER_HINT };
