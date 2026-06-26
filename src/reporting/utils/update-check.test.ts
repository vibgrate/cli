import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';

// We need to mock the VERSION import and the fetch global
// Mock VERSION before importing the module under test
vi.mock('../version.js', () => ({ VERSION: '1.0.0' }));

// We'll also mock os.homedir so cache goes to a temp dir
const mockHomeDir = await fs.mkdtemp(path.join(tmpdir(), 'vibgrate-update-test-'));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHomeDir };
});

// Now import after mocks are set up
const { checkForUpdate, fetchLatestVersion } = await import('./update-check.js');

describe('update-check', () => {
  const cacheDir = path.join(mockHomeDir, '.vibgrate');
  const cacheFile = path.join(cacheDir, 'update-check.json');

  beforeEach(async () => {
    // Clean cache between tests
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('checkForUpdate', () => {
    it('returns updateAvailable=true when registry has newer version', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0' }),
      }));

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.current).toBe('1.0.0');
      expect(result!.latest).toBe('2.0.0');
      expect(result!.updateAvailable).toBe(true);
    });

    it('returns updateAvailable=false when on latest version', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.0.0' }),
      }));

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(false);
    });

    it('returns updateAvailable=false when registry version is older', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '0.5.0' }),
      }));

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(false);
    });

    it('returns null when fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      const result = await checkForUpdate();
      expect(result).toBeNull();
    });

    it('clears abort timer when fetch rejects early', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      await checkForUpdate();

      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it('returns null when registry returns non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const result = await checkForUpdate();
      expect(result).toBeNull();
    });

    it('returns null when registry returns invalid version', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: 'not-a-semver' }),
      }));

      const result = await checkForUpdate();
      expect(result).toBeNull();
    });

    it('uses cached result within 24 hours', async () => {
      // Write a cache file with a recent timestamp
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({
        latest: '3.0.0',
        checkedAt: Date.now(), // fresh
      }));

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.latest).toBe('3.0.0');
      expect(result!.updateAvailable).toBe(true);
      // fetch should NOT have been called — cache was fresh
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores stale cache and fetches fresh data', async () => {
      // Write a cache file with an old timestamp
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({
        latest: '1.5.0',
        checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      }));

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0' }),
      }));

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.latest).toBe('2.0.0');
      expect(result!.updateAvailable).toBe(true);
    });

    it('writes cache after successful fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0' }),
      }));

      await checkForUpdate();

      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
      expect(cached.latest).toBe('2.0.0');
      expect(typeof cached.checkedAt).toBe('number');
    });
  });

  describe('fetchLatestVersion', () => {
    it('returns latest version string from registry', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '2.5.0' }),
      }));

      const result = await fetchLatestVersion();
      expect(result).toBe('2.5.0');
    });

    it('returns null on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    });

    it('clears abort timer when fetch rejects early', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

      await fetchLatestVersion();

      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it('returns null for non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    });

    it('returns null for invalid version in response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '' }),
      }));

      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    });

    it('returns null when version field is missing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'vibgrate' }),
      }));

      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    });

    it('updates cache after fetching', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '4.0.0' }),
      }));

      await fetchLatestVersion();

      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
      expect(cached.latest).toBe('4.0.0');
    });
  });
});
