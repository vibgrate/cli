// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * UTF-16 code-unit order.
 *
 * `localeCompare` and `Intl.Collator` follow the process locale (`LANG` /
 * `LC_ALL`). A sort that uses them changes JSON, SARIF, and SBOM bytes
 * between machines. `<` and `>` compare code units and do not.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
