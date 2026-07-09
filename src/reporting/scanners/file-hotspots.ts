import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectScan, FileHotspotsResult, FileHotspot, PackageCentrality } from '../../core-open/index.js';
import { FileCache } from '../../core-open/index.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.wrangler', '.next', 'dist', 'build', 'out',
  '.turbo', '.cache', 'coverage', 'bin', 'obj', '.vs',
  'TestResults', '.nuxt', '.output', '.svelte-kit',
]);

const SKIP_EXTENSIONS = new Set([
  '.map', '.lock', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.svg', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm',
]);

export async function scanFileHotspots(rootDir: string, cache?: FileCache): Promise<FileHotspotsResult> {
  const extensionCounts: Record<string, number> = {};
  const allFiles: FileHotspot[] = [];
  let maxDepth = 0;

  if (cache) {
    // Use the cached walk (already walked by other scanners)
    const entries = await cache.walkDir(rootDir);

    for (const entry of entries) {
      if (!entry.isFile) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) continue;

      // Compute depth
      const depth = entry.relPath.split(path.sep).length - 1;
      if (depth > maxDepth) maxDepth = depth;

      // Count by extension
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;

      // Stat inline — not cached, only file-hotspots needs sizes
      try {
        const stat = await fs.stat(entry.absPath);
        allFiles.push({
          path: entry.relPath,
          bytes: stat.size,
        });
      } catch { /* skip */ }
    }
  } else {
    // Fallback: original walk implementation
    async function walk(dir: string, depth: number) {
      if (depth > maxDepth) maxDepth = depth;

      let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        entries = dirents.map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          isFile: d.isFile(),
        }));
      } catch {
        return;
      }

      for (const e of entries) {
        if (e.isDirectory) {
          if (SKIP_DIRS.has(e.name)) continue;
          await walk(path.join(dir, e.name), depth + 1);
        } else if (e.isFile) {
          const ext = path.extname(e.name).toLowerCase();
          if (SKIP_EXTENSIONS.has(ext)) continue;

          extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;

          try {
            const stat = await fs.stat(path.join(dir, e.name));
            allFiles.push({
              path: path.relative(rootDir, path.join(dir, e.name)),
              bytes: stat.size,
            });
          } catch { /* skip */ }
        }
      }
    }

    await walk(rootDir, 0);
  }

  // Sort by size descending, take top 20
  allFiles.sort((a, b) => b.bytes - a.bytes);
  const largestFiles = allFiles.slice(0, 20);

  // Package centrality: count how many projects reference each package
  return {
    fileCountByExtension: extensionCounts,
    largestFiles,
    totalFiles: allFiles.length,
    maxDirectoryDepth: maxDepth,
    mostUsedPackages: [], // Filled in by caller with project data
  };
}

/** Compute package centrality across projects (which packages are used in most projects) */
export function computePackageCentrality(projects: ProjectScan[]): PackageCentrality[] {
  const packageProjects = new Map<string, Set<string>>();

  for (const project of projects) {
    for (const dep of project.dependencies) {
      const existing = packageProjects.get(dep.package);
      if (existing) {
        existing.add(project.name);
      } else {
        packageProjects.set(dep.package, new Set([project.name]));
      }
    }
  }

  const result: PackageCentrality[] = [];
  for (const [name, projectSet] of packageProjects) {
    if (projectSet.size >= 2) {
      result.push({ name, referencedInProjects: projectSet.size });
    }
  }

  result.sort((a, b) => b.referencedInProjects - a.referencedInProjects || a.name.localeCompare(b.name));
  return result.slice(0, 30);
}
