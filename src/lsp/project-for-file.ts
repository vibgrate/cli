/**
 * Which scanned project owns a file the editor has open?
 *
 * Resolve against the *server's* workspace root, not `artifact.rootPath`.
 * The artifact carries a portable relative root (it is uploaded and compared
 * across machines), so resolving against it lands on the process cwd — which
 * is wherever the editor spawned us from, not the workspace. That mismatch
 * silently produces zero decorations: the Explorer score still renders
 * (longest-prefix falls through to the repo root) and every in-editor
 * surface is empty.
 *
 * Manifests (`package.json`, `go.mod`, …) are exact-directory only. A nested
 * package that the workspace scan skipped (auto-exclude / timeout) must not
 * inherit the parent project's dependencies — those names are not in the
 * file, so `findPackageLine` returns nothing and the overlay stays blank
 * while the badge still shows the parent's DriftScore.
 */

import * as path from 'node:path';
import { isManifest } from './manifest-positions.js';

export function projectDir(root: string, projectPath: string): string {
  const rel = projectPath === '' || projectPath === '.' ? '' : projectPath;
  return rel ? path.resolve(root, rel) : path.resolve(root);
}

export function projectForFile<T extends { path: string }>(
  root: string,
  projects: readonly T[],
  filePath: string,
): T | undefined {
  const dir = path.dirname(path.resolve(filePath));

  for (const proj of projects) {
    if (projectDir(root, proj.path) === dir) return proj;
  }

  if (isManifest(filePath)) return undefined;

  let best: T | undefined;
  let bestLen = -1;
  for (const proj of projects) {
    const projDir = projectDir(root, proj.path);
    if ((dir === projDir || dir.startsWith(projDir + path.sep)) && projDir.length > bestLen) {
      best = proj;
      bestLen = projDir.length;
    }
  }
  return best;
}
