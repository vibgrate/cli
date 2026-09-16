/**
 * Trust-boundary sanitiser for architecture payloads from the optional module.
 * Malformed output is dropped; the host then uses its own overview/slice.
 */
import {
  ARCH_OVERVIEW_MAGIC,
  ARCH_SLICE_MAGIC,
  OVERVIEW_PACKAGE_CAP,
  SLICE_CARD_CAP,
  type ArchCard,
  type ArchOverview,
  type ArchPackageEdge,
  type ArchPackageNode,
  type ArchSlice,
  type ArchSliceColumn,
} from './arch-types.js';

export function sanitizeOverview(raw: unknown): ArchOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ArchOverview>;
  if (o.magic !== ARCH_OVERVIEW_MAGIC) return null;
  if (!Array.isArray(o.packages) || !Array.isArray(o.edges) || !o.meta || typeof o.meta !== 'object') return null;
  const packages: ArchPackageNode[] = [];
  for (const p of o.packages.slice(0, OVERVIEW_PACKAGE_CAP)) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.path !== 'string') continue;
    if (p.kind !== 'package' && p.kind !== 'area' && p.kind !== 'root') continue;
    packages.push({
      id: p.id,
      name: p.name,
      path: p.path,
      kind: p.kind,
      symbols: num(p.symbols),
      findings: num(p.findings),
      missingSteps: num(p.missingSteps),
      job: typeof p.job === 'string' ? p.job : 'package',
      policy: typeof p.policy === 'string' ? p.policy : null,
      lane: typeof p.lane === 'string' ? p.lane : 'unclassified',
      ...(typeof p.mix === 'string' ? { mix: p.mix } : {}),
      ...(typeof p.unclassified === 'number' ? { unclassified: num(p.unclassified) } : {}),
    });
  }
  const edges: ArchPackageEdge[] = [];
  for (const e of o.edges.slice(0, 500)) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.id !== 'string' || typeof e.src !== 'string' || typeof e.dst !== 'string' || typeof e.kind !== 'string') {
      continue;
    }
    edges.push({ id: e.id, src: e.src, dst: e.dst, kind: e.kind, weight: Math.max(1, num(e.weight)) });
  }
  const meta = o.meta;
  return {
    magic: ARCH_OVERVIEW_MAGIC,
    packages,
    edges,
    meta: {
      architectureLoaded: Boolean(meta.architectureLoaded),
      policy: typeof meta.policy === 'string' ? meta.policy : null,
      policyLabel: typeof meta.policyLabel === 'string' ? meta.policyLabel : null,
      symbols: num(meta.symbols),
      packages: packages.length,
      findings: num(meta.findings),
      missingSteps: num(meta.missingSteps),
      title: typeof meta.title === 'string' && meta.title ? meta.title : 'Code map',
    },
  };
}

export function sanitizeSlice(raw: unknown): ArchSlice | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ArchSlice>;
  if (o.magic !== ARCH_SLICE_MAGIC) return null;
  if (typeof o.packageId !== 'string' || !Array.isArray(o.columns) || !Array.isArray(o.edges)) return null;
  const policy = o.policy === 'layered-v1' || o.policy === 'hexagonal-v1' || o.policy === 'kind' ? o.policy : 'kind';
  const columns: ArchSliceColumn[] = [];
  let painted = 0;
  for (const col of o.columns.slice(0, 8)) {
    if (!col || typeof col !== 'object' || typeof col.id !== 'string' || typeof col.title !== 'string') continue;
    if (!Array.isArray(col.cards)) continue;
    const cards: ArchCard[] = [];
    for (const c of col.cards) {
      if (painted >= SLICE_CARD_CAP) break;
      const card = sanitizeCard(c);
      if (!card) continue;
      cards.push(card);
      painted += 1;
    }
    const group = col.group === 'core' || col.group === 'outbound' ? col.group : undefined;
    columns.push({ id: col.id, title: col.title, cards, ...(group ? { group } : {}) });
  }
  const guards = Array.isArray(o.guards)
    ? o.guards.map(sanitizeCard).filter((c): c is ArchCard => Boolean(c)).slice(0, 40)
    : [];
  const edges = [];
  for (const e of o.edges.slice(0, 400)) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.id !== 'string' || typeof e.src !== 'string' || typeof e.dst !== 'string' || typeof e.kind !== 'string') {
      continue;
    }
    edges.push({ id: e.id, src: e.src, dst: e.dst, kind: e.kind });
  }
  const overflow: Record<string, number> = {};
  if (o.overflow && typeof o.overflow === 'object') {
    for (const [k, v] of Object.entries(o.overflow)) {
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) && v >= 0) overflow[k] = Math.floor(v);
    }
  }
  const overflowHint: Record<string, string> = {};
  if (o.overflowHint && typeof o.overflowHint === 'object') {
    for (const [k, v] of Object.entries(o.overflowHint)) {
      if (typeof k === 'string' && typeof v === 'string') overflowHint[k] = v;
    }
  }
  return {
    magic: ARCH_SLICE_MAGIC,
    packageId: o.packageId,
    packageName: typeof o.packageName === 'string' ? o.packageName : o.packageId,
    policy,
    columns,
    guards,
    edges,
    overflow,
    overflowHint,
    emptyHint: typeof o.emptyHint === 'string' ? o.emptyHint : null,
    focusCardId: typeof o.focusCardId === 'string' ? o.focusCardId : null,
  };
}

