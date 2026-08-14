/**
 * Vendored dense-embedding backend, adapted from fastembed-js v2.1.0
 * (https://github.com/Anush008/fastembed-js, MIT © Anush008) — see NOTICE.
 *
 * Why vendored instead of depended on: upstream `fastembed` pins
 * `onnxruntime-node@1.21.0` (whose `global-agent@3` chain drags in the
 * deprecated `boolean` package) and `tar@^6.2.0` (deprecated, and subject to
 * GHSA-23hp-3jrh-7fpw, fixed in tar 7.5.19). Those resolutions are baked into
 * every end-user install of `@vibgrate/cli` — package-manager overrides don't
 * propagate to consumers — so `npm install -g @vibgrate/cli` printed
 * `npm warn deprecated` on every install/update. Vendoring the one file the
 * CLI actually uses lets us declare `onnxruntime-node@^1.27` (global-agent@4,
 * no deprecated deps) and `tar@^7.5.19` directly.
 *
 * Deliberate divergences from upstream, beyond the dependency bumps:
 *  - Only the dense `FlagEmbedding` path is kept. The sparse SPLADE path
 *    (`SparseTextEmbedding`) is unused by the CLI and is dropped, which also
 *    drops upstream's `@huggingface/hub` dependency.
 *  - Upstream's `progress` dependency is replaced by a ~10-line stderr
 *    progress line (only shown when `showDownloadProgress` is set).
 *  - `import * as tar` (tar 7 has no default export) — the same adaptation the
 *    monorepo previously carried as a pnpm patch.
 *
 * Loaded lazily via dynamic import (see engine/embeddings.ts): the modules it
 * needs (`onnxruntime-node`, `@anush008/tokenizers`, `tar`) are OPTIONAL
 * dependencies, so this module must never be imported statically from any
 * always-loaded path — and it must not import them statically either. They are
 * loaded on demand by `ensureNativeDeps()`, which prefers a host-supplied
 * install (`VIBGRATE_EMBEDDER_PATH` — the VS Code extension installs the
 * native deps into its own storage on consent, since the bundled engine ships
 * without them) over this package's own dependency tree.
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tokenizer } from '@anush008/tokenizers';
import type { InferenceSession, Tensor } from 'onnxruntime-node';

/** The lazily-loaded optional modules the dense backend runs on. */
export interface NativeDeps {
  ort: typeof import('onnxruntime-node');
  tokenizers: typeof import('@anush008/tokenizers');
  tar: typeof import('tar');
}

let nativeDeps: NativeDeps | null = null;

/** A CJS module imported over ESM may nest its exports a `default` deep. */
function unwrapCjs(mod: any, key: string): any {
  for (const candidate of [mod, mod?.default, mod?.default?.default]) {
    if (candidate?.[key] !== undefined) return candidate;
  }
  return mod;
}

/**
 * Import one optional module, preferring the host dir a consenting editor
 * integration installed it into (`VIBGRATE_EMBEDDER_PATH`) over this package's
 * own tree — the copy the user consented to is the one that loads. On failure
 * the error names every path tried, so "not installed" stays actionable.
 */
