/**
 * Config-file editing for compression routing — atomic JSON / TOML / YAML edits with a
 * byte-for-byte backup, a marker sidecar (what we changed and what was there
 * before), an owners sidecar (which live sessions hold each field, so two
 * concurrent wraps in one project do not unwrap each other), and an advisory
 * lock around every read-modify-write.
 *
 * Invariants:
 *  - refuse-don't-clobber: a non-empty unparseable file aborts the edit;
 *  - a backup is taken once (never overwritten by a later wrap);
 *  - apply → revert is byte-identical when nothing else touched the file
 *    (the backup is restored), and field-precise otherwise;
 *  - marker / owners / lock files are created 0600, written tmp+rename;
 *  - a stale lock (dead holder, or older than the staleness threshold) is
 *    reclaimed rather than blocking forever.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDocument as parseYamlDocument, parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { CliError, ExitCode } from '../util/exit.js';
import { canonicalize } from '../engine/hash.js';
import { wrapBackupPath, wrapMarkerPath, wrapOwnersPath, wrapSettingsLockPath } from '../compress/paths.js';
import { VERSION } from '../version.js';
import type { EditContext, PrevValue, ProcIdentity, WrapAgent } from './types.js';

// ---------------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------------

/** Atomic write (tmp + rename). Preserves an existing file's mode; new files get `mode`. */
export function writeFileAtomic(file: string, text: string | Uint8Array, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let finalMode = mode;
  try {
    finalMode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = `${file}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: finalMode });
  try {
    fs.chmodSync(tmp, finalMode);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  fs.renameSync(tmp, file);
}

/** Write a private (0600) sidecar file atomically. */
export function writePrivateFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
}

export function readTextSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonSafe<T>(file: string): T | null {
  const text = readTextSafe(file);
  if (text === null || text.trim() === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Blocking sleep without a busy loop (used only while waiting on a lock). */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Process identity from `/proc/<pid>/stat` (Linux); pid-only elsewhere. */
export function procIdentity(pid: number): ProcIdentity {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Split after the LAST ')' so a comm containing parens/spaces is safe.
    const close = stat.lastIndexOf(')');
    if (close > 0) {
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      // fields[0] is state (field 3 in proc(5)); starttime is field 22 → index 19.
      const start = Number.parseFloat(fields[19] ?? '');
      if (Number.isFinite(start)) return { pid, startSrc: 'proc', startTime: start };
    }
  } catch {
    /* not Linux or no permission */
  }
  return { pid };
}

/** True only with proof: same identity source and start times > 1 s apart. */
export function identityMismatch(recorded: ProcIdentity | undefined, current: ProcIdentity): boolean {
  if (!recorded || !recorded.startSrc || !current.startSrc) return false;
  if (recorded.startSrc !== current.startSrc) return false;
  if (recorded.startTime === undefined || current.startTime === undefined) return false;
  return Math.abs(recorded.startTime - current.startTime) > 1;
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

export interface LockOptions {
  now?: () => number;
  pid?: number;
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
}

interface LockPayload {
  pid: number;
  ts: number;
}

/**
 * Acquire an exclusive advisory lock (create-exclusive file). A lock whose
 * holder is dead, or which is older than `staleMs`, is reclaimed. Returns a
 * release function. Throws after `timeoutMs` of waiting.
 */
export function acquireLock(lockPath: string, opts: LockOptions = {}): () => void {
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 25;
  const isAlive = opts.isAlive ?? pidAlive;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid, ts: now() } satisfies LockPayload));
      fs.closeSync(fd);
      return () => {
        try {
          const cur = readJsonSafe<LockPayload>(lockPath);
          if (!cur || cur.pid === pid) fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = readJsonSafe<LockPayload>(lockPath);
    const stale =
      held === null || // unreadable / half-written → treat as stale once it is old enough
      (typeof held.ts === 'number' && now() - held.ts > staleMs) ||
      (typeof held.pid === 'number' && held.pid !== pid && !isAlive(held.pid));
    if (stale) {
      let age = Number.POSITIVE_INFINITY;
      try {
        age = now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished — retry the create
      }
      if (held !== null || age > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* raced with another reclaim */
        }
        continue;
      }
    }
    if (now() >= deadline) {
      throw new CliError(`timed out waiting for ${lockPath} (held by pid ${held?.pid ?? '?'}); remove it if that process is gone`, ExitCode.ERROR);
    }
    sleepSync(pollMs);
  }
}

export function withLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const release = acquireLock(lockPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Marker + owners sidecars
// ---------------------------------------------------------------------------

export interface WrapMarker {
  format: 1;
  agent: WrapAgent;
  url: string;
  version: string;
  appliedAt: number;
  pid: number;
  startSrc?: 'proc';
  startTime?: number;
  port?: number;
  file: string;
  /** Durable routing (`vg install <agent> --compress`); the pid is 0 and never "stale". */
  durable?: boolean;
  /** The config file did not exist before this wrap created it. */
  created: boolean;
  /** This wrap created the `.vg-backup` (and may restore + delete it on revert). */
  createdBackup: boolean;
  /** Field → what was there before the FIRST live session changed it. */
  fields: Record<string, PrevValue>;
}

export interface OwnerHolder extends ProcIdentity {
  port?: number;
  inherited: boolean;
  /** Written by `vg install <agent> --compress`: not a process, released only by `vg uninstall`. */
  durable?: boolean;
}

export interface OwnerEntry {
  original: PrevValue;
  founderPid: number;
  holders: OwnerHolder[];
}

export type OwnersFile = Record<string, OwnerEntry>;

/** Any marker in `file`'s directory (the sidecar is per directory; `file` says which config it tracks). */
export function readMarkerInDir(file: string): WrapMarker | null {
  const m = readJsonSafe<WrapMarker>(wrapMarkerPath(file));
  return m && m.format === 1 && typeof m.fields === 'object' && typeof m.file === 'string' ? m : null;
}

/** The marker tracking exactly `file`. */
export function readMarker(file: string): WrapMarker | null {
  const m = readMarkerInDir(file);
  return m && path.resolve(m.file) === path.resolve(file) ? m : null;
}

/** A marker in the same directory that tracks a different config file (`.claude/settings.json` vs `settings.local.json`). */
export function markerConflict(file: string): WrapMarker | null {
  const m = readMarkerInDir(file);
  return m && path.resolve(m.file) !== path.resolve(file) ? m : null;
}

export function writeMarker(file: string, marker: WrapMarker): void {
  writePrivateFile(wrapMarkerPath(file), `${JSON.stringify(marker)}\n`);
}

export function clearMarker(file: string): void {
  try {
    fs.unlinkSync(wrapMarkerPath(file));
  } catch {
    /* absent */
  }
}

export function readOwners(file: string): OwnersFile {
  const o = readJsonSafe<OwnersFile>(wrapOwnersPath(file));
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

export function writeOwners(file: string, owners: OwnersFile): void {
  const p = wrapOwnersPath(file);
  if (Object.keys(owners).length === 0) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* absent */
    }
    return;
  }
  const sorted: OwnersFile = {};
  for (const k of Object.keys(owners).sort()) sorted[k] = owners[k]!;
  writePrivateFile(p, `${JSON.stringify(sorted, null, 2)}\n`);
}

function resolvedCtx(ctx: EditContext): Required<Pick<EditContext, 'pid' | 'now' | 'version' | 'isAlive' | 'identity'>> & EditContext {
  return {
    ...ctx,
    pid: ctx.durable ? 0 : (ctx.pid ?? process.pid),
    now: ctx.now ?? Date.now,
    version: ctx.version ?? VERSION,
    isAlive: ctx.isAlive ?? pidAlive,
    identity: ctx.identity ?? procIdentity,
  };
}

/** Holders whose process is alive and not provably recycled (durable holders always count, unless being released). */
export function liveHolders(entry: OwnerEntry, ctx: EditContext, deadPorts: Set<number> = new Set()): OwnerHolder[] {
  const c = resolvedCtx(ctx);
  return entry.holders.filter((h) => {
    if (h.durable) return !ctx.releaseDurable;
    if (h.port !== undefined && deadPorts.has(h.port)) return false;
    if (!c.isAlive(h.pid)) return false;
    return !identityMismatch(h, c.identity(h.pid));
  });
}

/**
 * Claim `fields` for the calling process. The first live owner records the
 * original value; later owners inherit it (flagged) so their exit never
 * restores the first session's proxy URL. Returns the original per field.
 */
export function claimFields(file: string, previous: Record<string, PrevValue>, ctx: EditContext): Record<string, PrevValue> {
  const c = resolvedCtx(ctx);
  const owners = readOwners(file);
  const me: OwnerHolder = ctx.durable ? { pid: 0, inherited: false, durable: true } : { ...c.identity(c.pid), pid: c.pid, port: ctx.port, inherited: false };
  const originals: Record<string, PrevValue> = {};
  for (const [key, prev] of Object.entries(previous)) {
    const entry = owners[key];
    const others = entry ? liveHolders(entry, c).filter((h) => h.pid !== c.pid) : [];
    const mine = entry?.holders.find((h) => h.pid === c.pid);
    if (entry && mine) {
      // Re-apply from the same session: keep the recorded original and role.
      owners[key] = { ...entry, holders: [...others, { ...mine, port: ctx.port ?? mine.port }] };
    } else if (!entry || others.length === 0) {
      owners[key] = { original: prev, founderPid: c.pid, holders: [{ ...me, inherited: false }] };
    } else {
      owners[key] = { ...entry, holders: [...others, { ...me, inherited: true }] };
    }
    originals[key] = owners[key]!.original;
  }
  writeOwners(file, owners);
  return originals;
}

export interface FieldRelease {
  shouldRestore: boolean;
  original: PrevValue | undefined;
  trustCaller: boolean;
  survivor?: OwnerHolder;
}

/** Release `keys` for the calling process and report per-field restore decisions. */
export function releaseFields(file: string, keys: string[], ctx: EditContext, deadPorts: Set<number> = new Set()): Record<string, FieldRelease> {
  const c = resolvedCtx(ctx);
  const owners = readOwners(file);
  const out: Record<string, FieldRelease> = {};
  for (const key of keys) {
    const entry = owners[key];
    if (!entry) {
      out[key] = { shouldRestore: true, original: undefined, trustCaller: true };
      continue;
    }
    const mine = entry.holders.find((h) => h.pid === c.pid);
    const others = liveHolders(entry, c, deadPorts).filter((h) => h.pid !== c.pid);
    const shouldRestore = ctx.force === true || others.length === 0;
    const trustCaller = mine !== undefined && !mine.inherited && entry.founderPid === c.pid;
    if (shouldRestore) delete owners[key];
    else owners[key] = { ...entry, holders: others };
    out[key] = { shouldRestore, original: entry.original, trustCaller, survivor: others[0] };
  }
  writeOwners(file, owners);
  return out;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/** Snapshot `file` to its backup path once; never overwrites an existing backup. */
export function snapshotIfAbsent(file: string): { backup: string; created: boolean } {
  const backup = wrapBackupPath(file);
  if (fs.existsSync(backup) || !fs.existsSync(file)) return { backup, created: false };
  writeFileAtomic(backup, fs.readFileSync(file), 0o600);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {
    /* best effort */
  }
  return { backup, created: true };
}

// ---------------------------------------------------------------------------
// Object-path helpers
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

export function splitPath(p: string): string[] {
  return p.split('.').filter(Boolean);
}

export function getPath(obj: unknown, p: string): PrevValue {
  let cur: unknown = obj;
  for (const seg of splitPath(p)) {
    if (!cur || typeof cur !== 'object') return { present: false };
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { present: false };
      cur = cur[i];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { present: false };
    cur = (cur as Json)[seg];
  }
  return { present: true, value: cur };
}

/** Set a dotted path, creating intermediate objects; arrays are traversed by index, never replaced. */
export function setPath(obj: Json, p: string, value: unknown): void {
  const segs = splitPath(p);
  let cur: Json = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (!next || typeof next !== 'object') cur[seg] = {};
    cur = cur[seg] as Json;
  }
  cur[segs[segs.length - 1]!] = value;
}

/** Delete a path, pruning parents that become empty objects (arrays are left as they are). */
export function deletePath(obj: Json, p: string): void {
  const segs = splitPath(p);
  const stack: Array<{ parent: Json; key: string }> = [];
  let cur: Json = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (!next || typeof next !== 'object') return;
    stack.push({ parent: cur, key: seg });
    cur = next as Json;
  }
  delete cur[segs[segs.length - 1]!];
  for (let i = stack.length - 1; i >= 0; i--) {
    const { parent, key } = stack[i]!;
    const child = parent[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child as Json).length === 0) delete parent[key];
    else break;
  }
}

export function restoreField(obj: Json, p: string, prev: PrevValue): void {
  if (prev.present) setPath(obj, p, prev.value);
  else deletePath(obj, p);
}

// ---------------------------------------------------------------------------
// JSON (+ lenient JSONC)
// ---------------------------------------------------------------------------

/** Strip line and block comments and trailing commas outside strings (JSONC). Linear time. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 2;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonc(text));
  }
}

/**
 * Read a JSON object we are about to rewrite. Missing / zero-byte → `{}`;
 * anything unparseable or non-object aborts (never overwrite user config).
 */
export function readJsonForWrite(file: string): { obj: Json; existed: boolean; text: string } {
  const text = readTextSafe(file);
  if (text === null) return { obj: {}, existed: false, text: '' };
  if (text.trim() === '') return { obj: {}, existed: true, text };
  try {
    const parsed = parseJsonLoose(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { obj: parsed as Json, existed: true, text };
  } catch {
    /* fall through */
  }
  throw new CliError(`${file} exists but is not a JSON object — fix or remove it, then rerun. Refusing to overwrite it.`, ExitCode.ERROR);
}

function detectJsonIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  if (!m) return 2;
  return m[1]!.includes('\t') ? '\t' : m[1]!.length;
}

export function renderJson(obj: Json, like = ''): string {
  return `${JSON.stringify(obj, null, detectJsonIndent(like))}\n`;
}

export interface EditOutcome {
  changed: boolean;
  /** Field → previous value (recorded for every field we set). */
  previous: Record<string, PrevValue>;
  created: boolean;
  text: string;
}

/** Fields to set, or a function of the current document (for set-if-absent / per-index edits). */
export type FieldsSpec = Record<string, unknown> | ((current: Json) => Record<string, unknown>);

function resolveFields(spec: FieldsSpec, current: Json): Record<string, unknown> {
  return typeof spec === 'function' ? spec(current) : spec;
}

/** Apply dotted-path fields (value `undefined` = delete) to a JSON file. */
export function applyJsonFields(file: string, spec: FieldsSpec): EditOutcome {
  const { obj, existed, text } = readJsonForWrite(file);
  const previous: Record<string, PrevValue> = {};
  let changed = false;
  for (const [p, value] of Object.entries(resolveFields(spec, obj))) {
    const prev = getPath(obj, p);
    previous[p] = prev;
    if (value === undefined) {
      if (prev.present) {
        deletePath(obj, p);
        changed = true;
      }
    } else if (!prev.present || canonicalize(prev.value) !== canonicalize(value)) {
      setPath(obj, p, value);
      changed = true;
    }
  }
  const next = renderJson(obj, text);
  if (changed || !existed) writeFileAtomic(file, next);
  return { changed: changed || !existed, previous, created: !existed, text: next };
}

export function revertJsonFields(file: string, previous: Record<string, PrevValue>): { changed: boolean; text: string; empty: boolean } {
  const { obj, existed, text } = readJsonForWrite(file);
  if (!existed) return { changed: false, text: '', empty: true };
  for (const [p, prev] of Object.entries(previous)) restoreField(obj, p, prev);
  const next = renderJson(obj, text);
  return { changed: next !== text, text: next, empty: Object.keys(obj).length === 0 };
}

export function jsonEqual(a: string, b: string): boolean {
  try {
    return canonicalize(parseJsonLoose(a)) === canonicalize(parseJsonLoose(b));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// YAML (comment-preserving via the document API)
// ---------------------------------------------------------------------------

export function applyYamlFields(file: string, spec: FieldsSpec): EditOutcome {
  const text = readTextSafe(file);
  const existed = text !== null;
  const doc = parseYamlDocument(text && text.trim() ? text : '{}');
  if (doc.errors.length) throw new CliError(`${file} is not valid YAML — fix or remove it, then rerun. Refusing to overwrite it.`, ExitCode.ERROR);
  const root = doc.toJS() as unknown;
  if (root !== null && (typeof root !== 'object' || Array.isArray(root))) {
    throw new CliError(`${file} is not a YAML mapping — refusing to overwrite it.`, ExitCode.ERROR);
  }
  const previous: Record<string, PrevValue> = {};
  let changed = false;
  for (const [p, value] of Object.entries(resolveFields(spec, (root ?? {}) as Json))) {
    const segs = splitPath(p).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const prev = getPath(root ?? {}, p);
    previous[p] = prev;
    if (value === undefined) {
      if (prev.present) {
        doc.deleteIn(segs);
        changed = true;
      }
    } else if (!prev.present || canonicalize(prev.value) !== canonicalize(value)) {
      doc.setIn(segs, value);
      changed = true;
    }
  }
  const next = doc.toString();
  if (changed || !existed) writeFileAtomic(file, next);
  return { changed: changed || !existed, previous, created: !existed, text: next };
}

export function revertYamlFields(file: string, previous: Record<string, PrevValue>): { changed: boolean; text: string; empty: boolean } {
  const text = readTextSafe(file);
  if (text === null) return { changed: false, text: '', empty: true };
  const doc = parseYamlDocument(text.trim() ? text : '{}');
  if (doc.errors.length) throw new CliError(`${file} is not valid YAML — refusing to touch it.`, ExitCode.ERROR);
  for (const [p, prev] of Object.entries(previous)) {
    const segs = splitPath(p).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    if (prev.present) doc.setIn(segs, prev.value);
    else if (doc.hasIn(segs)) {
      doc.deleteIn(segs);
      // prune empty parents
      for (let i = segs.length - 1; i > 0; i--) {
        const parent = segs.slice(0, i);
        const v = doc.getIn(parent) as { items?: unknown[] } | undefined;
        if (v && Array.isArray(v.items) && v.items.length === 0) doc.deleteIn(parent);
        else break;
      }
    }
  }
  const next = doc.toString();
  const js = doc.toJS() as unknown;
  const empty = js === null || js === undefined || (typeof js === 'object' && Object.keys(js as Json).length === 0);
  return { changed: next !== text, text: next, empty };
}

export function yamlEqual(a: string, b: string): boolean {
  try {
    return canonicalize(parseYaml(a) ?? null) === canonicalize(parseYaml(b) ?? null);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TOML (text-level managed blocks — comments and formatting preserved)
// ---------------------------------------------------------------------------

export const TOML_BLOCK_BEGIN = (label: string): string => `# --- vg compression (managed by ${label}) ---`;
export const TOML_BLOCK_END = '# --- end vg compression ---';
const WAS_SUFFIX = '  # was: ';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex over one managed block (begin line … end line, inclusive), anchored to line starts. */
function blockRe(begin: string): RegExp {
  return new RegExp(`(^|\\n)${escapeRe(begin)}[^\\n]*\\n(?:(?!${escapeRe(TOML_BLOCK_END)})[^\\n]*\\n?)*${escapeRe(TOML_BLOCK_END)}[^\\n]*\\n?`, 'g');
}

export function tomlString(s: string): string {
  return JSON.stringify(s);
}

export interface TomlManagedSpec {
  /** Label inside the begin marker, e.g. `vg install codex --compress`. */
  label: string;
  /** Top-level keys placed before the first table (rewritten in place when the user declared them). */
  topLevel?: Record<string, string>;
  /** Extra managed blocks appended at the end (tables). Each is the full block body text. */
  blocks?: string[];
}

export interface TomlEditOutcome extends EditOutcome {
  /** Managed-block text that was present before (null = none). */
  previousBlocks: string | null;
}

/** Index of the first table header line (`[x]` / `[[x]]`) or the text length. */
function firstTableIndex(text: string): number {
  const m = /(^|\n)[ \t]*\[/.exec(text);
  return m ? m.index + m[1]!.length : text.length;
}

/** Rewrite a top-level `key = …` line in place with a `# was:` trailer. Returns whether it matched. */
function rewriteTopLevelKey(text: string, key: string, value: string): { text: string; matched: boolean } {
  const head = text.slice(0, firstTableIndex(text));
  const re = new RegExp(`(^|\\n)([ \\t]*${escapeRe(key)}[ \\t]*=[ \\t]*)([^\\n]*)`);
  const m = re.exec(head);
  if (!m) return { text, matched: false };
  const original = m[3]!;
  if (original.trim() === value) return { text, matched: true };
  const wasIdx = original.indexOf(WAS_SUFFIX);
  const orig = wasIdx >= 0 ? original.slice(wasIdx + WAS_SUFFIX.length) : original;
  const replaced = `${m[1]}${m[2]}${value}${WAS_SUFFIX}${orig}`;
  return { text: head.slice(0, m.index) + replaced + head.slice(m.index + m[0].length) + text.slice(head.length), matched: true };
}

function restoreTopLevelKeys(text: string): string {
  const headLen = firstTableIndex(text);
  const head = text.slice(0, headLen).replace(/(^|\n)([ \t]*[A-Za-z0-9_-]+[ \t]*=[ \t]*)([^\n]*?)  # was: ([^\n]*)/g, (_m, nl: string, lhs: string, _v: string, was: string) => `${nl}${lhs}${was}`);
  return head + text.slice(headLen);
}

export function applyTomlManaged(file: string, spec: TomlManagedSpec): TomlEditOutcome {
  const raw = readTextSafe(file);
  const existed = raw !== null;
  let text = raw ?? '';
  if (text.trim()) {
    try {
      parseToml(stripManagedBlocks(text, spec.label));
    } catch {
      throw new CliError(`${file} exists but is not valid TOML — fix or remove it, then rerun. Refusing to overwrite it.`, ExitCode.ERROR);
    }
  }
  const begin = TOML_BLOCK_BEGIN(spec.label);
  const re = blockRe(begin);
  const prevBlocks = text.match(re);
  const previousBlocks = prevBlocks ? prevBlocks.map((b) => b.replace(/^\n/, '')).join('\n') : null;
  text = stripManagedBlocks(text, spec.label);

  const previous: Record<string, PrevValue> = {};
  const undeclared: string[] = [];
  for (const [key, value] of Object.entries(spec.topLevel ?? {})) {
    const r = rewriteTopLevelKey(text, key, value);
    previous[key] = r.matched ? { present: true, value: 'in-place' } : { present: false };
    if (r.matched) text = r.text;
    else undeclared.push(`${key} = ${value}`);
  }
  if (undeclared.length) {
    const block = `${begin}\n${undeclared.join('\n')}\n${TOML_BLOCK_END}\n`;
    const at = firstTableIndex(text);
    const head = text.slice(0, at);
    const tail = text.slice(at);
    text = head.length && !head.endsWith('\n') ? `${head}\n${block}${tail.length ? '\n' : ''}${tail}` : `${head}${head.length ? '\n' : ''}${block}${tail.length ? '\n' : ''}${tail}`;
  }
  for (const body of spec.blocks ?? []) {
    const block = `${begin}\n${body.replace(/\s*$/, '')}\n${TOML_BLOCK_END}\n`;
    text = text.trim().length ? `${text.replace(/\s*$/, '')}\n\n${block}` : block;
  }
  previous['managed-block'] = previousBlocks === null ? { present: false } : { present: true, value: previousBlocks };
  const changed = text !== (raw ?? '');
  if (changed || !existed) writeFileAtomic(file, text);
  return { changed: changed || !existed, previous, created: !existed, text, previousBlocks };
}

export function stripManagedBlocks(text: string, label: string): string {
  const out = text.replace(blockRe(TOML_BLOCK_BEGIN(label)), (m) => (m.startsWith('\n') ? '\n' : ''));
  const collapsed = out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return collapsed.trim().length ? collapsed.replace(/\n+$/, '\n') : '';
}

export function revertTomlManaged(file: string, label: string, previous: Record<string, PrevValue>): { changed: boolean; text: string; empty: boolean } {
  const raw = readTextSafe(file);
  if (raw === null) return { changed: false, text: '', empty: true };
  let text = stripManagedBlocks(raw, label);
  text = restoreTopLevelKeys(text);
  const prevBlocks = previous['managed-block'];
  if (prevBlocks?.present && typeof prevBlocks.value === 'string') {
    text = text.trim().length ? `${text.replace(/\s*$/, '')}\n\n${prevBlocks.value.replace(/\s*$/, '')}\n` : `${prevBlocks.value.replace(/\s*$/, '')}\n`;
  }
  return { changed: text !== raw, text, empty: text.trim().length === 0 };
}

export function tomlEqual(a: string, b: string): boolean {
  try {
    return canonicalize(parseToml(a)) === canonicalize(parseToml(b));
  } catch {
    return a === b;
  }
}

// ---------------------------------------------------------------------------
// Managed apply / revert (marker + owners + lock + backup)
// ---------------------------------------------------------------------------

export type Format = 'json' | 'yaml' | 'toml';

export interface ManagedEdit {
  format: Format;
  /** Perform the edit; the file is already locked. */
  edit: () => EditOutcome;
  /** Field-level revert for `previous`. */
  revert: (previous: Record<string, PrevValue>) => { changed: boolean; text: string; empty: boolean };
}

export interface ManagedApplyResult {
  status: 'applied' | 'updated' | 'unchanged';
  changed: boolean;
  backup?: string;
  fields: string[];
  marker: WrapMarker;
}

const EQUAL: Record<Format, (a: string, b: string) => boolean> = { json: jsonEqual, yaml: yamlEqual, toml: tomlEqual };

/**
 * Apply an edit under the settings lock: heal a stale marker first, snapshot
 * the file once, perform the edit, claim ownership of every touched field and
 * stamp the marker. Re-applying from the same process is an update.
 */
export function applyManaged(file: string, url: string, edit: ManagedEdit, ctx: EditContext): ManagedApplyResult {
  const c = resolvedCtx(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(
    wrapSettingsLockPath(file),
    () => {
      const conflict = markerConflict(file);
      if (conflict) {
        throw new CliError(`${path.basename(file)} shares its directory with ${path.basename(conflict.file)}, which is already wrapped${conflict.durable ? ' durably' : ` by pid ${conflict.pid}`} — run \`vg uninstall ${conflict.agent}\` first.`, ExitCode.ERROR);
      }
      healStaleMarker(file, edit, c);
      const existing = readMarker(file);
      const snap = snapshotIfAbsent(file);
      const outcome = edit.edit();
      const originals = claimFields(file, outcome.previous, c);
      const fields: Record<string, PrevValue> = {};
      for (const key of Object.keys(outcome.previous)) fields[key] = originals[key] ?? outcome.previous[key]!;
      const me = ctx.durable ? { pid: 0 } : c.identity(c.pid);
      const marker: WrapMarker = {
        format: 1,
        agent: ctx.agent,
        url,
        version: c.version,
        appliedAt: existing && existing.pid === c.pid ? existing.appliedAt : c.now(),
        pid: c.pid,
        startSrc: me.startSrc,
        startTime: me.startTime,
        port: ctx.port,
        durable: ctx.durable === true || undefined,
        file,
        created: existing?.created ?? outcome.created,
        createdBackup: (existing?.pid === c.pid && existing.createdBackup) || snap.created,
        fields,
      };
      writeMarker(file, marker);
      return {
        status: existing ? (outcome.changed ? 'updated' : 'unchanged') : outcome.changed ? 'applied' : 'unchanged',
        changed: outcome.changed,
        backup: fs.existsSync(snap.backup) ? snap.backup : undefined,
        fields: Object.keys(fields).sort(),
        marker,
      };
    },
    { now: c.now, pid: c.pid, isAlive: c.isAlive, staleMs: ctx.lockStaleMs, timeoutMs: ctx.lockTimeoutMs },
  );
}

/** A marker left by a dead process is reverted before a new session adopts the slot. */
function healStaleMarker(file: string, edit: ManagedEdit, c: ReturnType<typeof resolvedCtx>): void {
  const marker = readMarker(file);
  if (!marker || marker.pid === c.pid || marker.durable) return;
  const alive = c.isAlive(marker.pid) && !identityMismatch(marker, c.identity(marker.pid));
  if (alive) return;
  revertLocked(file, edit, marker, { ...c, pid: marker.pid, force: false, releaseDurable: false }, new Set(marker.port !== undefined ? [marker.port] : []));
}

export interface ManagedRevertResult {
  status: 'reverted' | 'skipped' | 'noop';
  changed: boolean;
  fields: string[];
  reason?: string;
}

/**
 * Revert under the lock. Fields still held by another live session are left
 * in place (the marker is re-homed to the survivor) unless `ctx.force`.
 */
export function revertManaged(file: string, edit: ManagedEdit, ctx: EditContext, deadPorts: Set<number> = new Set()): ManagedRevertResult {
  const c = resolvedCtx(ctx);
  if (!fs.existsSync(path.dirname(file))) return { status: 'noop', changed: false, fields: [] };
  return withLock(
    wrapSettingsLockPath(file),
    () => {
      const marker = readMarker(file);
      if (!marker) return { status: 'noop', changed: false, fields: [] };
      const pid = ctx.force || (ctx.releaseDurable && marker.durable) ? marker.pid : c.pid;
      return revertLocked(file, edit, marker, { ...c, pid }, deadPorts);
    },
    { now: c.now, pid: c.pid, isAlive: c.isAlive, staleMs: ctx.lockStaleMs, timeoutMs: ctx.lockTimeoutMs },
  );
}

function revertLocked(file: string, edit: ManagedEdit, marker: WrapMarker, c: ReturnType<typeof resolvedCtx>, deadPorts: Set<number>): ManagedRevertResult {
  const keys = Object.keys(marker.fields).sort();
  const releases = releaseFields(file, keys, c, deadPorts);
  const toRestore: Record<string, PrevValue> = {};
  let survivor: OwnerHolder | undefined;
  for (const key of keys) {
    const r = releases[key]!;
    if (!r.shouldRestore) {
      survivor = survivor ?? r.survivor;
      continue;
    }
    toRestore[key] = r.trustCaller || r.original === undefined ? marker.fields[key]! : r.original;
  }
  if (Object.keys(toRestore).length === 0) {
    if (survivor) writeMarker(file, { ...marker, pid: survivor.pid, startSrc: survivor.startSrc, startTime: survivor.startTime, port: survivor.port, durable: survivor.durable });
    else clearMarker(file);
    const reason = survivor ? (survivor.durable ? 'kept: durable routing from `vg install --compress` (run `vg uninstall` to remove it)' : `still in use by pid ${survivor.pid}`) : 'nothing to restore';
    return { status: 'skipped', changed: false, fields: keys, reason };
  }
  const backup = wrapBackupPath(file);
  const hasBackup = fs.existsSync(backup);
  const fullRevert = Object.keys(toRestore).length === keys.length;
  let changed = false;
  if (fs.existsSync(file)) {
    const reverted = edit.revert(toRestore);
    const backupText = hasBackup ? readTextSafe(backup) : null;
    // The last holder leaving ends the wrap era for this file: when the field
    // revert lands on the same document the backup holds, put the original
    // bytes back (formatting and comments included).
    if (fullRevert && backupText !== null && EQUAL[edit.format](reverted.text, backupText)) {
      writeFileAtomic(file, fs.readFileSync(backup));
      changed = true;
    } else if (reverted.empty && marker.created) {
      fs.unlinkSync(file);
      changed = true;
    } else if (reverted.changed) {
      writeFileAtomic(file, reverted.text);
      changed = true;
    }
  }
  if (fullRevert) {
    if (hasBackup) {
      try {
        fs.unlinkSync(backup);
      } catch {
        /* gone */
      }
    }
    clearMarker(file);
  } else {
    const remaining: Record<string, PrevValue> = {};
    for (const key of keys) if (!(key in toRestore)) remaining[key] = marker.fields[key]!;
    if (survivor) writeMarker(file, { ...marker, pid: survivor.pid, startSrc: survivor.startSrc, startTime: survivor.startTime, port: survivor.port, durable: survivor.durable, fields: remaining });
    else clearMarker(file);
  }
  return { status: 'reverted', changed, fields: Object.keys(toRestore).sort() };
}
