import { describe, it, expect, afterEach } from 'vitest';
import { ensureNativeDeps, quietNativeRuntime } from '../src/vendor/fastembed/index.js';
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
        "module.exports = { InferenceSession: { hostMarker: true }, Tensor: class {}, env: { logLevel: 'warning' } };",
      'node_modules/tokenizers/package.json': JSON.stringify({
        name: 'tokenizers',
        version: '0.0.0-test',
        main: 'index.cjs',
      }),
      'node_modules/tokenizers/index.cjs':
        'module.exports = { Tokenizer: class {}, AddedToken: class {} };',
      'node_modules/tar/package.json': JSON.stringify({ name: 'tar', version: '0.0.0-test', main: 'index.cjs' }),
      'node_modules/tar/index.cjs': 'module.exports = { x: async () => {} };',
    });
    process.env.VIBGRATE_EMBEDDER_PATH = host;

    const deps = await ensureNativeDeps();
    expect((deps.ort.InferenceSession as unknown as { hostMarker?: boolean }).hostMarker).toBe(true);
    expect(typeof deps.tokenizers.Tokenizer).toBe('function');
    expect(typeof deps.tar.x).toBe('function');
    // The runtime's own logger is quietened before any session exists, so its
    // device-discovery warning never reaches the user's terminal.
    expect((deps.ort as unknown as { env: { logLevel: string } }).env.logLevel).toBe('error');
  });
});

/**
 * onnxruntime's native environment is created with the severity in the shared
 * `env.logLevel`; at the library default (`warning`) it prints its PCI
 * device-discovery warning straight to stderr on Hyper-V / WSL2 style hosts.
 * The backend lifts the default to `error` before the first session — and
 * only the default, so a host that chose a lower level for diagnostics keeps it.
 */
describe('quietNativeRuntime', () => {
  it('lifts the library default (warning) to error', () => {
    const ort = { env: { logLevel: 'warning' } };
    quietNativeRuntime(ort);
    expect(ort.env.logLevel).toBe('error');
  });

  it('sets error when no level has been set at all', () => {
    const ort = { env: {} as { logLevel?: string } };
    quietNativeRuntime(ort);
    expect(ort.env.logLevel).toBe('error');
  });

  it("keeps a level a host set deliberately ('verbose', 'info', 'fatal')", () => {
    for (const level of ['verbose', 'info', 'fatal']) {
      const ort = { env: { logLevel: level } };
      quietNativeRuntime(ort);
      expect(ort.env.logLevel).toBe(level);
    }
  });

  it('is a no-op on a module without an env object', () => {
    expect(() => quietNativeRuntime({})).not.toThrow();
    expect(() => quietNativeRuntime(null)).not.toThrow();
    expect(() => quietNativeRuntime(undefined)).not.toThrow();
  });

  it('swallows an env whose setter rejects the assignment', () => {
    const env = {
      get logLevel() {
        return 'warning';
      },
      set logLevel(_v: string) {
        throw new Error('read-only');
      },
    };
    expect(() => quietNativeRuntime({ env })).not.toThrow();
  });
});