async function importNative(spec: string): Promise<any> {
  const hostDir = process.env.VIBGRATE_EMBEDDER_PATH;
  let hostError: string | undefined;
  if (hostDir) {
    try {
      const req = createRequire(path.join(hostDir, 'package.json'));
      return await import(pathToFileURL(req.resolve(spec)).href);
    } catch (e) {
      hostError = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    return await import(spec);
  } catch (e) {
    const own = e instanceof Error ? e.message : String(e);
    throw new Error(hostError ? `${own} (host ${hostDir}: ${hostError})` : own);
  }
}

/**
 * Load (once) the optional native modules the backend needs. Exported so the
 * engine's loader can surface a missing/broken install as "not-installed" with
 * the real reason, before any model work starts. A failed load is not cached —
 * an install that completes mid-session takes effect on the next call.
 */
export async function ensureNativeDeps(): Promise<NativeDeps> {
  if (nativeDeps) return nativeDeps;
  const [ortMod, tokMod, tarMod] = await Promise.all([
    importNative('onnxruntime-node'),
    importNative('@anush008/tokenizers'),
    importNative('tar'),
  ]);
  nativeDeps = {
    ort: unwrapCjs(ortMod, 'InferenceSession'),
    tokenizers: unwrapCjs(tokMod, 'Tokenizer'),
    tar: unwrapCjs(tarMod, 'x'),
  };
  return nativeDeps;
}

/** The loaded modules — callable only after `ensureNativeDeps()` resolved. */
function native(): NativeDeps {
  if (!nativeDeps) throw new Error('embedding backend used before ensureNativeDeps()');
  return nativeDeps;
}

export enum ExecutionProvider {
  CPU = 'cpu',
  CUDA = 'cuda',
  WebGL = 'webgl',
  WASM = 'wasm',
  XNNPACK = 'xnnpack',
}

export enum EmbeddingModel {
  AllMiniLML6V2 = 'fast-all-MiniLM-L6-v2',
  BGEBaseEN = 'fast-bge-base-en',
  BGEBaseENV15 = 'fast-bge-base-en-v1.5',
  BGESmallEN = 'fast-bge-small-en',
  BGESmallENV15 = 'fast-bge-small-en-v1.5',
  BGESmallZH = 'fast-bge-small-zh-v1.5',
  MLE5Large = 'fast-multilingual-e5-large',
  CUSTOM = 'custom',
}

export interface InitOptions {
  model?: EmbeddingModel;
  executionProviders?: ExecutionProvider[];
  maxLength?: number;
  cacheDir?: string;
  showDownloadProgress?: boolean;
  /** Required (with `modelName`) when `model` is `EmbeddingModel.CUSTOM`. */
  modelAbsoluteDirPath?: string;
  modelName?: string;
}

interface ModelInfo {
  model: EmbeddingModel;
  dim: number;
  description: string;
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((acc, val) => acc + val * val, 0));
  const epsilon = 1e-12;
  return v.map((val) => val / Math.max(norm, epsilon));
}

/** Slice the flat [batch, seqLen, dim] output into one CLS vector per input. */
function getEmbeddings(data: ArrayLike<number>, dimensions: readonly number[]): number[][] {
  const [x, y, z] = dimensions as [number, number, number];
  const flat = Array.prototype.slice as (this: ArrayLike<number>, a: number, b: number) => number[];
  return new Array(x).fill(undefined).map((_, index) => {
    const startIndex = index * y * z;
    return flat.call(data, startIndex, startIndex + z);
  });
}

/** Minimal stderr progress line, replacing upstream's `progress` dependency. */
function renderProgress(model: string, received: number, total: number): void {
  const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
  const width = 20;
  const filled = Math.floor((pct / 100) * width);
  const bar = '='.repeat(filled) + ' '.repeat(width - filled);
  process.stderr.write(`\rDownloading ${model} [${bar}] ${pct}%`);
  if (total > 0 && received >= total) process.stderr.write('\n');
}

export class FlagEmbedding {
  private constructor(
    private readonly tokenizer: Tokenizer,
    private readonly session: InferenceSession,
    private readonly model: EmbeddingModel,
  ) {}

