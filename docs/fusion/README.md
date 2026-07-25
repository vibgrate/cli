# Fusion Runtime (public CLI)

Phase-0 foundations for the Vibgrate Fusion Runtime live here and in
`src/code/capsule.ts`, `src/code/patch-ir.ts`, and `src/runtime/paths.ts`.

| Doc / schema | Purpose |
|--------------|---------|
| [task-capsule-v0.schema.json](./task-capsule-v0.schema.json) | Source-bearing Task Capsule contract |
| [patch-ir-v0.schema.json](./patch-ir-v0.schema.json) | Patch intermediate representation |
| [failure-capsule-v0.schema.json](./failure-capsule-v0.schema.json) | Focused repair context after verify fail |
| [model-execution-profile-v0.schema.json](./model-execution-profile-v0.schema.json) | Per-model capsule budget, repair, isolation knobs |
| [run-provenance-v0.schema.json](./run-provenance-v0.schema.json) | Content-hashed run summary + pinned `context-policy@…` |
| Project-context ingest | `src/engine/docs-ingest.ts` — README, manifests, Docker/CI/OpenAPI → `document` nodes for ask |
| Network policy | `src/code/network-policy.ts` — default-deny agent shell egress |
| Firecracker L3 | `src/runtime/firecracker.ts` — microVM plan when images configured |
| Workspace discovery | `src/runtime/discover-workspaces.ts` — package/pnpm/submodule/code-workspace |
| Bridge edges | `src/runtime/bridge-edges.ts` — `bridge-edge/0` package-dep links |
| Interface bridges | `src/runtime/interface-bridges.ts` — OpenAPI / Compose / protobuf / GraphQL |
| Context-policy patch | `src/code/context-policy.ts` + `context-policy-patch-v0.schema.json` |
| gVisor L2 | `src/runtime/gvisor.ts` — runsc plan when images configured |
| MEP catalogue | `src/runtime/model-execution-catalogue.ts` — curated coding profiles |
| `vg policy` | pin display + `vg policy verify <patch.json>` |
| Monorepo plan | `docs/plans/001-vibgrate-fusion-runtime-implementation-plan.md` (repo root) |

## Trajectory / FCS

Offline scripted harness (no model):

```bash
pnpm exec vitest run src/code/trajectory.test.ts
```

`runFusionTaskPack()` in `src/code/trajectory-harness.ts` runs capsule / metadata /
oracle arms, builds `TrajectoryRecord`s, and reports **FCS** (capsule solves ÷
oracle solves on paired task ids) and **ZNS@1** (solved from capsule with zero
discovery tools).

SWE-bench Lite–shaped offline corpus: `src/code/fusion-task-pack.ts`
(`swe-lite-*` ids, ≥10 tasks) plus JSON packs under `bench/fusion-tasks/`.
Load with `loadScaledFusionCorpus([dir])`.

Live-model arm (opt-in; you supply the provider):

```ts
import { runLiveFusionArm } from './src/code/live-harness.js';
// await runLiveFusionArm(tasks, { provider: myOllamaProvider, arm: 'capsule' });
```

Publish a workspace map into vgd for IDE query:

```bash
vg daemon ensure
vg daemon publish
vg daemon query "auth handler"
```

## Quick use

```ts
import { buildTaskCapsule } from './src/code/capsule.js';
import { codeEditsToPatchIR, validatePatchIR } from './src/code/patch-ir.js';
import { resolveVibgratePaths, globalGraphPath } from './src/runtime/paths.js';

const capsule = buildTaskCapsule(graph, instruction, {
  readFile: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
});

const patch = codeEditsToPatchIR(parseEdits(modelText));
if (!validatePatchIR(patch).ok) throw new Error('invalid patch');
```

ContextBench (`packages/vibgrate-contextbench-node`) remains the matched A/B/C
harness (`no-graph` / `current-graph` / `capsule`). Keep its capsule arm aligned
with `buildTaskCapsule` when ranking rules change (`capsule-rank@…`).
