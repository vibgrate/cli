/**
 * SWE-bench–shaped Fusion task packs for FCS / ZNS@1 scale measurement.
 *
 * Tasks use the same {@link FusionTask} shape as the offline harness. JSON packs
 * under `bench/fusion-tasks/` are loadable for corpus expansion without a live
 * model. Scripted tool turns keep CI deterministic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FusionTask, FusionTaskScriptStep } from './trajectory-harness.js';
import type { ToolCall } from './types.js';

export interface SweBenchTaskMeta {
  /** SWE-bench instance_id or fixture slug. */
  instance_id: string;
  /** Optional upstream repo slug (documentation only for offline packs). */
  repo?: string;
  /** Optional base commit (documentation only). */
  base_commit?: string;
  /** Problem statement / instruction. */
  problem_statement: string;
  /** Arm → scripted provider turns. */
  scripts: FusionTask['scripts'];
  files: Record<string, string>;
  verifyCommand?: string;
  shellExits?: number[];
  /** Optional tags e.g. ["lite", "python"]. */
  tags?: string[];
}

const tc = (name: string, args: Record<string, unknown>, id: string): ToolCall => ({
  id,
  name,
  arguments: args,
});

function step(toolCalls: ToolCall[], text?: string): FusionTaskScriptStep {
  return { text, toolCalls };
}

/**
 * Expanded offline corpus (~12 tasks) for FCS scale tests.
 * Named with swe-lite-* prefix to mirror SWE-bench Lite instance id style.
 */
