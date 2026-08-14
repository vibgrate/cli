import { describe, it, expect, afterEach } from 'vitest';
import { ensureNativeDeps } from '../src/vendor/fastembed/index.js';
import { makeProject, cleanup } from './helpers.js';

/**
 * The host-dir contract for the vendored backend: an editor integration that
 * bundles the engine without the optional native deps installs them into its
 * own storage and points `VIBGRATE_EMBEDDER_PATH` at it (the VS Code
 * extension's consent install). `ensureNativeDeps` must resolve the deps from
 * that directory — and prefer it over this workspace's own tree, so the copies
 * the user consented to are the ones that load.
 */
describe('vendored backend native-dep resolution', () => {
  const saved = process.env.VIBGRATE_EMBEDDER_PATH;
  let host: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env.VIBGRATE_EMBEDDER_PATH;
    else process.env.VIBGRATE_EMBEDDER_PATH = saved;
    if (host) cleanup(host);
    host = undefined;
  });

  it('prefers the host-supplied native deps over the package tree', async () => {
    host = makeProject({
      'node_modules/onnxruntime-node/package.json': JSON.stringify({
        name: 'onnxruntime-node',
        version: '0.0.0-test',
        main: 'index.cjs',
      }),
      'node_modules/onnxruntime-node/index.cjs':
        'module.exports = { InferenceSession: { hostMarker: true }, Tensor: class {} };',
      'node_modules/@anush008/tokenizers/package.json': JSON.stringify({
        name: '@anush008/tokenizers',
        version: '0.0.0-test',
        main: 'index.cjs',
      }),
      'node_modules/@anush008/tokenizers/index.cjs':
        'module.exports = { Tokenizer: class {}, AddedToken: class {} };',
      'node_modules/tar/package.json': JSON.stringify({ name: 'tar', version: '0.0.0-test', main: 'index.cjs' }),
      'node_modules/tar/index.cjs': 'module.exports = { x: async () => {} };',
    });
    process.env.VIBGRATE_EMBEDDER_PATH = host;

    const deps = await ensureNativeDeps();
    expect((deps.ort.InferenceSession as unknown as { hostMarker?: boolean }).hostMarker).toBe(true);
    expect(typeof deps.tokenizers.Tokenizer).toBe('function');
    expect(typeof deps.tar.x).toBe('function');
  });
});
