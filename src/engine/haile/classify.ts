/**
 * IP BOUNDARY — this file must not contain a lexicon.
 *
 * Classification lives in the separately installed architecture module.
 * The public CLI loads that module from the cache (or VIBGRATE_HAILE_PATH)
 * and only reads the classify file it writes.
 *
 * Do not add token weights, path rules, softmax, or purpose floors here.
 * If a caller still imports classifyCallable / classifyAll, it is a bug.
 */

export function classifyCallable(): never {
  throw new Error(
    'Architecture classify is not shipped in the public CLI. The architecture module installs by default; set VIBGRATE_NO_KERNEL=1 to disable it.',
  );
}

export function classifyAll(): never {
  throw new Error(
    'Architecture classify is not shipped in the public CLI. The architecture module installs by default; set VIBGRATE_NO_KERNEL=1 to disable it.',
  );
}
