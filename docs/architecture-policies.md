# Architecture policy packs and overlays: `hexagonal-v1`, `layered-v1`, `vertical-v1`

The Architecture module (`vg module install arch`) reads what each function or
method does from its own source text — the store it writes, the query it runs,
the HTTP call it makes, the response it returns — and then judges those duties
against one **policy pack**: a small set of boundary rules for the style of
architecture your repository says it follows. A finding is a crossing of one
of those rules, anchored on the line of the offending call.

Three packs ship. They disagree on purpose, so pick the one that describes
your code **before** you turn on `vg scan --fail-on architecture-finding`. A
layered application judged as a hexagon fails on its services; a hexagonal one
judged as layered fails on its adapters; a vertical-slice application judged
under either fails on the handlers that own their slice. On top of the pack
you can add your own rules as [overlays](#your-own-rules-overlays). Nothing
here is compiled, interpreted or run.

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
schema = "vg.arch.policy.v1"
policy = "layered-v1"
```

An unknown value falls back to `hexagonal-v1` without failing the build. The
pack in force is printed by `vg scan --fail-on architecture-finding` whether
the gate passes or fails, by `vg show <symbol>` as its own `policy` line above
the findings, and every rule id carries it as a prefix
(`layered-v1/controller-reads`). The `schema` line is optional; when present
it must read `vg.arch.policy.v1`.

### Seeding the file

`vg build --init-policy` writes a first draft of `.vibgrate/architecture.toml`
from what the build just classified: `layered-v1` when controllers, services
and repositories dominate the roles, `hexagonal-v1` otherwise, never
`vertical-v1` (a role histogram cannot tell a slice from a layer, so that one
is a decision you make by hand). The file carries the overlay tables below as
commented examples. It never overwrites a file that already exists, and the
map you just built was judged under the pack in force *before* the file
existed, so run `vg build` once more to judge it under the seeded pack.

```bash
vg build --init-policy
```

## What each pack expects

| | `hexagonal-v1` (ports and adapters) | `layered-v1` (controller → service → repository) | `vertical-v1` (vertical slices) |
|---|---|---|---|
| Fits | Clean / onion architecture: handlers delegate to an application layer, the domain is pure, persistence sits behind a port interface | Classic MVC and service-layer apps: Spring Boot, ASP.NET MVC, Rails, Django, Express + service classes | Feature folders where each request handler owns its slice end to end: minimal APIs, MediatR-style handlers with their own `DbContext`, Next server actions |
| HTTP handler writes the store itself | **violation** `controller-persists` | **violation** `controller-persists` | allowed — the slice owns its store |
| HTTP handler reads the store itself | allowed | warning `controller-reads` — reads go through the service layer too | allowed |
| HTTP handler calls out over HTTP itself | warning `controller-calls-out` (skips the application layer) | warning `controller-calls-out` (skips the service layer) | warning `controller-calls-out` (the slice should wrap outbound calls in its own adapter) |
| Domain model / domain service writes a store, calls out, or touches the file system | **violation** `domain-does-io` | **violation** `domain-does-io` (the model layer must stay pure) | **violation** `domain-does-io` (the slice's domain must stay pure) |
| Application service / use case writes the ORM directly (a concrete `DbContext`, `PrismaClient`, session) | warning `service-writes-orm` — go through a port or repository | allowed — the service layer owns the ORM | allowed |
| Repository / persistence adapter talks to the network | warning `repository-calls-out` | warning `repository-calls-out` | warning `repository-calls-out` |
| View / UI code writes the store | **violation** `view-persists` | **violation** `view-persists` | **violation** `view-persists` |

`vertical-v1` needs an Architecture module published after the pack landed;
an older installed module refuses the id, so the build judges the map under
`hexagonal-v1` and stamps that — the `policy` line always names what was
actually evaluated. `vg update` brings the module to the current version.

"Writes the store itself" means the handler's own body calls a repository, a
DbContext or session, an ORM model, or a SQL write — or calls into a class
whose name says it is the store layer. Delegating to an application service,
a command handler or a MediatR-style `Send` is the intended path and is never
a crossing, even when that callee persists. Writing through an interface such
as `IApplicationDbContext` from an application service is a port, not a
violation, under either pack.

## Your own rules: overlays

A pack is a starting point. Overlays are your rules on top of it, written in
the same file as `[[overlay]]` tables. An overlay attaches to what the module
discovered about a symbol — its role and its purposes — under an optional path
prefix, not to a folder you drew, so a handler that moves between folders is
still a handler.

```toml
# .vibgrate/architecture.toml
schema = "vg.arch.policy.v1"
policy = "hexagonal-v1"

# Deny: add a finding wherever a symbol under `path` has this role and purpose.
[[overlay]]
id = "team/handlers-may-not-persist"
path = "src/"
when.role = "controller"
when.purpose = "persist"
action = "deny"
severity = "hard"
message = "handlers hand writes to the service layer"

# Allow: drop a baked rule for the symbols under `path`.
[[overlay]]
id = "org/legacy-catalog-may-persist"
path = "src/Legacy/"
rule = "controller-persists"
action = "allow"

# Remap: keep a baked rule but change its severity.
[[overlay]]
id = "team/calls-out-is-a-violation"
rule = "hexagonal-v1/controller-calls-out"
action = "remap"
severity = "hard"
```

| Key | Meaning |
|---|---|
| `id` | Required. `team/<name>` or `org/<name>`, lower-case letters, digits and dashes; unique in the file. A `deny` finding carries this id as its rule, so `vg show`, `vg scan` and the VS Code view name your rule the way they name a baked one |
| `path` | Optional repo-relative prefix (`src/`, `src/Legacy/OrdersController.cs`). No path means the whole repository |
| `when.role` / `when.purpose` | One of the module's 20 roles / 26 purposes. `deny` needs at least one; `allow` and `remap` may narrow by role |
| `action` | `deny` adds a finding; `allow` drops the baked `rule` on the matched symbols; `remap` changes the baked `rule`'s severity |
| `rule` | For `allow` and `remap`: a baked rule by name (`controller-persists`, whatever the pack) or full id (`hexagonal-v1/controller-persists`) |
| `severity` | `hard` or `warn`. `deny` defaults to `hard`; `remap` requires it; `allow` takes none |
| `message` | Optional finding text for `deny` |

Overlays never change a role or a purpose; they only add, drop or re-grade
findings. `vg show <symbol>` prints the pack and the overlay ids on one line
(`policy hexagonal-v1 + team/handlers-may-not-persist`), and the classify file
stamps them as `overlays`. A `deny` with `severity = "hard"` fails
`vg scan --fail-on architecture-finding` exactly like a baked violation.

An overlay that does not validate — an id without the prefix, an unknown role,
a `deny` with nothing to match, a `remap` without a severity, a key the schema
does not know — **fails the architecture step loudly**: `vg build` exits with
every problem listed and writes no classify file, `vg scan` prints the same
list and its architecture gate then reports the map as not classified. The
baked `policy` key keeps its quieter contract (an unknown pack id warns and
falls back), because a typo in one word must never turn a build red; a rule
you wrote and the tool silently ignored would be worse.

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
- One pack applies to the whole repository. A per-path pack map is not
  shipped; overlays with a `path` cover the cases where one folder follows
  different rules.
- They judge duties reconstructed from source text and the code map. An
  untyped call the map could not resolve is not evidence, so a store call on a
  receiver nothing declares does not produce a finding; it also does not
  suppress one that a typed call in the same body produces.
