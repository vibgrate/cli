// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Race a promise against a timeout.  If the promise doesn't resolve within
 * `ms` milliseconds the result is `{ ok: false }`.
 *
 * The underlying promise is NOT cancelled — callers should treat a timeout
 * as "skip and move on".
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    const result = await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      timeout,
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
