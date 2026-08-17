// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import {
  contractKindFromName,
  isApplicationSourceFile,
  isContractBasename,
  isContractExtension,
  isIacExtension,
} from '../walker.js';
import type { ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import { filePathHas } from './helpers.js';

/** Below artifact/source (0.55) so mixed trees stay `source`. Still above the floor so the signal is visible. */
const MIXED_ARTIFACT_CONFIDENCE = 0.45;

function generatedHint(file: string): { by: string; signal: string } | undefined {
  const n = file.replace(/\\/g, '/').toLowerCase();
  if (n.endsWith('.pb.go') || n.endsWith('.pb.ts') || n.includes('.grpc.')) {
    return { by: 'protoc', signal: 'protoc-stub' };
  }
  if (n.endsWith('_pb2.py') || n.endsWith('_pb2_grpc.py')) {
    return { by: 'protoc', signal: 'protoc-python' };
  }
  if (n.includes('/generated/') || n.includes('.generated.') || n.includes('/gen/')) {
    if (n.includes('prisma')) return { by: 'prisma', signal: 'prisma-generated' };
    if (n.includes('openapi')) return { by: 'openapi-generator', signal: 'openapi-generated' };
    return { by: 'unknown', signal: 'generated-path' };
  }
  return undefined;
}

export const artifactPacks: ArchitectureKnowledgePack[] = [
  {
    id: 'artifact/contract',
    match(ctx: ProjectContext) {
      const kinds = new Set<string>();
      for (const f of ctx.files) {
        const base = f.replace(/\\/g, '/').split('/').pop() ?? f;
        const ext = (() => {
          const i = f.lastIndexOf('.');
          return i >= 0 ? f.slice(i).toLowerCase() : '';
        })();
        if (!isContractExtension(ext) && !isContractBasename(base)) continue;
        const kind = contractKindFromName(f, base);
        if (kind) kinds.add(kind);
      }
      if (kinds.size === 0) return [];
      const kind = [...kinds].sort((a, b) => a.localeCompare(b))[0]!;
      const dedicated = !ctx.files.some((f) => isApplicationSourceFile(f));
      const confidence = dedicated ? 0.9 : MIXED_ARTIFACT_CONFIDENCE;
      return [evidenceOf('artifact/contract', 'artifactKind', 'contract', confidence, [`contract:${kind}`])];
    },
  },
  {
    id: 'artifact/infrastructure-definition',
    extensions: ['.tf', '.tfvars', '.hcl', '.bicep'],
    match(ctx: ProjectContext) {
      const hit = ctx.files.some((f) => {
        const i = f.lastIndexOf('.');
        return i >= 0 && isIacExtension(f.slice(i));
      });
      if (!hit) return [];
      const dedicated = !ctx.files.some((f) => isApplicationSourceFile(f));
      const confidence = dedicated ? 0.9 : MIXED_ARTIFACT_CONFIDENCE;
      return [evidenceOf('artifact/infrastructure-definition', 'artifactKind', 'infrastructure-definition', confidence, ['iac-extension'])];
    },
  },
  {
    id: 'artifact/migration',
    match(ctx: ProjectContext) {
      if (!filePathHas(ctx, /(^|\/)(migrations|migrate|alembic\/versions)\//)) return [];
      const app = ctx.files.filter((f) => isApplicationSourceFile(f));
      const nonMigration = app.filter((f) => !/(^|\/)(migrations|migrate|alembic\/versions)\//.test(f.replace(/\\/g, '/')));
      const dedicated = nonMigration.length === 0;
      const confidence = dedicated ? 0.8 : MIXED_ARTIFACT_CONFIDENCE;
      return [evidenceOf('artifact/migration', 'artifactKind', 'migration', confidence, ['migration-path'])];
    },
  },
  {
    id: 'artifact/generated',
    match(ctx: ProjectContext) {
      const hints = ctx.files.map((f) => generatedHint(f)).filter((h): h is NonNullable<typeof h> => !!h);
      if (hints.length === 0) return [];
      const app = ctx.files.filter((f) => isApplicationSourceFile(f));
      const dedicated = app.length > 0 && app.every((f) => !!generatedHint(f));
      // Mixed generated+source keeps `generated: true` on the result; do not
      // let artifactKind win over source.
      if (!dedicated) return [];
      const signal = [...new Set(hints.map((h) => h.signal))].sort((a, b) => a.localeCompare(b))[0]!;
      return [evidenceOf('artifact/generated', 'artifactKind', 'generated', 0.85, [signal])];
    },
  },
  {
    id: 'artifact/source',
    match(ctx: ProjectContext) {
      if (!ctx.files.some((f) => isApplicationSourceFile(f))) return [];
      return [evidenceOf('artifact/source', 'artifactKind', 'source', 0.55, ['source-files'])];
    },
  },
];

export function detectGeneratedMeta(files: readonly string[]): {
  generated?: true;
  generatedBy?: string;
} {
  const by = new Set<string>();
  for (const f of files) {
    const hint = generatedHint(f);
    if (hint) by.add(hint.by);
  }
  if (by.size === 0) return {};
  const known = [...by].filter((b) => b !== 'unknown').sort((a, b) => a.localeCompare(b));
  const out: { generated?: true; generatedBy?: string } = { generated: true };
  if (known[0]) out.generatedBy = known[0];
  return out;
}