export function sweBenchLiteOfflinePack(): FusionTask[] {
  const tasks: FusionTask[] = [];

  // ── 1–3: timeout / config family (from default pack, stable ids) ───────────
  const scan = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';
  tasks.push(makeTask({
    instance_id: 'swe-lite-scan-timeout-zns',
    problem_statement: 'raise the request timeout to 5000ms in scanDir',
    files: { 'src/scan.ts': scan },
    scripts: {
      capsule: [
        step([tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 'c1')]),
        step([tc('finish', { summary: 'timeout 5000' }, 'c2')]),
      ],
      metadata: [
        step([tc('search_code', { query: 'timeout' }, 'm1')]),
        step([tc('read_file', { path: 'src/scan.ts' }, 'm2')]),
        step([tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 'm3')]),
        step([tc('finish', { summary: 'timeout 5000' }, 'm4')]),
      ],
      oracle: [
        step([tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 'o1')]),
        step([tc('finish', { summary: 'timeout 5000' }, 'o2')]),
      ],
    },
    verifyCommand: 'test -n ok',
    shellExits: [0],
    tags: ['lite', 'typescript', 'zns'],
  }));

  tasks.push(makeTask({
    instance_id: 'swe-lite-scan-timeout-repair',
    problem_statement: 'raise the request timeout to 5000ms in scanDir',
    files: { 'src/scan.ts': scan },
    scripts: {
      capsule: [
        step([tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 1;' }, 'f1')]),
        step([tc('finish', { summary: 'wrong' }, 'f2')]),
        step([tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 1;', replace: 'const timeout = 5000;' }, 'f3')]),
        step([tc('finish', { summary: 'fixed' }, 'f4')]),
      ],
      oracle: [
        step([tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 'o1')]),
        step([tc('finish', { summary: 'ok' }, 'o2')]),
      ],
    },
    verifyCommand: 'npm test',
    shellExits: [1, 0],
    tags: ['lite', 'repair'],
  }));

  // ── 4: format report ───────────────────────────────────────────────────────
  tasks.push(makeTask({
    instance_id: 'swe-lite-format-report-doc',
    problem_statement: 'add a doc comment to formatReport',
    files: { 'src/report.ts': 'export function formatReport(r) {\n  return String(r);\n}\n' },
    scripts: {
      capsule: [
        step([
          tc(
            'edit_file',
            {
              path: 'src/report.ts',
              search: 'export function formatReport(r) {',
              replace: '/** formats a report */\nexport function formatReport(r) {',
            },
            'c1',
          ),
        ]),
        step([tc('finish', { summary: 'doc' }, 'c2')]),
      ],
      oracle: [
        step([
          tc(
            'edit_file',
            {
              path: 'src/report.ts',
              search: 'export function formatReport(r) {',
              replace: '/** formats a report */\nexport function formatReport(r) {',
            },
            'o1',
          ),
        ]),
        step([tc('finish', { summary: 'doc' }, 'o2')]),
      ],
      metadata: [
        step([tc('search_code', { query: 'formatReport' }, 'm1')]),
        step([
          tc(
            'edit_file',
            {
              path: 'src/report.ts',
              search: 'export function formatReport(r) {',
              replace: '/** formats a report */\nexport function formatReport(r) {',
            },
            'm2',
          ),
        ]),
        step([tc('finish', { summary: 'doc' }, 'm3')]),
      ],
    },
    tags: ['lite', 'docs'],
  }));

  // ── 5–8: small pure functions ──────────────────────────────────────────────
  const helpers: Array<{ id: string; file: string; src: string; search: string; replace: string; instruction: string }> = [
    {
      id: 'swe-lite-clamp-default',
      file: 'src/math.ts',
      src: 'export function clamp(n, lo, hi) {\n  return n;\n}\n',
      search: 'return n;',
      replace: 'return Math.min(hi, Math.max(lo, n));',
      instruction: 'implement clamp to bound n between lo and hi',
    },
    {
      id: 'swe-lite-sum-reduce',
      file: 'src/math.ts',
      src: 'export function sum(xs) {\n  return 0;\n}\n',
      search: 'return 0;',
      replace: 'return xs.reduce((a, b) => a + b, 0);',
      instruction: 'implement sum to reduce an array of numbers',
    },
    {
      id: 'swe-lite-is-blank',
      file: 'src/str.ts',
      src: 'export function isBlank(s) {\n  return false;\n}\n',
      search: 'return false;',
      replace: 'return !s || !String(s).trim();',
      instruction: 'isBlank should treat empty and whitespace-only strings as blank',
    },
    {
      id: 'swe-lite-uniq',
      file: 'src/arr.ts',
      src: 'export function uniq(xs) {\n  return xs;\n}\n',
      search: 'return xs;',
      replace: 'return [...new Set(xs)];',
      instruction: 'uniq should return unique values preserving first-seen order via Set',
    },
  ];

  for (const h of helpers) {
    tasks.push(makeTask({
      instance_id: h.id,
      problem_statement: h.instruction,
      files: { [h.file]: h.src },
      scripts: {
        capsule: [
          step([tc('edit_file', { path: h.file, search: h.search, replace: h.replace }, 'c1')]),
          step([tc('finish', { summary: 'done' }, 'c2')]),
        ],
        oracle: [
          step([tc('edit_file', { path: h.file, search: h.search, replace: h.replace }, 'o1')]),
          step([tc('finish', { summary: 'done' }, 'o2')]),
        ],
        metadata: [
          step([tc('search_code', { query: h.instruction.split(' ')[0] }, 'm1')]),
          step([tc('read_file', { path: h.file }, 'm2')]),
          step([tc('edit_file', { path: h.file, search: h.search, replace: h.replace }, 'm3')]),
          step([tc('finish', { summary: 'done' }, 'm4')]),
        ],
      },
      tags: ['lite', 'pure'],
    }));
  }

  // ── 9–12: multi-file / config style ────────────────────────────────────────
  tasks.push(makeTask({
    instance_id: 'swe-lite-config-port',
    problem_statement: 'change default port from 3000 to 8080 in config',
    files: {
      'src/config.ts': 'export const config = {\n  port: 3000,\n  host: "0.0.0.0",\n};\n',
    },
    scripts: {
      capsule: [
        step([tc('edit_file', { path: 'src/config.ts', search: 'port: 3000,', replace: 'port: 8080,' }, 'c1')]),
        step([tc('finish', { summary: 'port 8080' }, 'c2')]),
      ],
      oracle: [
        step([tc('edit_file', { path: 'src/config.ts', search: 'port: 3000,', replace: 'port: 8080,' }, 'o1')]),
        step([tc('finish', { summary: 'port 8080' }, 'o2')]),
      ],
      metadata: [
        step([tc('search_code', { query: 'port' }, 'm1')]),
        step([tc('edit_file', { path: 'src/config.ts', search: 'port: 3000,', replace: 'port: 8080,' }, 'm2')]),
        step([tc('finish', { summary: 'port 8080' }, 'm3')]),
      ],
    },
    tags: ['lite', 'config'],
  }));

  tasks.push(makeTask({
    instance_id: 'swe-lite-logger-level',
    problem_statement: 'default log level should be info not debug',
    files: {
      'src/logger.ts': 'export function createLogger() {\n  return { level: "debug" };\n}\n',
    },
    scripts: {
      capsule: [
        step([tc('edit_file', { path: 'src/logger.ts', search: 'level: "debug"', replace: 'level: "info"' }, 'c1')]),
        step([tc('finish', { summary: 'info' }, 'c2')]),
      ],
      oracle: [
        step([tc('edit_file', { path: 'src/logger.ts', search: 'level: "debug"', replace: 'level: "info"' }, 'o1')]),
        step([tc('finish', { summary: 'info' }, 'o2')]),
      ],
    },
    tags: ['lite'],
  }));

  tasks.push(makeTask({
    instance_id: 'swe-lite-retry-count',
    problem_statement: 'increase maxRetries from 2 to 5',
    files: {
      'src/http.ts': 'export const clientOpts = { maxRetries: 2, timeoutMs: 1000 };\n',
    },
    scripts: {
      capsule: [
        step([tc('edit_file', { path: 'src/http.ts', search: 'maxRetries: 2', replace: 'maxRetries: 5' }, 'c1')]),
        step([tc('finish', { summary: 'retries 5' }, 'c2')]),
      ],
      oracle: [
        step([tc('edit_file', { path: 'src/http.ts', search: 'maxRetries: 2', replace: 'maxRetries: 5' }, 'o1')]),
        step([tc('finish', { summary: 'retries 5' }, 'o2')]),
      ],
      metadata: [
        step([tc('search_code', { query: 'maxRetries' }, 'm1')]),
        step([tc('edit_file', { path: 'src/http.ts', search: 'maxRetries: 2', replace: 'maxRetries: 5' }, 'm2')]),
        step([tc('finish', { summary: 'retries 5' }, 'm3')]),
      ],
    },
    tags: ['lite'],
  }));

  tasks.push(makeTask({
    instance_id: 'swe-lite-feature-flag',
    problem_statement: 'enable experimentalFeature flag by default',
    files: {
      'src/flags.ts': 'export const flags = {\n  experimentalFeature: false,\n};\n',
    },
    scripts: {
      capsule: [
        step([
          tc(
            'edit_file',
            { path: 'src/flags.ts', search: 'experimentalFeature: false,', replace: 'experimentalFeature: true,' },
            'c1',
          ),
        ]),
        step([tc('finish', { summary: 'flag on' }, 'c2')]),
      ],
      oracle: [
        step([
          tc(
            'edit_file',
            { path: 'src/flags.ts', search: 'experimentalFeature: false,', replace: 'experimentalFeature: true,' },
            'o1',
          ),
        ]),
        step([tc('finish', { summary: 'flag on' }, 'o2')]),
      ],
    },
    tags: ['lite', 'flags'],
  }));

  return tasks;
}

function makeTask(meta: SweBenchTaskMeta): FusionTask {
  return {
    id: meta.instance_id,
    instruction: meta.problem_statement,
    files: meta.files,
    scripts: meta.scripts,
    verifyCommand: meta.verifyCommand,
    shellExits: meta.shellExits,
  };
}

/** Parse a SWE-bench–shaped JSON document into FusionTask. */
export function fusionTaskFromSweJson(raw: unknown): FusionTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.instance_id === 'string' ? o.instance_id : typeof o.id === 'string' ? o.id : null;
  const instruction =
    typeof o.problem_statement === 'string'
      ? o.problem_statement
      : typeof o.instruction === 'string'
        ? o.instruction
        : null;
  if (!id || !instruction) return null;
  const files = o.files && typeof o.files === 'object' ? (o.files as Record<string, string>) : {};
  const scripts = (o.scripts && typeof o.scripts === 'object' ? o.scripts : {}) as FusionTask['scripts'];
  return {
    id,
    instruction,
    files,
    scripts,
    verifyCommand: typeof o.verifyCommand === 'string' ? o.verifyCommand : undefined,
    shellExits: Array.isArray(o.shellExits) ? o.shellExits.filter((x): x is number => typeof x === 'number') : undefined,
  };
}

/** Load all `*.json` task files from a directory (sorted by name). */
export function loadFusionTasksFromDir(dir: string): FusionTask[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const out: FusionTask[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const t = fusionTaskFromSweJson(item);
          if (t) out.push(t);
        }
      } else {
        const t = fusionTaskFromSweJson(raw);
        if (t) out.push(t);
      }
    } catch {
      /* skip bad files */
    }
  }
  return out;
}

/** Combined default + SWE-lite offline pack (deduped by id). */
export function fullOfflineFusionCorpus(): FusionTask[] {
  const seen = new Set<string>();
  const out: FusionTask[] = [];
  for (const t of sweBenchLiteOfflinePack()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}