function sanitizeCard(raw: unknown): ArchCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<ArchCard>;
  if (typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.lane !== 'string') return null;
  if (typeof c.symbolId !== 'string') return null;
  return {
    id: c.id,
    title: c.title,
    subtitle: typeof c.subtitle === 'string' ? c.subtitle : '',
    lane: c.lane,
    file: typeof c.file === 'string' ? c.file : '',
    line: typeof c.line === 'number' && Number.isFinite(c.line) && c.line > 0 ? Math.floor(c.line) : null,
    symbolId: c.symbolId,
    count: Math.max(1, num(c.count)),
    job: typeof c.job === 'string' ? c.job : '',
    color: typeof c.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : '#94a3b8',
    classified: Boolean(c.classified),
    pulse: Boolean(c.pulse),
    missingStep: Boolean(c.missingStep),
    ...(c.ghost ? { ghost: true } : {}),
    ...(typeof c.intent === 'string' ? { intent: c.intent } : {}),
    ...(typeof c.callsOut === 'number' ? { callsOut: num(c.callsOut) } : {}),
    ...(Array.isArray(c.calls) ? { calls: c.calls.filter(isLink).slice(0, 12) } : {}),
    ...(Array.isArray(c.calledBy) ? { calledBy: c.calledBy.filter(isLink).slice(0, 12) } : {}),
    ...(Array.isArray(c.types) ? { types: c.types.filter((t): t is string => typeof t === 'string').slice(0, 12) } : {}),
    ...(Array.isArray(c.members)
      ? {
          members: c.members
            .filter((m) => m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string')
            .slice(0, 8)
            .map((m) => {
              const row = m as { id?: string; name: string; job?: string; file?: string; line?: number | null };
              return {
                id: typeof row.id === 'string' ? row.id : row.name,
                name: row.name,
                job: typeof row.job === 'string' ? row.job : '',
                file: typeof row.file === 'string' ? row.file : '',
                line: typeof row.line === 'number' && row.line > 0 ? Math.floor(row.line) : null,
              };
            }),
        }
      : {}),
    ...(c.guard ? { guard: true } : {}),
    ...(Array.isArray(c.findings)
      ? {
          findings: c.findings
            .filter(isFinding)
            .slice(0, 8)
            .map((f) => ({
              rule: f.rule,
              severity: f.severity,
              message: f.message,
              line: typeof f.line === 'number' && Number.isFinite(f.line) && f.line > 0 ? Math.floor(f.line) : null,
            })),
        }
      : {}),
  };
}

function isFinding(v: unknown): v is { rule: string; severity: string; message: string; line?: unknown } {
  if (!v || typeof v !== 'object') return false;
  const f = v as { rule?: unknown; severity?: unknown; message?: unknown };
  return typeof f.rule === 'string' && typeof f.severity === 'string' && typeof f.message === 'string';
}

function isLink(v: unknown): v is { id: string; name: string } {
  return Boolean(v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { name?: unknown }).name === 'string');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
