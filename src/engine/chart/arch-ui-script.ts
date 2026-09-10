/**
 * Load the minified Architecture map canvas (React Flow) from the module pack.
 * Absent pack → null; the host keeps the vanilla HTML canvas.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HaileProvider } from '../haile/haile-provider.js';

const MAX_BYTES = 2_000_000;

export function readArchUiScript(provider: HaileProvider | null): string | null {
  const dir = provider?.archUiAssets?.();
  if (!dir || typeof dir !== 'string') return null;
  const file = path.join(dir, 'map.js');
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const js = fs.readFileSync(file, 'utf8');
    if (js.length < 40 || js.length > MAX_BYTES) return null;
    if (/<\/script/i.test(js) || /HAILE/i.test(js)) return null;
    return js;
  } catch {
    return null;
  }
}
