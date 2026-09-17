# `vg show arch`

Open a local, interactive architecture map of the code graph after `vg build`.

`vg show chart` — the spelling this shipped under before the Architecture module got its public name — still works as a silent alias for one release; it is not listed in `vg show --help`.

```bash
vg build
vg show arch
# vg · arch  http://127.0.0.1:7420
```

Loopback only by default (`127.0.0.1:7420`). `--port`, `--host`, `--focus`, and `--no-open` are available. `--json` prints the URL and counts, then keeps serving until you stop it.

## What it is

The same facts as `vg show`, `vg path`, and `vg impact`, drawn so a human can walk them — **packages first**, then one project’s column slice. It does not paint every function as a card.

1. **Workspace** — one card per package (or cluster, when the graph has no packages). Edges are package-to-package, not every call.
2. **Slice** — double-click a package. Columns follow the architecture policy: UI / endpoint → application → store (layered) or adapters → application → domain → ports (hexagonal). Same-file, same-role functions collapse to one card. Tests stay hidden unless you ask. At most 120 cards.
3. **Details** — click a card. The right rail is `vg show --json` for that symbol.

Toolbar filters apply **inside the current zoom**, never across the raw graph.

- **By job** — policy columns (the default slice)
- **By cluster** — workspace grouped by graph areas
- **Who calls whom** — call edges only, still collapsed
- **Missing steps** — a call exists in source but not on the map
- **Problems** — architecture-rule breaks with a line in this body

Architecture off is the raw graph’s kinds in the same columns. Architecture on paints jobs and “writes data / reads data” chips from `graph.arch.json`. No confidence percentages. No taxonomy slugs in the chrome.

A rose mark is a finding with `line > 0`. A yellow mark is a missing step. They are not the same thing.

**Overlays** sit on the same Overview and Architecture canvas (the Health tab opens that chrome — it is not a blank page). Vulns, drift, ownership, and churn are toggles. The engine joins existing scan / CODEOWNERS / git data onto cards; missing source is omitted, never painted as a healthy zero. This is not an Architecture Health Score and not the Cloud ≈100−drift KPI.

- **Vulns** — reachable findings from a connected `vg scan` (DSN online). No reachability → honest empty.
- **Drift** — dependency drift already on the scan artifact, joined by path (and import when the graph has it). `current` / `unknown` do not paint.
- **Ownership** — CODEOWNERS teams only. A team is not an architecture layer.
- **Churn** — relative git heat in a bounded commit window. No git → overlay disabled.

The VS Code architecture board hosts the same page and payload as `vg show arch`.

`/api/overview` is the workspace map. `/api/slice?package=` is the column view. `/api/graph` is deprecated (it returns the overview). `/api/node/:id` is `vg show --json` plus a `view` block of the English labels. `/api/path` uses the same shortest-path engine as `vg path`. `/api/reach/:id` walks callers (`dir=up`) or callees (`dir=down`).

Deep links use `#zoom=workspace` or `#zoom=slice&package=<id>&n=<symbol>`. `vg show arch --focus scanDir` opens the owning package’s slice with that symbol selected.

## What this is not

Not a new top-level verb. Not a cloud service. Not a React bundle in the public CLI (the dash Code-graph page can consume the same `/api/*` later). Not a classifier — if the architecture module did not write a sidecar, the map stays honest and graph-only.
