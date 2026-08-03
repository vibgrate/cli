/**
 * The vgd embedding worker — the ONLY process that loads the native embedding
 * backend.
 *
 * `fastembed`/`onnxruntime-node` can abort its host process outright (a
 * blocked postinstall SIGTRAPs on first inference; see
 * `engine/embed-health.ts`), and no try/catch survives a signal. Keeping the
 * addon here means the worst case is a dead worker that vgd restarts or gives
 * up on, instead of a dead daemon — or, as it was before any of this, a dead
 * language server mid-request.
 *
 * Protocol: newline-delimited JSON on stdin/stdout, one response per request,
 * correlated by `id`. Deliberately tiny and dependency-free so the process
 * starts fast: the expensive part is the model load, which happens once on the
 * first request and is then reused for the life of the worker.
 *
 * stdout carries protocol frames ONLY. Anything diagnostic goes to stderr, so
 * a chatty dependency writing to stdout cannot corrupt the stream.
 */
import * as readline from 'node:readline';
import { loadEmbedder, resolveEmbedModel, type Embedder } from '../../engine/embeddings.js';

export interface EmbedWorkerRequest {
  id: number;
  op: 'ping' | 'embed' | 'model';
  /** Texts to embed (`embed`). */
  texts?: string[];
  /** Treat the single text as a query rather than a document. */
  query?: boolean;
}

export type EmbedWorkerResponse =
  | { id: number; ok: true; op: 'ping'; model: string }
  | { id: number; ok: true; op: 'model'; model: string; loaded: boolean }
  | { id: number; ok: true; op: 'embed'; vectors: number[][] }
  | { id: number; ok: false; error: string };

let embedder: Embedder | null = null;
let loadFailed = false;

/**
 * Load once, reuse forever. A failure is remembered so a broken environment
 * does not re-attempt (and re-log) on every request; the broker sees the error
 * and falls back to lexical.
 */
async function ensureEmbedder(): Promise<Embedder | null> {
  if (embedder) return embedder;
  if (loadFailed) return null;
  const loaded = await loadEmbedder({});
  if (!loaded) {
    loadFailed = true;
    return null;
  }
  embedder = loaded;
  return embedder;
}

export async function handleWorkerRequest(req: EmbedWorkerRequest): Promise<EmbedWorkerResponse> {
  switch (req.op) {
    case 'ping':
      return { id: req.id, ok: true, op: 'ping', model: resolveEmbedModel() };
    case 'model': {
      const e = await ensureEmbedder();
      return { id: req.id, ok: true, op: 'model', model: e?.id ?? resolveEmbedModel(), loaded: !!e };
    }
    case 'embed': {
      const texts = Array.isArray(req.texts) ? req.texts : [];
      if (!texts.length) return { id: req.id, ok: true, op: 'embed', vectors: [] };
      const e = await ensureEmbedder();
      if (!e) return { id: req.id, ok: false, error: 'embedding backend unavailable' };
      // A single query goes through embedQuery: some models prepend a
      // different instruction prefix for queries than for documents, and
      // silently using the document path would degrade ranking.
      const vectors =
        req.query && texts.length === 1 ? [await e.embedQuery(texts[0]!)] : await e.embed(texts);
      return { id: req.id, ok: true, op: 'embed', vectors };
    }
    default:
      return { id: req.id, ok: false, error: `unknown op "${String((req as { op?: unknown }).op)}"` };
  }
}

/** Wire stdin/stdout up to {@link handleWorkerRequest}. Exported for tests. */
export function runEmbedWorker(): void {
  const rl = readline.createInterface({ input: process.stdin });
  const write = (res: EmbedWorkerResponse): void => {
    process.stdout.write(JSON.stringify(res) + '\n');
  };
  rl.on('line', (line: string) => {
    const text = line.trim();
    if (!text) return;
    let req: EmbedWorkerRequest;
    try {
      req = JSON.parse(text) as EmbedWorkerRequest;
    } catch {
      return; // an unparseable frame has no id to answer on
    }
    // Requests are handled concurrently on purpose: a slow corpus embed must
    // not block a single interactive query behind it.
    void handleWorkerRequest(req)
      .then(write)
      .catch((err: unknown) =>
        write({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  });
  rl.on('close', () => process.exit(0));
}
