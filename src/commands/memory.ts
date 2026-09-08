import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';
import { rootOf } from './util.js';
import { c, info, json, out } from '../util/output.js';
import { notFound, usageError } from '../util/exit.js';
import { MemoryStore } from '../memory/store.js';
import { isMemoryKind, isMemoryScope, MEMORY_KINDS, MEMORY_SCOPES, type Memory, type MemoryKind, type MemoryScope } from '../memory/types.js';

/**
 * `vg serve memory` — cross-agent memory: statements worth recalling in later
 * sessions, scoped per project (git toplevel), per user, or globally.
 * Everything lives in local JSONL files under `VG_MEMORY_DIR`; nothing leaves
 * the machine.
 *
 * The code graph is still vg's memory of the *code*; this is the small store of
 * things a session learned that the map cannot know. It nests under `vg serve`
 * because serve is what injects it and exposes the `memory_search` /
 * `memory_save` tools (`vg serve --memory`) — not a product of its own
 * (FEATURE-DESIGN-PRINCIPLES P1).
 */
export function registerServeMemory(serve: Command): void {
  const memory = serve.command('memory').description('cross-agent memory: list, search, add, delete, export and import remembered facts');

  const list = memory
    .command('list', { isDefault: true })
    .description('list memories (newest first)')
    .option('--scope <scope>', `project | user | global (default: all)`)
    .option('--kind <kind>', `filter by kind (${MEMORY_KINDS.join(' | ')})`)
    .option('--tags <tags>', 'comma-separated tags a memory must carry')
    .option('--limit <n>', 'max rows', '50')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const store = openStore(global);
      const o = this.opts();
      const rows = store.list({ scope: scopeList(o.scope), kinds: kindList(o.kind), tags: tagList(o.tags), limit: Number(o.limit) || 50 });
      if (global.json) {
        json({ project: store.project, user: store.userKey, count: rows.length, memories: rows });
        return;
      }
      info(`${c.cyan('vg serve memory list')} · ${rows.length} memories ${c.dim(`(project ${store.projectResolved ? store.projectKey : 'unresolved — project scope hidden from injection'})`)}`);
      if (rows.length === 0) {
        info(c.dim('  nothing remembered yet — `vg serve memory add "…"` or let an agent call memory_save'));
        return;
      }
      for (const m of rows) info(`  ${renderRow(m)}`);
    });
  applyGlobalOptions(list);

  const search = memory
    .command('search <query>')
    .description('rank memories for a query (offline BM25 + recency + evidence)')
    .option('--top-k <n>', 'results to return', '10')
    .option('--scope <scope>', 'project | user | global (default: all readable)')
    .option('--kind <kind>', 'filter by kind')
    .action(function (this: Command, query: string) {
      const global = readGlobal(this);
      const store = openStore(global);
      const o = this.opts();
      const hits = store.search(query, { topK: Number(o.topK) || 10, scope: scopeList(o.scope), kinds: kindList(o.kind) });
      if (global.json) {
        json({ query, count: hits.length, hits: hits.map((h) => ({ score: h.score, memory: h.memory })) });
        return;
      }
      info(`${c.cyan('vg serve memory search')} · ${hits.length} hits for ${c.bold(query)}`);
      for (const h of hits) info(`  ${c.dim(h.score.toFixed(3))}  ${renderRow(h.memory)}`);
    });
  applyGlobalOptions(search);

  const add = memory
    .command('add <text...>')
    .description('remember a statement (re-adding the same statement strengthens it)')
    .option('--kind <kind>', `one of ${MEMORY_KINDS.join(' | ')}`, 'fact')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--scope <scope>', 'project | user | global (default: project when inside a repo, else user)')
    .action(function (this: Command, words: string[]) {
      const global = readGlobal(this);
      const store = openStore(global);
      const o = this.opts();
      const text = words.join(' ').trim();
      if (!text) throw usageError('memory text is empty');
      if (!isMemoryKind(o.kind)) throw usageError(`unknown kind ${JSON.stringify(o.kind)}; expected one of ${MEMORY_KINDS.join(', ')}`);
      const scope = parseScope(o.scope) ?? (store.projectResolved ? 'project' : 'user');
      if (scope === 'project' && !store.projectResolved) throw usageError('no project root resolved (not a git repo?) — pass --scope user|global or set VG_MEMORY_PROJECT_ROOT');
      const m = store.add({ scope, kind: o.kind as MemoryKind, text, tags: tagList(o.tags) ?? [], source: 'user' });
      if (global.json) {
        json({ ok: true, memory: m, file: store.filePath(scope) });
        return;
      }
      info(`${c.cyan('vg serve memory add')} · ${m.evidence > 1 ? `reinforced (evidence ${m.evidence})` : 'remembered'} ${c.dim(`[${m.id}]`)} ${c.dim(`→ ${store.filePath(scope)}`)}`);
    });
  applyGlobalOptions(add);

  const del = memory
    .command('delete <id>')
    .description('forget a memory by id (a unique id prefix works)')
    .action(function (this: Command, id: string) {
      const global = readGlobal(this);
      const store = openStore(global);
      const m = store.get(id);
      if (!m) throw notFound(`no memory with id ${id} — run \`vg serve memory list\` to see ids`);
      store.delete(m.id);
      if (global.json) {
        json({ ok: true, deleted: m.id });
        return;
      }
      info(`${c.cyan('vg serve memory delete')} · forgot ${c.dim(`[${m.id}]`)} ${m.text.slice(0, 80)}`);
    });
  applyGlobalOptions(del);

  const stats = memory
    .command('stats')
    .description('counts by scope, kind and source; where the files live')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const store = openStore(global);
      const s = store.stats();
      if (global.json) {
        json(s);
        return;
      }
      info(`${c.cyan('vg serve memory stats')} · ${s.total} memories · evidence ${s.evidence}`);
      info(`  project    ${s.project.resolved ? `${s.project.key} ${c.dim(`(${s.project.root ?? ''})`)}` : c.yellow('unresolved — project scope never injected')}`);
      info(`  user       ${s.user}`);
      info(`  by scope   project ${s.byScope.project} · user ${s.byScope.user} · global ${s.byScope.global}`);
      info(`  by kind    ${Object.entries(s.byKind).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}`);
      info(`  by source  ${Object.entries(s.bySource).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}`);
      for (const f of s.files) info(c.dim(`  ${f.scope.padEnd(8)} ${f.path} (${f.bytes} bytes)`));
    });
  applyGlobalOptions(stats);

  const exp = memory
    .command('export [file]')
    .description('export every memory as JSONL (stdout when no file is given)')
    .action(function (this: Command, file?: string) {
      const global = readGlobal(this);
      const store = openStore(global);
      const jsonl = store.export();
      const count = jsonl ? jsonl.trimEnd().split('\n').length : 0;
      if (file) {
        const target = path.resolve(rootOf(global), file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, jsonl, { mode: 0o600 });
        if (global.json) json({ ok: true, file: target, count });
        else info(`${c.cyan('vg serve memory export')} · wrote ${count} memories → ${target}`);
        return;
      }
      if (global.json) {
        json({ count, memories: store.list() });
        return;
      }
      if (jsonl) out(jsonl.trimEnd());
      info(c.dim(`${count} memories exported`));
    });
  applyGlobalOptions(exp);

  const imp = memory
    .command('import <file>')
    .description('import memories from a JSONL export (existing ids are skipped)')
    .action(function (this: Command, file: string) {
      const global = readGlobal(this);
      const store = openStore(global);
      const target = path.resolve(rootOf(global), file);
      let raw: string;
      try {
        raw = fs.readFileSync(target, 'utf8');
      } catch {
        throw notFound(`cannot read ${target}`);
      }
      const r = store.import(raw);
      if (global.json) {
        json({ ok: true, file: target, ...r });
        return;
      }
      info(`${c.cyan('vg serve memory import')} · added ${r.added}, skipped ${r.skipped} ${c.dim(`from ${target}`)}`);
    });
  applyGlobalOptions(imp);

  const clear = memory
    .command('clear')
    .description('forget every memory in a scope (or all scopes)')
    .option('--scope <scope>', 'project | user | global (default: all)')
    .option('--yes', 'confirm — clear is irreversible')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const store = openStore(global);
      const o = this.opts();
      const scope = parseScope(o.scope);
      if (!o.yes) throw usageError(`refusing to clear ${scope ?? 'all'} memories without --yes`);
      const n = store.clear(scope);
      if (global.json) {
        json({ ok: true, scope: scope ?? 'all', cleared: n });
        return;
      }
      info(`${c.cyan('vg serve memory clear')} · forgot ${n} ${scope ?? ''} memories`.replace(/\s+/g, ' '));
    });
  applyGlobalOptions(clear);

  applyGlobalOptions(memory);
}

function openStore(global: GlobalOpts): MemoryStore {
  return new MemoryStore({ cwd: rootOf(global), env: process.env });
}

function parseScope(raw: unknown): MemoryScope | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!isMemoryScope(raw)) throw usageError(`unknown scope ${JSON.stringify(raw)}; expected one of ${MEMORY_SCOPES.join(', ')}`);
  return raw;
}

function scopeList(raw: unknown): MemoryScope[] | undefined {
  const s = parseScope(raw);
  return s ? [s] : undefined;
}

function kindList(raw: unknown): MemoryKind[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!isMemoryKind(raw)) throw usageError(`unknown kind ${JSON.stringify(raw)}; expected one of ${MEMORY_KINDS.join(', ')}`);
  return [raw];
}

function tagList(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function renderRow(m: Memory): string {
  const tags = m.tags.filter((t) => !t.startsWith('key:'));
  return `${c.dim(`[${m.id}]`)} ${c.dim(m.scope.padEnd(7))} ${c.dim(m.kind.padEnd(10))} ${m.text}${tags.length ? c.dim(`  #${tags.slice(0, 4).join(' #')}`) : ''}${m.evidence > 1 ? c.dim(`  ×${m.evidence}`) : ''}`;
}
