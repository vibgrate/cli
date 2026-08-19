import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Area, GraphNode, VgGraph } from '../schema.js';
import { versionMarker } from './content.js';

/**
 * Per-area generated skills: one SKILL.md per top graph area, so the host
 * assistant can route "working on X" tasks straight to that area's entry
 * points without a discovery loop. Content is derived from the ranked graph —
 * entry points, hubs, key files, test posture — under two hard contracts:
 *
 *  - DETERMINISTIC: the same graph produces byte-identical skills (no
 *    timestamps, everything sorted with explicit tiebreaks), so regeneration
 *    on every build causes zero churn.
 *  - OWNED NAMESPACE: skills live under `vg-area-<slug>` directories and are
 *    the only thing vg creates or deletes there. A file whose version marker
 *    was removed is user-owned — never rewritten, never deleted (the same
 *    opt-out contract as every other installed instruction file).
 *
 * Generation is off by default. A repo opts in with `"areaSkills": true` in
 * `vibgrate.config.json`, and only then if the assistant family is installed
 * (its `<skills>/vg/SKILL.md` exists). Repos that never ran `vg install` get
 * nothing written either way.
 */

export const AREA_SKILL_PREFIX = 'vg-area-';
/** Skill roots that receive per-area skills, per assistant family. */
const SKILL_BASES = ['.claude/skills', '.agents/skills'];

const MAX_AREAS = 8;
const MIN_AREA_SIZE = 4;
const MAX_ENTRY_POINTS = 6;
const MAX_KEY_FILES = 8;

export function areaSlug(area: Area): string {
  const s = area.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || `area-${area.id}`;
}

function byImportanceDesc(a: GraphNode, b: GraphNode): number {
  return b.importance - a.importance || (a.qualifiedName < b.qualifiedName ? -1 : 1);
}

/** The areas worth a skill: largest first, deterministic tiebreak on label. */
export function topAreas(graph: VgGraph): Area[] {
  return [...graph.areas]
    .filter((a) => a.size >= MIN_AREA_SIZE)
    .sort((a, b) => b.size - a.size || (a.label < b.label ? -1 : 1))
    .slice(0, MAX_AREAS);
}

function renderAreaSkill(graph: VgGraph, area: Area, slug: string): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const members = area.members.map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n));
  const code = members.filter((n) => n.kind !== 'file');

  const fileCounts = new Map<string, number>();
  for (const n of members) fileCounts.set(n.file, (fileCounts.get(n.file) ?? 0) + 1);
  const keyFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_KEY_FILES);

  const entryPoints = [...code].sort(byImportanceDesc).slice(0, MAX_ENTRY_POINTS);
  const hubs = code.filter((n) => n.isHub).sort(byImportanceDesc).slice(0, 4);
  const testable = code.filter((n) => n.tested !== null);
  const tested = testable.filter((n) => n.tested === true);

  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${AREA_SKILL_PREFIX}${slug}`);
  lines.push(
    `description: Navigate the "${area.label}" area of this repo (${area.size} symbols across ${fileCounts.size} files). ` +
      `Use when the task touches ${keyFiles.slice(0, 3).map(([f]) => f).join(', ')}.`,
  );
  lines.push('---');
  lines.push('');
  lines.push(versionMarker());
  lines.push('');
  lines.push(`# Area: ${area.label}`);
  lines.push('');
  lines.push(
    `${area.size} symbols · ${fileCounts.size} files · cohesion ${(area.cohesion * 100).toFixed(0)}% · ` +
      `${area.externalEdges} cross-area edge(s)` +
      (testable.length ? ` · ${tested.length}/${testable.length} analyzable symbols tested` : ''),
  );
  lines.push('');
  lines.push('## Entry points (start here)');
  lines.push('');
  for (const n of entryPoints) {
    lines.push(`- \`${n.qualifiedName}\` — ${n.file}:${n.span.start}${n.doc ? ` — ${n.doc.split('\n')[0]}` : ''}`);
  }
  if (hubs.length) {
    lines.push('');
    lines.push('## Hubs (high blast radius — check impact before changing)');
    lines.push('');
    for (const n of hubs) lines.push(`- \`${n.qualifiedName}\` — ${n.file}:${n.span.start}`);
  }
  lines.push('');
  lines.push('## Key files');
  lines.push('');
  for (const [file, count] of keyFiles) lines.push(`- ${file} (${count} symbol${count === 1 ? '' : 's'})`);
  lines.push('');
  lines.push('## How to work here');
  lines.push('');
  lines.push(
    '- Confirm the target with one `search_symbols`/`orient` call against the names above, then edit — the map above usually removes the discovery loop entirely.',
  );
  lines.push('- Before changing a hub, run `impact_of` on it: cross-area edges mean the blast radius leaves this area.');
  lines.push('');
  return lines.join('\n');
}

