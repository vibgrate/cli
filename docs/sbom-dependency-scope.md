# Production, development, and optional dependencies in `vg sbom export`

`vg sbom export` writes a [CycloneDX](https://cyclonedx.org/docs/1.5/json/) 1.5 or [SPDX](https://spdx.github.io/spdx-spec/v2.3/) 2.3 document from a scan artifact and a lockfile. The value it calls scope answers one question: did a scanned manifest declare this exact name and version (`direct`), or does the version appear only in a lockfile (`transitive`)?

Production, development, and optional are a second signal. The scan records the manifest section on each direct row (`dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`). Export keeps `vibgrate:scope` and the SPDX `scope=` annotation as `direct` or `transitive`, and writes the section as the CycloneDX component `scope` and, when a graph is written, as the SPDX relationship type.

```bash
vg
vg sbom export --format cyclonedx --out sbom.cdx.json
vg sbom export --format spdx --out sbom.spdx.json
```

`vg sbom export` reads `.vibgrate/scan_result.json` unless you pass `--in`, and reads the lockfile under `--root` (the current directory by default).

## Fields that are written

| | CycloneDX 1.5 | SPDX 2.3 |
| --- | --- | --- |
| Direct vs lockfile-only | `properties[]` entry `vibgrate:scope`, value `direct` or `transitive` | Package annotation comment, `scope=direct` or `scope=transitive` |
| Component `scope` (`required`, `optional`, `excluded`) | `required` for section `dependencies`, `optional` for `optionalDependencies`, `excluded` for `devDependencies`. Omitted for `peerDependencies` and for a lockfile-only row. | — |
| Relationship kind | `dependencies[].dependsOn` lists child `bom-ref` values and has no kind. A development dependency stays out of the root `dependsOn`. | `DEPENDS_ON` for a production edge, a peer edge, and every child edge. `DEV_DEPENDENCY_OF` for a direct `devDependencies` row when a graph is written. `OPTIONAL_DEPENDENCY_OF` for an `optionalDependencies` row the lockfile resolved into the root edge list. |
| Build, test, runtime, and provided relationships | — | `BUILD_DEPENDENCY_OF`, `TEST_DEPENDENCY_OF`, `RUNTIME_DEPENDENCY_OF`, and `PROVIDED_DEPENDENCY_OF` are omitted |

`DEV_DEPENDENCY_OF` and `OPTIONAL_DEPENDENCY_OF` follow the SPDX 2.3 direction. The package is `spdxElementId` and `SPDXRef-DOCUMENT` is `relatedSpdxElementId`: that package is a development or optional dependency of the document. `DEPENDS_ON` still runs from `SPDXRef-DOCUMENT` to the package.

Document relationships for the lockfile root edge list come first, in that list's sorted order. Direct `devDependencies` that list left out come next, in component order. Child `DEPENDS_ON` edges follow, in component order, with each package's children sorted.

The other properties on every CycloneDX component are `vibgrate:project`, `vibgrate:projects`, `vibgrate:currentSpec`, `vibgrate:drift`, and `vibgrate:majorsBehind`. `vibgrate:projects` is every project that contributed that ecosystem, name, and version, sorted and joined with a comma and a space. SPDX folds the same facts into that one annotation comment (`project=` and `projects=`). A `vibgrate:mergeWarning` property is added only when the merge dropped a fact or assumed an ecosystem. Those properties do not repeat the manifest section. The section is the CycloneDX `scope` member and the SPDX relationship type.

When the lockfile reader has no resolved edges, the CycloneDX `dependencies` member is omitted and the SPDX `relationships` member is omitted. An empty array is not written in their place. CycloneDX `scope` is still set from the section on a direct row. Without a graph, SPDX has no `DEV_DEPENDENCY_OF` or `OPTIONAL_DEPENDENCY_OF` row.

The export tries these files in order and uses the first one that yields a component list: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`. A present file that is truncated or invalid fails the export. `composer.lock` is not in that list.

## Mapping

A row that survives into the scan artifact becomes `direct`. A name and version that exists only in the lockfile component list becomes `transitive`. Export reads the section on the winning direct row. A later project that declares the same identity with a different section keeps the first project's section, and `vibgrate:mergeWarning` records the drop.

CycloneDX 1.5 says a consumer should assume `required` when `scope` is absent. Export writes `required` on a `dependencies` row so that row is distinct from a peer and from a lockfile-only component, both of which omit `scope`. `optionalDependencies` is `optional`. `devDependencies` is `excluded`: that value documents a component kept in the inventory that is not part of the distributed runtime artifact, which is the spec's case for a development dependency. The component stays in `components`. `vibgrate:scope` stays `direct`. The root `dependsOn` list has no kind, so development packages stay out of it. `peerDependencies` omit `scope`. A peer is not required, optional, or excluded, and CycloneDX has no peer value.

| Signal on disk | What the scan keeps | CycloneDX | SPDX |
| --- | --- | --- | --- |
| npm `package.json` `dependencies` | Section `dependencies`. Exported. | `vibgrate:scope` = `direct`. Component `scope` = `required`. Included in the root `dependsOn` when `package-lock.json` v2/v3 resolves an install path. | Annotation `scope=direct`. `DEPENDS_ON` from `SPDXRef-DOCUMENT` when that install path resolves. |
| npm `package.json` `devDependencies` | Section `devDependencies`. Exported. | `vibgrate:scope` = `direct`. Component `scope` = `excluded`. Omitted from the root `dependsOn`. A `devDependency` can still have its own `dependsOn` children. | Annotation `scope=direct`. `DEV_DEPENDENCY_OF` from that package to `SPDXRef-DOCUMENT` when a graph is written, including when the spec did not resolve. An edge from that package to a child is still `DEPENDS_ON`. |
| npm `package.json` `optionalDependencies` | Section `optionalDependencies`. Exported. | `vibgrate:scope` = `direct`. Component `scope` = `optional`. Included in the root `dependsOn` when the lockfile has an install path. | Annotation `scope=direct`. `OPTIONAL_DEPENDENCY_OF` from that package to `SPDXRef-DOCUMENT` when the install path resolves. No relationship when it does not. |
| npm `package.json` `peerDependencies` | Section `peerDependencies`. Exported. | `vibgrate:scope` = `direct`. Component `scope` omitted. In the root `dependsOn` only when an install path resolves. | Annotation `scope=direct`. `DEPENDS_ON` from the document only when an install path resolves. `PROVIDED_DEPENDENCY_OF` omitted. |
| npm range declared in `optionalDependencies` or `peerDependencies`, with no lockfile install | Row kept. `resolvedVersion` is null. Export version is `unknown` because the spec contains `^`. | `vibgrate:scope` = `direct`. Component `scope` is `optional` for an optional row and omitted for a peer. `version` is `unknown`. `purl` has no `@version`. Absent from root `dependsOn`. | Annotation `scope=direct`. `versionInfo` is `unknown`. No `OPTIONAL_DEPENDENCY_OF` and no `DEPENDS_ON` from the document. |
| `package-lock.json` v2/v3 entry flags `dev`, `optional`, `devOptional` | Not read. | The package is `direct` with the section's `scope` when the manifest declared that version, otherwise `transitive` with `scope` omitted. The flags do not set `scope`. | Same. The flags do not change `scope=` or `relationshipType`. |
| `package-lock.json` v2/v3 root `devDependencies` | Used by the scan only through `package.json`. | Left out of the root `dependsOn`. The packages stay in `components` with `scope` `excluded` when the manifest section is `devDependencies`. | `DEV_DEPENDENCY_OF` from that package to `SPDXRef-DOCUMENT` when a graph is written. The manifest section creates that relationship. The lockfile flag does not. |
| `package-lock.json` v1 `dependencies` tree, including a `dev` or `optional` flag on an entry | Versions are read. Flags are not. | Components only. `dependencies` omitted. A direct row still has component `scope` from its manifest section. | `relationships` omitted, so there is no `DEV_DEPENDENCY_OF` or `OPTIONAL_DEPENDENCY_OF`. |
| pnpm `package.json` sections (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`) | Same four sections as npm. Exported. | Every surviving row is `vibgrate:scope` = `direct`, with component `scope` from the section (`required`, `optional`, `excluded`, or omitted for a peer). | Annotation `scope=direct`. `relationships` omitted, so the SPDX kind is not written. |
| `pnpm-lock.yaml` importer `dependencies` / `devDependencies` / `optionalDependencies` | The scan's version index reads these three to pin a direct dependency. It does not read importer `peerDependencies`. | The SBOM graph ignores the importer blocks. `dependencies` omitted. Component `scope` still comes from the manifest section. | `relationships` omitted. |
| `pnpm-lock.yaml` `packages:` header, including `dev: true` or `optional: true` | Name and version only. Flags not read. | `direct` with the section's `scope` when the manifest declared that version, otherwise `transitive` with `scope` omitted. | Same. `relationships` omitted. |
| `yarn.lock` block, including an `optional` line and a `dependencies:` list under an entry | Name and version only. | `direct` or `transitive` as above. Component `scope` follows the manifest section on a direct row. `dependencies` omitted. The `optional` line is ignored. | `relationships` omitted. |
| `Cargo.toml` `[dependencies]`, including `optional = true` | `optional = true` is parsed, then dropped. The row is stored as section `dependencies`. | `vibgrate:scope` = `direct`. Component `scope` = `required`. The dropped `optional = true` does not become `optional`. `dependencies` omitted. | Annotation `scope=direct`. `relationships` omitted. |
| `Cargo.toml` `[dev-dependencies]` | Parsed, then removed before the scan artifact is built. | Not a direct row. If `Cargo.lock` lists the crate, `vibgrate:scope` = `transitive` and component `scope` is omitted. | Annotation `scope=transitive` when the lockfile lists it. Absent when the lockfile does not. |
| `Cargo.toml` `[build-dependencies]` | Not parsed. | Same as a dev-dependency: `transitive` when `Cargo.lock` lists the crate, otherwise absent. Component `scope` omitted. | Same. |
| `Cargo.lock` `[[package]]`, including the root package and a `dependencies = [...]` list | Name and version only. The dependency list is not read. | Every locked crate is a component, including the root package, as `transitive` unless the scan already declared that version. Component `scope` follows the manifest section on a declared version and is omitted on a lockfile-only crate. `dependencies` omitted. | `relationships` omitted. |
| `composer.json` `require` | Section `dependencies`. Exported. | `vibgrate:scope` = `direct`. Component `scope` = `required`. `dependencies` omitted. | Annotation `scope=direct`. `relationships` omitted. |
| `composer.json` `require-dev` | Parsed, then removed before the scan artifact is built. | Absent. `composer.lock` `packages-dev` is not expanded into components. | Absent. |
| `composer.lock` `packages` (a production package the manifest did not declare) | Not expanded into SBOM components. | Absent. | Absent. |
| `pyproject.toml` `[project] dependencies` and `[tool.poetry.dependencies]` | Stored as section `dependencies`. The `python` key is skipped. | `vibgrate:scope` = `direct`. Component `scope` = `required`. `dependencies` omitted. | Annotation `scope=direct`. `relationships` omitted. |
| `pyproject.toml` `[project.optional-dependencies]`, `[dependency-groups]`, `[tool.poetry.group.dev.dependencies]` | Not parsed. | Absent, unless `poetry.lock` lists the package, in which case `vibgrate:scope` = `transitive` and component `scope` is omitted. | Same. |
| `poetry.lock` `category` (`main` or `dev`) | Not read. Name and version only. `uv.lock` uses the same collector. | `direct` with the section's `scope` when a parsed manifest row has that version, otherwise `transitive` with `scope` omitted. A `category = "dev"` package is `transitive`. | Annotation `scope=direct` or `scope=transitive`. `relationships` omitted. |

