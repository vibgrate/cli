/**
 * IP BOUNDARY — this file must not contain a lexicon.
 *
 * Intent rendering lives in the optional `@vibgrate/haile` module.
 * Do not add verb tokens, purpose maps, noun extractors, or templates here.
 */
export function renderIntent(): never {
  throw new Error(
    'HAILE intent is not shipped in the public CLI. Install the architecture module (`vg module install haile`) or set VIBGRATE_HAILE_PATH.',
  );
}
