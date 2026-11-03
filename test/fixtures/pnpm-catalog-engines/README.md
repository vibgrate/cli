# pnpm-catalog-engines

Regression fixture for issue #211: a pnpm v9 `pnpm-lock.yaml` that mixes
`catalogs:` entries (`specifier: 'catalog:'`) with `engines` keys and a
`snapshots:` block. Dependency detection must keep producing a deterministic,
complete package graph instead of aborting on the unexpected runtime keys or
silently dropping packages.

Note: the specifier is YAML-quoted because the strict `yaml` validator in
`src/core-open` (vendored from `vibgrate-core-open`) rejects pnpm's unquoted
`catalog:` plain scalar ("Nested mappings are not allowed in compact
mappings"). A parser-level fix belongs in `vibgrate-core-open`; this fixture
pins the extraction behaviour for the catalog/engines shape today.
