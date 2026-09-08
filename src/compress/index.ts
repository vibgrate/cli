/**
 * Context-compression layer — public barrel (re-exported by `src/index.ts`).
 */

export * from './types.js';
export * from './paths.js';
export * from './config.js';
export * from './format.js';
export * from './pipeline.js';
export * from './hooks.js';
export * from './dedup.js';
export * from './read-lifecycle.js';
export * from './thinking.js';
export * from './cache-aligner.js';
export * from './shared-context.js';
export * from './session-stats.js';
export * from './ledger.js';
export * from './sdk.js';
export * from './ccr/index.js';

import { compressMessages } from './pipeline.js';
import type { CompressOptions, CompressResult, Message } from './types.js';

/** Compress a conversation with the default dependencies (router, tokenizer, process store). */
export function compress(messages: Message[], options: CompressOptions = {}): Promise<CompressResult> {
  return compressMessages(messages, options);
}
