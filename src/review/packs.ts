/**
 * `.vibgrate/review/` packs for `vg review`.
 *
 * Canonical tree only. Team ignore / policy / merge / checks live next to the
 * code they govern. This loader is local and deterministic — it never calls a
 * hosted model.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateMergePolicy, matchSimpleGlob, type MergeDecision } from './merge-policy.js';

export const REVIEW_ROOT = '.vibgrate/review';
export const REVIEW_CHECK_DIR = '.vibgrate/review/checks';
export const REVIEW_IGNORE_PATH = `${REVIEW_ROOT}/ignore.md`;
export const REVIEW_POLICY_PATH = `${REVIEW_ROOT}/policy.md`;
export const REVIEW_MERGE_PATH = `${REVIEW_ROOT}/merge.md`;

const RESERVED = new Set(['ignore.md', 'policy.md', 'merge.md', 'readme.md']);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ReviewIgnore {
  patterns: string[];
}

export interface ReviewPolicyDoc {
  instructions: string;
}

export interface ReviewMergeDoc {
  enabled: boolean;
  requireHuman: string[];
  instructions: string;
}

export interface ReviewPackCheck {
  id: string;
  path: string;
  title: string;
  channels: 'github' | 'cli' | 'both';
  include: string[];
  exclude: string[];
  enabled: boolean;
  instructions: string;
}

export interface ReviewCheckRun {
  id: string;
  title: string;
  path: string;
  ran: boolean;
  reason?: string;
}

export interface ReviewPackReport {
  /** True when at least one pack file existed on disk. */
  loaded: boolean;
  ignore: ReviewIgnore;
  policy: ReviewPolicyDoc | null;
  merge: ReviewMergeDoc | null;
  mergeDecision: MergeDecision | null;
  mergeReasons: string[];
  checks: ReviewCheckRun[];
  issues: string[];
}