`--no-transitive` keeps the manifest rows (development, optional, and peer included) and omits lockfile-only rows. It also omits CycloneDX `dependencies` and SPDX `relationships`. CycloneDX `scope` on the kept rows still follows the section. SPDX does not write `DEV_DEPENDENCY_OF` or `OPTIONAL_DEPENDENCY_OF`, because the graph is omitted.

## Example tree

This fixture is a `package.json` plus a `package-lock.json` at lockfileVersion 3. There is no `node_modules` directory. The commands were `vg scan --offline --no-graph` and `vg sbom export`. Offline scan leaves `vibgrate:drift` and `vibgrate:majorsBehind` as `unknown`; those two values are not dependency kind.

```text
scope-fixture
├── dependencies
│   └── left-pad@1.3.0
│       └── nested-prod@1.0.0          lockfile only
├── devDependencies
│   └── typescript@5.4.5                lockfile flag dev: true
│       └── nested-dev@1.0.0            lockfile flag dev: true
├── optionalDependencies
│   └── fsevents@2.3.3                  lockfile flag optional: true
└── (not in package.json)
    └── dev-optional-pkg@1.2.3          lockfile flags dev, optional, and devOptional
```

Component order is the Package URL, then the version. Every row in this tree has a purl, so the names sort alphabetically and then by version. CycloneDX `dependencies` still starts with `vibgrate-root`.

