import type { HaileSymbol } from './types.js';

/** True when a classify-file symbol has the fields `vg show` reads. */
export function isUsableHaileSymbol(symbol: unknown): symbol is HaileSymbol {
  if (!symbol || typeof symbol !== 'object') return false;
  const s = symbol as Partial<HaileSymbol>;
  if (typeof s.node_id !== 'string' || !s.node_id) return false;
  const role = s.role;
  if (!role || typeof role !== 'object') return false;
  if (typeof role.primary !== 'string' || !role.primary) return false;
  if (typeof role.confidence !== 'number' || !Number.isFinite(role.confidence)) return false;
  if (typeof role.band !== 'string') return false;
  if (!Array.isArray(role.alternatives)) return false;
  if (!Array.isArray(s.purposes)) return false;
  const intent = s.intent;
  if (!intent || typeof intent !== 'object' || typeof intent.text !== 'string') return false;
  if (!Array.isArray(intent.verbs) || !Array.isArray(intent.objects)) return false;
  return true;
}

/** Text lines for `vg show`. Empty when the symbol is missing or malformed. */
export function formatHaileLines(symbol: HaileSymbol | null | undefined): string[] {
  if (!isUsableHaileSymbol(symbol)) return [];
  const alts = symbol.role.alternatives
    .slice(0, 3)
    .filter((a) => a && typeof a.role === 'string' && typeof a.confidence === 'number')
    .map((a) => `${a.role} ${a.confidence.toFixed(2)}`)
    .join(', ');
  const purposes =
    symbol.purposes
      .filter((p) => p && typeof p.purpose === 'string' && typeof p.confidence === 'number')
      .map((p) => `${p.purpose} ${p.confidence.toFixed(2)}`)
      .join(', ') || '—';
  const lines = [
    `  role ${symbol.role.primary} ${symbol.role.confidence.toFixed(2)} · ${symbol.role.band}${alts ? ` (${alts})` : ''}`,
    `  purposes ${purposes}`,
    `  intent ${symbol.intent.text}`,
  ];
  if (symbol.file_layer) lines.push(`  file-layer ${symbol.file_layer}`);
  for (const finding of symbol.findings ?? []) {
    if (!finding || typeof finding.message !== 'string' || typeof finding.rule !== 'string') continue;
    lines.push(`  boundary ${finding.severity === 'hard' ? 'violation' : 'warning'}: ${finding.message} (${finding.rule})`);
  }
  return lines;
}

export function haileJsonFields(symbol: HaileSymbol | undefined): Record<string, unknown> | undefined {
  if (!isUsableHaileSymbol(symbol)) return undefined;
  return {
    role: symbol.role,
    purposes: symbol.purposes,
    intent: symbol.intent,
    band: symbol.role.band,
    evidence: Array.isArray(symbol.evidence) ? symbol.evidence : [],
    findings: Array.isArray(symbol.findings) ? symbol.findings : [],
    file_layer: symbol.file_layer ?? null,
    ast_role: symbol.ast_role ?? null,
  };
}