export function parseIgnoreMarkdown(content: string): ReviewIgnore {
  const body = stripFrontMatter(content).body;
  const patterns: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue;
    const item = line.replace(/^[-*+]\s+/, '').replace(/^`|`$/g, '').trim();
    if (!item || item.startsWith('#') || /^[=-]{3,}$/.test(item)) continue;
    patterns.push(item.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return { patterns };
}

export function parsePolicyMarkdown(content: string): ReviewPolicyDoc {
  return { instructions: stripFrontMatter(content).body.trim() };
}

export function parseMergeMarkdown(content: string): ReviewMergeDoc {
  const { raw, body } = stripFrontMatter(content);
  const enabled = raw.enabled === undefined ? true : raw.enabled === true || raw.enabled === 'true';
  const requireHuman = asStringList(raw['require-human'] ?? raw.requireHuman);
  return { enabled, requireHuman, instructions: body.trim() };
}

export function isIgnoredPath(filePath: string, ignore: ReviewIgnore): boolean {
  const value = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return ignore.patterns.some((pattern) => matchSimpleGlob(pattern, value));
}

export function loadReviewPacks(
  root: string,
  changedFiles: string[],
): ReviewPackReport {
  const ignoreText = readIfPresent(root, REVIEW_IGNORE_PATH);
  const policyText = readIfPresent(root, REVIEW_POLICY_PATH);
  const mergeText = readIfPresent(root, REVIEW_MERGE_PATH);
  const checkFiles = listCheckFiles(root);

  const loaded = Boolean(ignoreText || policyText || mergeText || checkFiles.length);
  const ignore = ignoreText ? parseIgnoreMarkdown(ignoreText) : { patterns: [] };
  const policy = policyText ? parsePolicyMarkdown(policyText) : null;
  const merge = mergeText ? parseMergeMarkdown(mergeText) : null;
  const issues: string[] = [];
  const checks: ReviewCheckRun[] = [];

  for (const file of checkFiles) {
    const parsed = parseCheckFile(file.path, file.content);
    if ('error' in parsed) {
      issues.push(`${file.path}: ${parsed.error}`);
      continue;
    }
    checks.push(applyCheck(parsed.check, changedFiles));
  }
  checks.sort((a, b) => a.id.localeCompare(b.id));

  let mergeDecision: MergeDecision | null = null;
  let mergeReasons: string[] = [];
  if (merge) {
    const evaluated = evaluateMergePolicy({
      enabled: merge.enabled,
      requireHuman: merge.requireHuman,
      changedFiles,
    });
    mergeDecision = evaluated.decision;
    mergeReasons = evaluated.reasons;
  }

  return {
    loaded,
    ignore,
    policy,
    merge,
    mergeDecision,
    mergeReasons,
    checks,
    issues,
  };
}

function applyCheck(check: ReviewPackCheck, changedFiles: string[]): ReviewCheckRun {
  if (!check.enabled) {
    return { id: check.id, title: check.title, path: check.path, ran: false, reason: 'disabled' };
  }
  if (check.channels === 'github') {
    return { id: check.id, title: check.title, path: check.path, ran: false, reason: 'channel_github' };
  }
  if (!matchesFileScope(check, changedFiles)) {
    return { id: check.id, title: check.title, path: check.path, ran: false, reason: 'file_scope' };
  }
  return { id: check.id, title: check.title, path: check.path, ran: true };
}

function matchesFileScope(check: ReviewPackCheck, changedFiles: string[]): boolean {
  const files = changedFiles.map((f) => f.replace(/\\/g, '/'));
  if (check.exclude.some((pattern) => files.some((f) => matchSimpleGlob(pattern, f)))) {
    const remaining = files.filter((f) => !check.exclude.some((pattern) => matchSimpleGlob(pattern, f)));
    if (remaining.length === 0) return false;
  }
  if (check.include.length === 0) return files.length > 0 || changedFiles.length === 0;
  return files.some((f) => check.include.some((pattern) => matchSimpleGlob(pattern, f)));
}

function parseCheckFile(filePath: string, content: string): { check: ReviewPackCheck } | { error: string } {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (RESERVED.has(base)) return { error: 'Reserved filename cannot be used as a Review check.' };
  if (!filePath.endsWith('.md')) return { error: 'Review checks must be markdown files.' };
  const { raw, body } = stripFrontMatter(content);
  const id = slug(asString(raw.id) ?? base.replace(/\.md$/i, ''));
  if (!id) return { error: 'Check id is empty.' };
  const channels = asChannel(raw.channels);
  return {
    check: {
      id,
      path: filePath,
      title: asString(raw.title) ?? titleFromId(id),
      channels,
      include: asStringList(raw.include),
      exclude: asStringList(raw.exclude),
      enabled: raw.enabled === undefined ? true : raw.enabled === true || raw.enabled === 'true',
      instructions: body.trim(),
    },
  };
}

function listCheckFiles(root: string): { path: string; content: string }[] {
  const dir = path.join(root, REVIEW_CHECK_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  const out: { path: string; content: string }[] = [];
  for (const name of names) {
    const rel = `${REVIEW_CHECK_DIR}/${name}`;
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      out.push({ path: rel, content: fs.readFileSync(abs, 'utf8') });
    } catch {
      /* unreadable */
    }
  }
  return out;
}

function readIfPresent(root: string, rel: string): string | null {
  const abs = path.join(root, rel);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function stripFrontMatter(content: string): { raw: Record<string, unknown>; body: string } {
  const trimmed = content.replace(/^\uFEFF/, '');
  const match = trimmed.match(FRONTMATTER);
  if (!match) return { raw: {}, body: trimmed };
  return { raw: parseSimpleFrontMatter(match[1] ?? ''), body: match[2] ?? '' };
}

function parseSimpleFrontMatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let current: string | null = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const list = rawLine.match(/^\s+-\s+(.*)$/);
    if (list && current) {
      const prev = out[current];
      const next = String(list[1]).trim();
      out[current] = Array.isArray(prev) ? [...prev, next] : [next];
      continue;
    }
    const kv = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    current = kv[1] ?? null;
    const value = (kv[2] ?? '').trim();
    if (value === 'true') out[kv[1]] = true;
    else if (value === 'false') out[kv[1]] = false;
    else if (value === '' || value === '|' || value === '>') out[kv[1]] = [];
    else out[kv[1]] = value.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function asChannel(value: unknown): 'github' | 'cli' | 'both' {
  return value === 'github' || value === 'cli' || value === 'both' ? value : 'both';
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