| Package | `vibgrate:scope` | CycloneDX component `scope` | Root `dependsOn` | SPDX annotation | SPDX relationship |
| --- | --- | --- | --- | --- | --- |
| `dev-optional-pkg@1.2.3` | `transitive` | omitted | no | `scope=transitive` on `SPDXRef-Package-1` | none |
| `fsevents@2.3.3` | `direct` | `optional` | yes (`pkg:npm/fsevents@2.3.3`) | `scope=direct` on `SPDXRef-Package-2` | `SPDXRef-Package-2` `OPTIONAL_DEPENDENCY_OF` `SPDXRef-DOCUMENT` |
| `left-pad@1.3.0` | `direct` | `required` | yes | `scope=direct` on `SPDXRef-Package-3` | `SPDXRef-DOCUMENT` `DEPENDS_ON` `SPDXRef-Package-3`. This package `DEPENDS_ON` `SPDXRef-Package-5` (`nested-prod`) |
| `nested-dev@1.0.0` | `transitive` | omitted | no | `scope=transitive` on `SPDXRef-Package-4` | target of `typescript` only |
| `nested-prod@1.0.0` | `transitive` | omitted | no | `scope=transitive` on `SPDXRef-Package-5` | target of `left-pad` only |
| `typescript@5.4.5` | `direct` | `excluded` | no | `scope=direct` on `SPDXRef-Package-6` | `SPDXRef-Package-6` `DEV_DEPENDENCY_OF` `SPDXRef-DOCUMENT`. This package `DEPENDS_ON` `SPDXRef-Package-4` (`nested-dev`) |

