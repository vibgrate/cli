import { Command, Option } from 'commander';
import {
  loadEmbedder,
  getNodeEmbeddings,
  resolveEmbedModel,
  countPending,
  embeddingsCached,
  modelCacheInfo,
  clearModelCache,
  unavailableMessage,
  type EmbedUnavailable,
} from '../engine/embeddings.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { c, info, json } from '../util/output.js';
import { ProgressBar } from '../util/progress.js';

function mb(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * `vg embed` — precompute the semantic index (node embeddings) so the next
 * `vg ask` is instant. The model is downloaded once per machine into a central,
 * home-folder cache (XDG `~/.cache/vibgrate/models`; no admin/sudo needed) shared
 * across all repos; per-repo vectors live in `.vibgrate/cache/`.
 *
 * `--where` shows the cache location/size; `--clear` removes the model. The
 * hidden `--bg` flag warms silently and never downloads (the `vg build` warm-up).
 */
export function registerEmbed(program: Command): void {
  const cmd = program
    .command('embed')
    .description('precompute the semantic index for instant `vg ask` (or --where / --clear)')
    .option('--where', 'show where the model is cached, and its size')
    .option('--clear', 'remove the downloaded model from the shared cache')
    // --bg: the silent, no-download background warm-up spawned by `vg build`.
    .addOption(new Option('--bg').hideHelp())
    .action(async function (this: Command, opts: { where?: boolean; clear?: boolean; bg?: boolean }) {
      const global = readGlobal(this);
      const modelId = resolveEmbedModel();

      // --where / --clear don't need a built graph.
      if (opts.where) return showWhere(rootOf(global), modelId, global.json);
      if (opts.clear) return doClear(global.json);

      const { graph } = requireGraph(global);
      const root = rootOf(global);
      const bg = opts.bg === true;
      const speak = !bg && !global.json;

      if (global.local) {
        if (speak) info(c.dim('vg embed · semantic is off (--local) — lexical search only'));
        return;
      }
      if (countPending(graph, root, modelId) === 0) {
        if (global.json) json({ embedded: 0, pending: 0, upToDate: true, model: modelId });
        else if (speak) info(`${c.cyan('vg embed')} · semantic index already up to date`);
        return;
      }

      let reason: EmbedUnavailable | undefined;
      const embedder = await loadEmbedder({
        local: global.local,
        noDownload: bg, // background warm-up never downloads
        showDownloadProgress: !bg,
        onUnavailable: (r) => (reason = r),
      });
      if (!embedder) {
        // Calm, specific fallback — never a stack trace. (bg stays silent.)
        if (speak && reason) info(c.dim(`vg embed · ${unavailableMessage(reason)}`));
        return;
      }

      const pending = countPending(graph, root, modelId);
      const bar = speak ? new ProgressBar(c.dim('embedding')) : undefined;
      await getNodeEmbeddings(graph, embedder, root, bar ? (d, t) => bar.update(d, t) : undefined);
      bar?.done();
      if (global.json) json({ embedded: pending, model: modelId });
      else if (speak) info(`${c.green('✔')} vg embed · semantic index ready (~${pending} node(s) · model ${modelId})`);
    });
  applyGlobalOptions(cmd);
}

function showWhere(root: string, modelId: string, asJson?: boolean): void {
  const m = modelCacheInfo(modelId);
  const repoCached = embeddingsCached(root, modelId);
  if (asJson) {
    json({ model: modelId, cacheDir: m.dir, present: m.present, bytes: m.bytes, repoEmbeddings: repoCached });
    return;
  }
  info(`${c.cyan('vg embed')} · model cache`);
  info(`  model     ${c.bold(modelId)}`);
  info(`  shared at ${m.dir}`);
  info(`            ${m.present ? c.green(`present · ~${mb(m.bytes)}`) : c.dim('not downloaded yet (fetched on first semantic ask)')}`);
  info(`  this repo ${repoCached ? c.green('embeddings cached') : c.dim('not embedded yet — run `vg embed`')}`);
  info(c.dim('  no admin/sudo needed — the cache is in your home folder, shared across all repos.'));
  info(c.dim('  turn off: run with --local · relocate: XDG_CACHE_HOME=<dir> · remove: vg embed --clear'));
}

function doClear(asJson?: boolean): void {
  const before = modelCacheInfo();
  const freed = clearModelCache();
  if (asJson) {
    json({ removed: before.present, bytesFreed: freed, dir: before.dir });
    return;
  }
  if (!before.present || freed === 0) {
    info(`${c.cyan('vg embed')} · no model in the shared cache — nothing to remove (${before.dir})`);
    return;
  }
  info(`${c.green('✔')} vg embed · removed the shared model (~${mb(freed)}) from ${before.dir}`);
  info(c.dim('  repos use fast lexical search until the next semantic ask re-downloads it.'));
}
