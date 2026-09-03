/**
 * Moved to packages/vibgrate-haile. The public CLI does not load a .wasm
 * file directly and does not honour HAILE_WASM / HAILE_BIN / HAILE_MODULE.
 */
export function loadWasmHaileKernel(): null {
  return null;
}

export function resetWasmHaileKernelCache(): void {
  /* no-op — kernel lives in the installed module */
}
