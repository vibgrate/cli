/**
 * Test double for the CCR sink (`ccr/store.ts` is owned by the pipeline
 * agent). Content-addressed like the real store: blake3 of the original,
 * truncated to 24 hex chars; identical originals share an entry.
 */

import { hashString } from '../../engine/hash.js';
import type { CcrSink, CcrStoreMeta } from '../types.js';

export class MemorySink implements CcrSink {
  readonly entries = new Map<string, { original: string; meta: CcrStoreMeta }>();
  calls = 0;

  store(original: string, meta: CcrStoreMeta): string {
    this.calls++;
    const hash = (meta.explicitHash ?? hashString(original).slice(0, 24)).toLowerCase();
    if (!this.entries.has(hash)) this.entries.set(hash, { original, meta });
    return hash;
  }

  exists(hash: string): boolean {
    return this.entries.has(hash.toLowerCase());
  }

  get(hash: string): string | undefined {
    return this.entries.get(hash.toLowerCase())?.original;
  }
}

export class ThrowingSink implements CcrSink {
  store(): string {
    throw new Error('store unavailable');
  }
  exists(): boolean {
    return false;
  }
}

export function baseRequest(content: string, extra: Partial<import('../types.js').CompressRequest> = {}): import('../types.js').CompressRequest {
  return { content, tokenizer: { id: 'chars/4', count: (t: string): number => Math.ceil(t.length / 4) }, injectMarker: false, losslessOnly: false, ...extra };
}
