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

The same facts as `vg show`, `vg path`, and `vg impact`, drawn so a human can walk them.

- **By job** — handlers, guards, services, models (architecture module on)
- **By cluster** — the graph areas
- **Who calls whom** — call edges only
- **Missing steps** — a call exists in source but not on the map
- **Problems** — architecture-rule breaks with a line in this body

Architecture off is the raw graph. Architecture on paints jobs and “writes data / reads data” chips from `graph.arch.json`. No confidence percentages. No taxonomy slugs in the chrome.

Scroll or drag to move around the map. Pinch, Ctrl-scroll, or the + / − buttons to zoom; `0` resets. Arrow keys, Page Up/Down, Home, and End also move the view. Opening a symbol that is off-screen pans it into view.

A rose mark is a finding with `line > 0`. A yellow mark is a missing step. They are not the same thing.

`/api/node/:id` is `vg show --json` plus a `view` block of the English labels.
`/api/path` uses the same shortest-path engine as `vg path`.
`/api/reach/:id` walks callers (`dir=up`) or callees (`dir=down`).

Deep links use `#n=<id>&view=job`. `vg show arch --focus scanDir` opens that hash.

## What this is not

Not a new top-level verb. Not a cloud service. Not a React bundle in the public CLI (the dash Code-graph page can consume the same `/api/*` later). Not a classifier — if the architecture module did not write a sidecar, the map stays honest and graph-only.