  static async init({
    model = EmbeddingModel.BGESmallENV15,
    executionProviders = [ExecutionProvider.CPU],
    maxLength = 512,
    cacheDir = 'local_cache',
    showDownloadProgress = true,
    modelAbsoluteDirPath = '',
    modelName = '',
  }: InitOptions = {}): Promise<FlagEmbedding> {
    await ensureNativeDeps();
    if (model === EmbeddingModel.CUSTOM) {
      if (!modelAbsoluteDirPath) {
        throw new Error('For custom model, modelAbsoluteDirPath is required in FlagEmbedding.init');
      }
      if (!modelName) {
        throw new Error('For custom model, modelName is required in FlagEmbedding.init');
      }
    }
    const modelDir =
      model === EmbeddingModel.CUSTOM
        ? modelAbsoluteDirPath
        : await FlagEmbedding.retrieveModel(model, cacheDir, showDownloadProgress);
    const tokenizer = this.loadTokenizer(modelDir, maxLength);
    const defaultModelName =
      model === EmbeddingModel.MLE5Large || model === EmbeddingModel.AllMiniLML6V2
        ? 'model.onnx'
        : 'model_optimized.onnx';
    const modelPath = path.join(modelDir, modelName || defaultModelName);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}`);
    }
    const session = await native().ort.InferenceSession.create(modelPath, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    return new FlagEmbedding(tokenizer, session, model);
  }

  private static loadTokenizer(modelDir: string, maxLength: number): Tokenizer {
    const tokenizerPath = path.join(modelDir, 'tokenizer.json');
    if (!fs.existsSync(tokenizerPath)) {
      throw new Error(`Tokenizer file not found at ${tokenizerPath}`);
    }
    const configPath = path.join(modelDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found at ${configPath}`);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const tokenizerConfigPath = path.join(modelDir, 'tokenizer_config.json');
    if (!fs.existsSync(tokenizerConfigPath)) {
      throw new Error(`Tokenizer file not found at ${tokenizerConfigPath}`);
    }
    const tokenizerConfig = JSON.parse(fs.readFileSync(tokenizerConfigPath, 'utf-8')) as Record<string, unknown>;
    maxLength = Math.min(maxLength, Number(tokenizerConfig['model_max_length']));
    const tokensMapPath = path.join(modelDir, 'special_tokens_map.json');
    if (!fs.existsSync(tokensMapPath)) {
      throw new Error(`Tokens map file not found at ${tokensMapPath}`);
    }
    const tokensMap = JSON.parse(fs.readFileSync(tokensMapPath, 'utf-8')) as Record<string, unknown>;

    const { Tokenizer, AddedToken } = native().tokenizers;
    const tokenizer = Tokenizer.fromFile(tokenizerPath);
    tokenizer.setTruncation(maxLength);
    tokenizer.setPadding({
      maxLength,
      padId: config['pad_token_id'] as number,
      padToken: tokenizerConfig['pad_token'] as string,
    });
    for (const token of Object.values(tokensMap)) {
      if (typeof token === 'string') {
        tokenizer.addSpecialTokens([token]);
      } else if (isAddedTokenMap(token)) {
        const addedToken = new AddedToken(token.content, true, {
          singleWord: token.single_word,
          leftStrip: token.lstrip,
          rightStrip: token.rstrip,
          normalized: token.normalized,
        });
        tokenizer.addAddedTokens([addedToken]);
      }
    }
    return tokenizer;
  }

  private static async downloadFileFromGCS(
    outputFilePath: string,
    model: string,
    showDownloadProgress = true,
  ): Promise<string> {
    if (fs.existsSync(outputFilePath)) {
      return outputFilePath;
    }
    // The AllMiniLML6V2 model URL doesn't follow the same naming convention as
    // the other models, so "fast-all-MiniLM-L6-v2" becomes
    // "sentence-transformers-all-MiniLM-L6-v2" in the download URL while the
    // GCS directory name stays "fast-all-MiniLM-L6-v2".
    if (model === EmbeddingModel.AllMiniLML6V2) {
      model = 'sentence-transformers' + model.substring(model.indexOf('-'));
    }
    const url = `https://storage.googleapis.com/qdrant-fastembed/${model}.tar.gz`;
    const fileStream = fs.createWriteStream(outputFilePath);
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
          const totalSizeInBytes = parseInt(response.headers['content-length'] || '0', 10);
          if (totalSizeInBytes === 0) {
            console.warn(`Warning: Content-length header is missing or zero in the response from ${url}.`);
          }
          if (showDownloadProgress) {
            let received = 0;
            response.on('data', (chunk: Buffer) => {
              received += chunk.length;
              renderProgress(model, received, totalSizeInBytes);
            });
          }
          response.on('error', reject);
          response.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(outputFilePath);
          });
          fileStream.on('error', reject);
        })
        .on('error', (error) => {
          fs.unlink(outputFilePath, () => {
            reject(error);
          });
        });
    });
  }

  private static async decompressToCache(targzPath: string, cacheDir: string): Promise<void> {
    if (path.extname(targzPath) === '.gz') {
      await native().tar.x({ file: targzPath, cwd: cacheDir });
    } else {
      throw new Error(`Unsupported file extension: ${targzPath}`);
    }
  }

  private static async retrieveModel(model: EmbeddingModel, cacheDir: string, showDownloadProgress = true): Promise<string> {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { mode: 0o777 });
    }
    const modelDir = path.join(cacheDir, model);
    if (fs.existsSync(modelDir)) {
      return modelDir;
    }
    const modelTarGz = path.join(cacheDir, `${model}.tar.gz`);
    await this.downloadFileFromGCS(modelTarGz, model, showDownloadProgress);
    await this.decompressToCache(modelTarGz, cacheDir);
    fs.unlinkSync(modelTarGz);
    return modelDir;
  }

  async *embed(textStrings: string[], batchSize = 256): AsyncGenerator<number[][]> {
    for (let i = 0; i < textStrings.length; i += batchSize) {
      const batchTexts = textStrings.slice(i, i + batchSize);
      const encodedTexts = await Promise.all(batchTexts.map((textString) => this.tokenizer.encode(textString)));
      const idsArray: bigint[][] = [];
      const maskArray: bigint[][] = [];
      const typeIdsArray: bigint[][] = [];
      for (const text of encodedTexts) {
        idsArray.push(text.getIds().map(BigInt));
        maskArray.push(text.getAttentionMask().map(BigInt));
        typeIdsArray.push(text.getTypeIds().map(BigInt));
      }
      const maxLength = idsArray[0]!.length;
      const dims = [batchTexts.length, maxLength];
      const ort = native().ort;
      const inputs: Record<string, Tensor> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(idsArray.flat()), dims),
        attention_mask: new ort.Tensor('int64', BigInt64Array.from(maskArray.flat()), dims),
        token_type_ids: new ort.Tensor('int64', BigInt64Array.from(typeIdsArray.flat()), dims),
      };
      // MLE5Large's graph has no token_type_ids input.
      if (this.model === EmbeddingModel.MLE5Large) {
        delete inputs.token_type_ids;
      }
      const output = await this.session.run(inputs);
      const hidden = output.last_hidden_state!;
      const embeddings = getEmbeddings(hidden.data as ArrayLike<number>, hidden.dims);
      yield embeddings.map(normalize);
    }
  }

  passageEmbed(texts: string[], batchSize = 256): AsyncGenerator<number[][]> {
    return this.embed(
      texts.map((text) => `passage: ${text}`),
      batchSize,
    );
  }

  async queryEmbed(query: string): Promise<number[]> {
    return (await this.embed([`query: ${query}`]).next()).value![0]!;
  }

  listSupportedModels(): ModelInfo[] {
    return [
      { model: EmbeddingModel.BGESmallEN, dim: 384, description: 'Fast English model' },
      { model: EmbeddingModel.BGESmallENV15, dim: 384, description: 'v1.5 release of the fast, default English model' },
      { model: EmbeddingModel.BGEBaseEN, dim: 768, description: 'Base English model' },
      { model: EmbeddingModel.BGEBaseENV15, dim: 768, description: 'v1.5 release of Base English model' },
      { model: EmbeddingModel.BGESmallZH, dim: 512, description: 'v1.5 release of the fast, Chinese model' },
      { model: EmbeddingModel.AllMiniLML6V2, dim: 384, description: 'Sentence Transformer model, MiniLM-L6-v2' },
      {
        model: EmbeddingModel.MLE5Large,
        dim: 1024,
        description: 'Multilingual model, e5-large. Recommend using this model for non-English languages',
      },
    ];
  }
}

interface AddedTokenMap {
  content: string;
  single_word: boolean;
  lstrip: boolean;
  rstrip: boolean;
  normalized: boolean;
}

function isAddedTokenMap(token: unknown): token is AddedTokenMap {
  return (
    typeof token === 'object' &&
    token !== null &&
    'token' in token &&
    'single_word' in token &&
    'rstrip' in token &&
    'lstrip' in token &&
    'normalized' in token
  );
}