Relationship order in that SPDX document is: `fsevents` `OPTIONAL_DEPENDENCY_OF` the document, the document `DEPENDS_ON` `left-pad`, `typescript` `DEV_DEPENDENCY_OF` the document, `left-pad` `DEPENDS_ON` `nested-prod`, `typescript` `DEPENDS_ON` `nested-dev`.

A CycloneDX component for `typescript` has `type`, `bom-ref`, `name`, `version`, `scope`, `purl`, and `properties`. `scope` is `excluded`. `properties` includes `vibgrate:scope` = `direct`. The root `dependencies` entry (`bom-ref` `vibgrate-root`) lists `fsevents` and `left-pad`. `typescript` has its own `dependsOn` entry pointing at `nested-dev`. `fsevents` has `scope` `optional`. `left-pad` has `scope` `required`. `dev-optional-pkg`, `nested-dev`, and `nested-prod` omit `scope`.

On a direct row, `vibgrate:project` is the `package.json` name (`scope-fixture`). On a lockfile-only row it is the scanned project whose lockfile supplied the kept row. In a single-project scan that is the same package name. `vibgrate:projects` lists every contributing project. It is not the scan root's directory name.

When the root `package.json` has no `name`, that project name is the directory's last segment instead. When it has no `version`, `repository.version` and the CycloneDX metadata component omit version. `vg sbom export` still writes the dependency rows and prints one `VG_WARN_ROOT_PACKAGE_IDENTITY` warning. The rule is in [DOCS.md](../DOCS.md#root-packagejson-without-a-name-or-version).

