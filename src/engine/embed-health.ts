/**
 * Preflight for the native embedding backend.
 *
 * `fastembed` runs inference through `onnxruntime-node`, a native addon whose
 * platform binaries are fetched by a postinstall script. When that script does
 * not run — npm `allowScripts`/`ignore-scripts` hardening, an offline or
 * proxied install, an unsupported platform — the JS module still imports
 * cleanly and `loadEmbedder` reports success. The process then dies with
 * SIGTRAP the moment inference actually starts.
 *
 * That failure mode defeats every guard in `engine/embeddings.ts`: a signal
 * kills the process outright, so the try/catch never runs, the timeout never
 * fires, and the lexical floor never answers. In `vg lsp` it took down the
 * whole language server mid-request and the host restarted it, three times,
 * reporting only "will retry on first use".
 *
 * So the addon is exercised in a SACRIFICIAL CHILD PROCESS first. The child
 * embeds one short string; if it dies by signal, this process knows never to
 * load the backend at all, and semantic degrades to lexical the way it was
 * always designed to.
 *
 * Only a crash verdict is remembered. A probe that fails for any other reason
 * (model not downloaded yet, no cache permission) resolves to `unknown` and
 * changes nothing — the normal path still runs and still reports its own
 * reason. Disabling a working feature on weak evidence would be worse than
 * the bug this fixes.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../version.js';

/** Verdict for the native backend on this machine. */
export type EmbedHealth =
  | { status: 'ok' }
  /** The addon killed its process — never load it in-process. */
  | { status: 'crashed'; signal: string; message: string }
  /** Nothing conclusive; proceed exactly as before. */
  | { status: 'unknown' };

export interface ProbeOptions {
  /** Milliseconds before the probe is abandoned as inconclusive. */
  timeoutMs?: number;
  /** Where the verdict is remembered (defaults to the shared model cache). */
  cacheDir?: string;
  /** Injected runner (tests). */
  runProbe?: (timeoutMs: number) => Promise<{ signal: string | null; status: number | null; stdout: string }>;
  /** Ignore any remembered verdict and re-probe. */
  force?: boolean;
}

/**
 * The actionable message for a crashed backend. Names the likely cause and a
 * repair that actually converges, because "the semantic model couldn't load"
 * sends nobody anywhere. (Not a script block: onnxruntime-node's CPU binaries
 * ship inside its npm package — its postinstall only fetches CUDA GPU extras
 * the embedder never loads. A crash here means the installed native files are
 * broken — a half-extracted install, or a platform its prebuilds don't cover —
 * so the fix is a clean reinstall; allow-scripts lets our own postinstall
 * clear this verdict. On linux the command carries ONNXRUNTIME_NODE_INSTALL=skip
 * so the now-allowed onnxruntime-node script doesn't pull its linux/x64-only
 * CUDA download; the env var, never the `--onnxruntime-node-install=skip`
 * flag, which npm 12 rejects as an unknown option. Elsewhere the script
 * downloads nothing, and a POSIX env prefix wouldn't parse on cmd.exe anyway.)
 */
export function crashedMessage(signal: string): string {
  const envPrefix = process.platform === 'linux' ? 'ONNXRUNTIME_NODE_INSTALL=skip ' : '';
  return (
    `semantic search is disabled: its native backend (onnxruntime-node, via the vendored fastembed path) crashed with ${signal} — ` +
    `using fast lexical search instead. This usually means the installed native binaries are broken ` +
    `(an interrupted install, or a platform without prebuilt CPU binaries). Reinstall to repair — ` +
    `${envPrefix}npm install -g --allow-scripts=@vibgrate/cli,onnxruntime-node,msgpackr-extract @vibgrate/cli — ` +
    `or run with --local to stay lexical quietly.`
  );
}

/** Shared model cache — the verdict is per-machine, like the model itself. */
function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'models');
}

function verdictPath(dir: string): string {
  // Keyed by platform+arch: the same home directory can be shared across
  // machines (NFS, a synced dotfiles setup) where the verdict does not carry.
  return path.join(dir, `embed-health-${process.platform}-${process.arch}.json`);
}

/**
 * The installed CLI version, stamped into the verdict. A reinstall or upgrade
 * is the most likely moment for a broken native backend to become a working
 * one, so a version change must re-probe rather than inherit a stale verdict.
 * (`scripts/postinstall.mjs` also deletes the file outright, which covers a
 * SAME-version reinstall — the exact shape of "npm install -g
 * --allow-scripts=… @vibgrate/cli" run to fix a blocked postinstall. The two
 * mechanisms are complementary: postinstall only runs when scripts are
 * allowed, which is precisely when the fix may have landed.)
 */
interface StoredVerdict {
  status: 'ok' | 'crashed';
  signal?: string;
  at: string;
  /** CLI version that produced this verdict; a mismatch re-probes. */
  version?: string;
}

function readVerdict(dir: string): StoredVerdict | null {
  try {
    const raw = JSON.parse(fs.readFileSync(verdictPath(dir), 'utf8')) as StoredVerdict;
    if (raw?.status !== 'ok' && raw?.status !== 'crashed') return null;
    // A verdict from a different build says nothing about this one.
    if (raw.version !== VERSION) return null;
    return raw;
  } catch {
    /* absent or corrupt — re-probe */
  }
  return null;
}

