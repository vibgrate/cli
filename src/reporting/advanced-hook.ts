import type { AdvancedScanHook } from '@vibgrate/core-open';

/**
 * Open build: there is no proprietary advanced-analysis hook.
 *
 * In the public, Apache-2.0 distribution every reporting command runs purely on
 * the open base engine (`runCoreScan` from `@vibgrate/core-open`). This shim
 * keeps the call sites in `scan`/`baseline` unchanged while always resolving to
 * `undefined`, so the scan falls back to the open base engine.
 */
export async function loadAdvancedScanHook(): Promise<AdvancedScanHook | undefined> {
  return undefined;
}