The same manifest with a `pnpm-lock.yaml` or a `yarn.lock` writes the same `direct` / `transitive` split for packages the manifest declared, and writes `nested-prod` as `transitive`. CycloneDX `scope` is still `required` for `left-pad`, `excluded` for `typescript`, and `optional` for `fsevents`. Both formats omit `dependencies` and `relationships`, so nothing records that `left-pad` depends on `nested-prod`, and SPDX does not record `DEV_DEPENDENCY_OF` or `OPTIONAL_DEPENDENCY_OF`.

A Cargo tree with `[dependencies] serde`, `[dependencies] optional-crate` (`optional = true`), `[dev-dependencies] criterion`, and `[build-dependencies] cc` exports `serde` and `optional-crate` as `direct` with component `scope` `required`. `optional = true` is dropped before the scan artifact, so it does not become `optional`. `criterion`, `cc`, and the root package entry from `Cargo.lock` are `transitive` with component `scope` omitted. `dependencies` and `relationships` are omitted.

## Gaps

1. CycloneDX `scope` is `required`, `optional`, or `excluded` for a direct `dependencies`, `optionalDependencies`, or `devDependencies` row. It is omitted for `peerDependencies` and for every lockfile-only component. A consumer that follows the spec default treats a missing `scope` as `required`, so a peer and a transitive package can look required.
2. SPDX writes `DEV_DEPENDENCY_OF` and `OPTIONAL_DEPENDENCY_OF` for the direct edges in the table above, and only when a graph is written. `BUILD_DEPENDENCY_OF`, `TEST_DEPENDENCY_OF`, `RUNTIME_DEPENDENCY_OF`, and `PROVIDED_DEPENDENCY_OF` are omitted. A peer edge stays `DEPENDS_ON`. An optional row with no resolved install path has no SPDX relationship. Child edges stay `DEPENDS_ON`.
3. `vibgrate:scope` and the SPDX `scope=` annotation stay `direct` or `transitive`. They do not carry the manifest section. A production library and a development library that the manifest declared are both `direct`.
4. npm `devDependencies` stay in the component list as `direct` with CycloneDX `scope` `excluded`, and they stay out of the CycloneDX root `dependsOn`. SPDX records `DEV_DEPENDENCY_OF` from that package to the document when a graph is written. Their child edges are still `DEPENDS_ON`.
5. Lockfile flags are ignored: npm `dev`, `optional`, and `devOptional`; pnpm `dev:` and `optional:`; yarn `optional`; Cargo `optional = true`; Poetry `category`. None of those flags set component `scope` or `relationshipType`. The manifest section does, when the scan kept one.
6. pnpm and yarn graphs are omitted. Importer dependency kind in `pnpm-lock.yaml` is ignored by the SBOM reader. A transitive dependency of a development package is `transitive`, with no edge back to that development package. CycloneDX `scope` on a direct row is still set. SPDX relationship kinds are absent with the graph.
7. The scan's pnpm version index does not read importer `peerDependencies`. A peer whose spec is one concrete version is still exported at that spec, as `direct`, with component `scope` omitted, when the index has no pin.
8. Cargo `[dev-dependencies]` and `[build-dependencies]` are not direct rows. When `Cargo.lock` lists them they are `transitive` with component `scope` omitted. The root `[[package]]` is a component too. When the lockfile does not list a dev or build crate, that crate is absent.
9. PHP `require-dev` is absent, including packages under `composer.lock` `packages-dev`. A production package that appears only under `composer.lock` `packages` is also absent. The export does not expand `composer.lock`.
10. Poetry optional extras (`[project.optional-dependencies]`), `[dependency-groups]`, and `[tool.poetry.group.dev.dependencies]` are not manifest rows. `poetry.lock` `category = "dev"` becomes `transitive` with component `scope` omitted. A dev package in the manifest group and missing from the lockfile is absent.
11. `--no-transitive` removes lockfile-only packages and the graph. Development, optional, and peer packages that the manifest declared remain, marked `direct`, with CycloneDX `scope` from the section. SPDX relationships are omitted with the graph.