function writeVerdict(dir: string, verdict: StoredVerdict): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(verdictPath(dir), JSON.stringify(verdict, null, 2) + '\n', 'utf8');
  } catch {
    // A read-only cache costs a probe per run, not correctness.
  }
}

/**
 * Module the probe child imports to call `loadEmbedder`.
 *
 * After tsup, this file is inlined into `dist/cli.js` (and other entry chunks):
 * there is **no** sibling `embeddings.js`, so the historical
 * `new URL('./embeddings.js', import.meta.url)` always failed with
 * `ERR_MODULE_NOT_FOUND`, the probe wrote `{"ok":false}`, and health stayed
 * `unknown`. The language server then loaded onnxruntime in-process, hit
 * SIGTRAP on first inference, and died mid-Ask — the exact failure mode this
 * module exists to prevent.
 *
 * Published layout ships `dist/index.js`, which re-exports `loadEmbedder`.
 * Unbundled / source-adjacent layouts still have `embeddings.js` next to this
 * file. Prefer whichever exists.
 */
export function probeModuleUrl(from: string = import.meta.url): string {
  const dir = path.dirname(fileURLToPath(from));
  for (const name of ['embeddings.js', 'index.js']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  // Last resort: keep a stable URL so the child fails cleanly as unknown
  // rather than throwing before spawn.
  return pathToFileURL(path.join(dir, 'index.js')).href;
}

/**
 * The child: load the backend and embed one query + one document. Anything
 * else is a crash. Asynchronous on purpose — `vg lsp` calls this from a
 * request handler, and a synchronous spawn would freeze the server for the
 * whole model load.
 *
 * Both query and document paths are exercised: some backends (and some
 * Electron/Node ABI mismatches) survive `queryEmbed` and only abort on the
 * passage/`embed` path that Ask uses when indexing nodes.
 */
function defaultRunProbe(timeoutMs: number): Promise<{ signal: string | null; status: number | null; stdout: string }> {
  const moduleUrl = probeModuleUrl();
  const script = `
    import(${JSON.stringify(moduleUrl)})
      .then(async (m) => {
        if (typeof m.loadEmbedder !== 'function') {
          process.stdout.write('{"ok":false}');
          return;
        }
        const e = await m.loadEmbedder({ noDownload: true });
        if (!e) { process.stdout.write('{"ok":false}'); return; }
        await e.embedQuery('probe');
        await e.embed(['probe document']);
        process.stdout.write('{"ok":true}');
      })
      .catch(() => process.stdout.write('{"ok":false}'));
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      // The probe must never inherit a debugger port or loader flags that would
      // change what it proves about the addon.
      env: { ...process.env, NODE_OPTIONS: '' },
      // Console-less hosts (vgd, editor-spawned servers) must not pop a
      // visible console window for the probe on Windows.
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const done = (signal: string | null, status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ signal, status, stdout });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM'); // read back as inconclusive, never as a crash
      done('SIGTERM', null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.on('error', () => done(null, null));
    child.on('close', (code, signal) => done(signal ?? null, code ?? null));
  });
}

/**
 * Whether the native embedding backend can be loaded in this process. Cached
 * per machine; the probe costs one short-lived child the first time and
 * nothing thereafter.
 */
export async function embedderHealth(options: ProbeOptions = {}): Promise<EmbedHealth> {
  const dir = options.cacheDir ?? defaultCacheDir();

  if (!options.force) {
    const stored = readVerdict(dir);
    if (stored?.status === 'ok') return { status: 'ok' };
    if (stored?.status === 'crashed') {
      const signal = stored.signal ?? 'a fatal signal';
      return { status: 'crashed', signal, message: crashedMessage(signal) };
    }
  }

  const run = options.runProbe ?? defaultRunProbe;
  let res: { signal: string | null; status: number | null; stdout: string };
  try {
    res = await run(options.timeoutMs ?? 30_000);
  } catch {
    return { status: 'unknown' }; // could not even spawn — change nothing
  }

  if (res.signal) {
    // SIGTERM is our own timeout, not the addon dying.
    if (res.signal === 'SIGTERM') return { status: 'unknown' };
    writeVerdict(dir, { status: 'crashed', signal: res.signal, at: new Date().toISOString(), version: VERSION });
    return { status: 'crashed', signal: res.signal, message: crashedMessage(res.signal) };
  }

  if (res.stdout.includes('"ok":true')) {
    writeVerdict(dir, { status: 'ok', at: new Date().toISOString(), version: VERSION });
    return { status: 'ok' };
  }

  // A clean "could not load" (model absent, no permission) is NOT a crash —
  // leave it to the existing path, which reports the specific reason.
  return { status: 'unknown' };
}

/** Forget a stored verdict (used by `vg embed --clear`, and after a reinstall). */
export function clearEmbedderHealth(cacheDir?: string): void {
  try {
    fs.unlinkSync(verdictPath(cacheDir ?? defaultCacheDir()));
  } catch {
    /* nothing stored */
  }
}

/** Exposed for tests that need the on-disk location. */
export function embedHealthPath(cacheDir?: string): string {
  return verdictPath(cacheDir ?? defaultCacheDir());
}