/** All per-area skill files for a graph: relative skill-dir name → content. */
export function areaSkillFiles(graph: VgGraph): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const area of topAreas(graph)) {
    let slug = areaSlug(area);
    // Deterministic de-dup for label collisions (two areas named "utils").
    if (used.has(slug)) slug = `${slug}-${area.id}`;
    used.add(slug);
    out.set(`${AREA_SKILL_PREFIX}${slug}`, renderAreaSkill(graph, area, slug));
  }
  return out;
}

export interface AreaSkillChanges {
  written: string[];
  removed: string[];
}

/**
 * Generated `vg-area-*` skills are off unless `vibgrate.config.json` sets
 * `"areaSkills": true`. Missing or malformed config keeps the default (off).
 */
export function areaSkillsEnabled(root: string): boolean {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, 'vibgrate.config.json'), 'utf8'),
    ) as { areaSkills?: unknown };
    return parsed.areaSkills === true;
  } catch {
    return false;
  }
}

/**
 * Write per-area skills into every installed assistant skill root, and remove
 * stale `vg-area-*` directories from previous graphs. Only files carrying our
 * version marker are ever rewritten or removed — marker-less files are
 * user-owned and left untouched (including their directory).
 *
 * Off by default: writes nothing and removes every generated `vg-area-*`
 * skill. `"areaSkills": true` turns generation on. The vg install skill itself
 * is never touched.
 */
export function writeAreaSkills(root: string, graph: VgGraph): AreaSkillChanges {
  const changes: AreaSkillChanges = { written: [], removed: [] };
  const files = areaSkillsEnabled(root) ? areaSkillFiles(graph) : new Map<string, string>();
  for (const base of SKILL_BASES) {
    // Gate: this assistant family is installed here at all.
    if (!fs.existsSync(path.join(root, base, 'vg', 'SKILL.md'))) continue;
    const baseDir = path.join(root, base);
    // Remove stale generated areas (ours only — marker required).
    let existing: string[] = [];
    try {
      existing = fs.readdirSync(baseDir).filter((d) => d.startsWith(AREA_SKILL_PREFIX));
    } catch {
      existing = [];
    }
    for (const dir of existing) {
      if (files.has(dir)) continue;
      const skillFile = path.join(baseDir, dir, 'SKILL.md');
      try {
        const text = fs.readFileSync(skillFile, 'utf8');
        if (!/<!--\s*vg:v\d+\b/.test(text)) continue; // user took ownership
        fs.rmSync(path.join(baseDir, dir), { recursive: true, force: true });
        changes.removed.push(path.join(base, dir));
      } catch {
        /* unreadable/missing — leave the directory alone */
      }
    }
    // Write current areas (skip user-owned files; skip unchanged content).
    for (const [dir, content] of files) {
      const skillFile = path.join(baseDir, dir, 'SKILL.md');
      try {
        const current = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : null;
        if (current !== null && !/<!--\s*vg:v\d+\b/.test(current)) continue; // user took ownership
        if (current === content) continue; // deterministic content — no churn
        fs.mkdirSync(path.dirname(skillFile), { recursive: true });
        fs.writeFileSync(skillFile, content);
        changes.written.push(path.join(base, dir, 'SKILL.md'));
      } catch {
        /* unwritable — skip, never fail the build over a skill file */
      }
    }
  }
  return changes;
}
