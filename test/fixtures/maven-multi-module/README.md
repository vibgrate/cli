# Maven multi-module fixture

The parent pins two versions in `dependencyManagement`; `app` declares both
dependencies without versions. Dependency order is deliberately nonalphabetical.

The supported `vg build` subset is package identities, manifest paths and direct
dependency coordinates. Its graph has no dependency-version field and does not
resolve parent-managed versions or imported BOMs. The test preserves the child
imports without claiming version resolution, and ensures management-only entries
do not create parent imports. No Maven invocation or registry access is needed.

The test copies only the POMs into two temporary projects in opposite creation
orders, pins the graph timestamp, rebuilds without the incremental cache, and
compares the complete serialized output.
