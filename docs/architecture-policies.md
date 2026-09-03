# Architecture policy packs: `hexagonal-v1` and `layered-v1`

The architecture module (`vg module install haile`) reads what each function or
method does from its own source text — the store it writes, the query it runs,
the HTTP call it makes, the response it returns — and then judges those duties
against one **policy pack**: a small set of boundary rules for the style of
architecture your repository says it follows. A finding is a crossing of one
of those rules, anchored on the line of the offending call.

Two packs ship. They disagree on purpose, so pick the one that describes your
code **before** you turn on `vg scan --fail-on architecture-finding`. A layered
application judged as a hexagon fails on its services; a hexagonal one judged
as layered fails on its adapters. Nothing here is compiled, interpreted or run.

## Choosing the pack

The pack is chosen once per repository and stamped on the classify file, so
every reader (`vg show`, the VS Code Architecture view, `vg scan`) knows which
rules produced a finding. Precedence, highest first:

| Where | How |
|---|---|
| `vg build --policy layered-v1` | For one build |
| `VIBGRATE_ARCHITECTURE_POLICY=layered-v1` | For one shell or CI job |
| `.vibgrate/architecture.toml` | Committed default for the repository |
| Nothing set | `hexagonal-v1` |

```toml
# .vibgrate/architecture.toml
policy = "layered-v1"
```

An unknown value falls back to `hexagonal-v1` without failing the build. The
pack in force is printed by `vg scan --fail-on architecture-finding` whether
the gate passes or fails, and every rule id carries it as a prefix
(`layered-v1/controller-reads`).

## What each pack expects

| | `hexagonal-v1` (ports and adapters) | `layered-v1` (controller → service → repository) |
|---|---|---|
| Fits | Clean / onion architecture: handlers delegate to an application layer, the domain is pure, persistence sits behind a port interface | Classic MVC and service-layer apps: Spring Boot, ASP.NET MVC, Rails, Django, Express + service classes |
| HTTP handler writes the store itself | **violation** `controller-persists` | **violation** `controller-persists` |
| HTTP handler reads the store itself | allowed | warning `controller-reads` — reads go through the service layer too |
| HTTP handler calls out over HTTP itself | warning `controller-calls-out` (skips the application layer) | warning `controller-calls-out` (skips the service layer) |
| Domain model / domain service writes a store, calls out, or touches the file system | **violation** `domain-does-io` | **violation** `domain-does-io` (the model layer must stay pure) |
| Application service / use case writes the ORM directly (a concrete `DbContext`, `PrismaClient`, session) | warning `service-writes-orm` — go through a port or repository | allowed — the service layer owns the ORM |
| Repository / persistence adapter talks to the network | warning `repository-calls-out` | warning `repository-calls-out` |
| View / UI code writes the store | **violation** `view-persists` | **violation** `view-persists` |

"Writes the store itself" means the handler's own body calls a repository, a
DbContext or session, an ORM model, or a SQL write — or calls into a class
whose name says it is the store layer. Delegating to an application service,
a command handler or a MediatR-style `Send` is the intended path and is never
a crossing, even when that callee persists. Writing through an interface such
as `IApplicationDbContext` from an application service is a port, not a
violation, under either pack.

## Gating CI

```bash
# hard violations only (recommended first step)
vg scan --fail-on architecture-finding

# violations and warnings — the dry run for a stricter gate
vg scan --fail-on architecture-warning
```

The gate is off by default. It needs the code map the scan builds (not
compatible with `--no-graph`, `--max-privacy` or `--no-local-artifacts`) and
the architecture module; when the module has not classified the map the scan
exits 2 with a message saying so rather than passing silently. Each failing
row is printed as `file:line  symbol  violation: message (rule)`; the summary
line names the pack. Start with `architecture-warning` in a non-blocking job to
see what the pack would flag, fix or accept those, then promote to
`architecture-finding` as the blocking gate.

## What the packs do not do

- They do not infer which pack you meant. A repository with no configuration
  is judged as a hexagon.
- One pack applies to the whole repository. A per-path profile map and a
  vertical-slice pack are not shipped.
- They judge duties reconstructed from source text and the code map. An
  untyped call the map could not resolve is not evidence, so a store call on a
  receiver nothing declares does not produce a finding; it also does not
  suppress one that a typed call in the same body produces.
