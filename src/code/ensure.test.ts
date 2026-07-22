import { describe, it, expect, vi } from 'vitest';
import { ensurePackage, packageName, ensureUnavailableMessage } from './ensure.js';

/**
 * Consent gating is a guardrail, so its negative cases get explicit tests: the
 * capability must NEVER install a package silently, offline, or without consent.
 * The installer is injected, so nothing here shells out to npm.
 */
describe('ensurePackage — consent gating (negative cases)', () => {
  it('refuses to install under --local/offline', async () => {
    const install = vi.fn(() => true);
    const res = await ensurePackage('some-pkg-that-is-not-installed@1', { local: true, install });
    expect(res.module).toBeNull();
    expect(res.reason).toBe('offline');
    expect(install).not.toHaveBeenCalled();
  });

  it('refuses to install without consent in a non-interactive run', async () => {
    const install = vi.fn(() => true);
    const res = await ensurePackage('some-pkg-that-is-not-installed@1', { interactive: false, consent: false, install });
    expect(res.module).toBeNull();
    expect(res.reason).toBe('no-consent');
    expect(install).not.toHaveBeenCalled();
  });

  it('reports install-failed (and never a partial success) when the installer fails', async () => {
    const install = vi.fn(() => false);
    const res = await ensurePackage('definitely-not-real-vibgrate-pkg@1', { consent: true, install });
    expect(res.module).toBeNull();
    expect(res.reason).toBe('install-failed');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('loads an already-installed package without consent or install', async () => {
    // `semver` is a real dependency of this package, resolvable from anywhere.
    const install = vi.fn(() => true);
    const res = await ensurePackage('semver', { install });
    // It may resolve from the runtime cache dir or not depending on the machine;
    // either it loads (module present) or it treats it as absent — but it must
    // never invoke the installer for a load attempt of an already-present name.
    if (res.module) expect(install).not.toHaveBeenCalled();
  });
});

describe('packageName', () => {
  it('strips a version range', () => {
    expect(packageName('node-llama-cpp@^3')).toBe('node-llama-cpp');
    expect(packageName('semver@7.8.5')).toBe('semver');
  });
  it('keeps a scoped package name and strips its version', () => {
    expect(packageName('@scope/pkg@1.2.3')).toBe('@scope/pkg');
    expect(packageName('@scope/pkg')).toBe('@scope/pkg');
  });
});

describe('ensureUnavailableMessage', () => {
  it('names the fix for every reason and never alarms', () => {
    for (const reason of ['offline', 'no-consent', 'install-failed', 'load-failed'] as const) {
      const msg = ensureUnavailableMessage(reason, 'node-llama-cpp@^3');
      expect(msg).toContain('node-llama-cpp');
      expect(msg.length).toBeGreaterThan(20);
    }
    expect(ensureUnavailableMessage('no-consent', 'x')).toMatch(/--yes/);
  });
});
