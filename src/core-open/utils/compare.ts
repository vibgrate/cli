// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.

/**
 * Code-unit order (`<` / `>`).
 *
 * Bare `localeCompare` follows the process locale (`LANG` / `LC_ALL`). Estonian
 * collates `z` before `t`, so the same package names can reorder across
 * machines. Machine-readable output (scan JSON, SARIF, SBOM, coded warnings)
 * uses this comparator instead.
 */
export function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
