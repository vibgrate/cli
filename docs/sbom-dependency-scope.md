# Production, development, and optional dependencies in `vg sbom export`

`vg sbom export` writes a [CycloneDX](https://cyclonedx.org/docs/1.5/json/) 1.5 or [SPDX](https://spdx.github.io/spdx-spec/v2.3/) 2.3 document from a scan artifact and a lockfile. The value it calls scope answers one question: did a scanned manifest declare this exact name and version (`direct`), or does the version appear only in a lockfile (`transitive`)?

Production, development, and optional are separate signals. The export keeps some of them as ordinary components, drops others, and omits the CycloneDX and SPDX fields those specs use for dependency kind. This page maps each signal to the field that is written, then lists the gaps. The behavior below is what the current CLI writes. The emitters are unchanged.

```bash
vg
vg sbom export --format cyclonedx --out sbom.cdx.json
vg sbom export --format spdx --out sbom.spdx.json
```

`vg sbom export` reads `.vibgrate/scan_result.json` unless you pass `--in`, and reads the lockfile under `--root` (the current directory by default).

## Fields that are written

Every component carries the same property list. Dependency kind is not one of the names.

| | CycloneDX 1.5 | SPDX 2.3 |
| --- | --- | --- |
| Direct vs lockfile-only | `properties[]` entry `vibgrate:scope`, value `direct` or `transitive` | Package annotation comment, `scope=direct` or `scope=transitive` |
| CycloneDX component `scope` (`required`, `optional`, `excluded`) | Omitted on every component | — |
| Relationship kind | `dependencies[].dependsOn` lists child `bom-ref` values, with no kind on the edge | `relationships[].relationshipType` is `DEPENDS_ON` when a graph is written |
| Development / optional / build / test / runtime relationship | Not written | `DEV_DEPENDENCY_OF`, `OPTIONAL_DEPENDENCY_OF`, `BUILD_DEPENDENCY_OF`, `TEST_DEPENDENCY_OF`, and `RUNTIME_DEPENDENCY_OF` are omitted |

The other properties on every CycloneDX component are `vibgrate:project`, `vibgrate:projects`, `vibgrate:currentSpec`, `vibgrate:drift`, and `vibgrate:majorsBehind`. `vibgrate:projects` is every project that contributed that ecosystem, name, and version, sorted and joined with a comma and a space. SPDX folds the same facts into that one annotation comment (`project=` and `projects=`). A `vibgrate:mergeWarning` property is added only when the merge dropped a fact or assumed an ecosystem. None of them stores the manifest section.

When the lockfile reader has no resolved edges, the CycloneDX `dependencies` member is omitted and the SPDX `relationships` member is omitted. An empty array is not written in their place.

The export tries these files in order and uses the first one that yields a component list: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`. A present file that is truncated or invalid fails the export. `composer.lock` is not in that list.

## Mapping

The scan records a manifest section on each direct row (`dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`). Export does not read that section. A row that survives into the scan artifact becomes `direct`. A name and version that exists only in the lockfile component list becomes `transitive`.

| Signal on disk | What the scan keeps | CycloneDX | SPDX |
| --- | --- | --- | --- |
| npm `package.json` `dependencies` | Section `dependencies`. Exported. | `vibgrate:scope` = `direct`. Included in the root `dependsOn` when `package-lock.json` v2/v3 resolves an install path. Component `scope` omitted. | Annotation `scope=direct`. `DEPENDS_ON` from `SPDXRef-DOCUMENT` when that install path resolves. |
| npm `package.json` `devDependencies` | Section `devDependencies`. Exported. | `vibgrate:scope` = `direct`. Omitted from the root `dependsOn`. A `devDependency` can still have its own `dependsOn` children. Component `scope` omitted. | Annotation `scope=direct`. No `DEPENDS_ON` from `SPDXRef-DOCUMENT`. An edge from that package to a child is still `DEPENDS_ON`. |
| npm `package.json` `optionalDependencies` | Section `optionalDependencies`. Exported. | `vibgrate:scope` = `direct`. Included in the root `dependsOn` when the lockfile has an install path. Component `scope` omitted (never `optional`). | Annotation `scope=direct`. `DEPENDS_ON` from the document when the install path resolves. `OPTIONAL_DEPENDENCY_OF` omitted. |
| npm `package.json` `peerDependencies` | Section `peerDependencies`. Exported. | Same as optional: `direct`, and in the root `dependsOn` only when an install path resolves. No peer marker. | Annotation `scope=direct`. `DEPENDS_ON` from the document only when an install path resolves. |
| npm range declared in `optionalDependencies` or `peerDependencies`, with no lockfile install | Row kept. `resolvedVersion` is null. Export version is `unknown` because the spec contains `^`. | `vibgrate:scope` = `direct`. `version` is `unknown`. `purl` has no `@version`. Absent from root `dependsOn`. | Annotation `scope=direct`. `versionInfo` is `unknown`. No `DEPENDS_ON` from the document. |
| `package-lock.json` v2/v3 entry flags `dev`, `optional`, `devOptional` | Not read. | No field. The package is `direct` when the manifest declared that version, otherwise `transitive`. | Same. The flags do not change `scope=` or `relationshipType`. |
| `package-lock.json` v2/v3 root `devDependencies` | Used by the scan only through `package.json`. | Left out of the root `dependsOn`. The packages stay in `components` when they are installed. | Left out of `DEPENDS_ON` from `SPDXRef-DOCUMENT`. |
| `package-lock.json` v1 `dependencies` tree, including a `dev` or `optional` flag on an entry | Versions are read. Flags are not. | Components only. `dependencies` omitted. | `relationships` omitted. |
| pnpm `package.json` sections (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`) | Same four sections as npm. Exported. | Every surviving row is `vibgrate:scope` = `direct`. Component `scope` omitted. | Annotation `scope=direct`. |
| `pnpm-lock.yaml` importer `dependencies` / `devDependencies` / `optionalDependencies` | The scan's version index reads these three to pin a direct dependency. It does not read importer `peerDependencies`. | The SBOM graph ignores the importer blocks. `dependencies` omitted. | `relationships` omitted. |
| `pnpm-lock.yaml` `packages:` header, including `dev: true` or `optional: true` | Name and version only. Flags not read. | `direct` when the manifest declared that version, otherwise `transitive`. | Same. |
| `yarn.lock` block, including an `optional` line and a `dependencies:` list under an entry | Name and version only. | `direct` or `transitive` as above. `dependencies` omitted. The `optional` line is ignored. | `relationships` omitted. |
| `Cargo.toml` `[dependencies]`, including `optional = true` | `optional = true` is parsed, then dropped. The row is stored as section `dependencies`. | `vibgrate:scope` = `direct`. Component `scope` omitted. `dependencies` omitted. | Annotation `scope=direct`. `relationships` omitted. |
| `Cargo.toml` `[dev-dependencies]` | Parsed, then removed before the scan artifact is built. | Not a direct row. If `Cargo.lock` lists the crate, `vibgrate:scope` = `transitive`. | Annotation `scope=transitive` when the lockfile lists it. Absent when the lockfile does not. |
| `Cargo.toml` `[build-dependencies]` | Not parsed. | Same as a dev-dependency: `transitive` when `Cargo.lock` lists the crate, otherwise absent. | Same. |
| `Cargo.lock` `[[package]]`, including the root package and a `dependencies = [...]` list | Name and version only. The dependency list is not read. | Every locked crate is a component, including the root package, as `transitive` unless the scan already declared that version. `dependencies` omitted. | `relationships` omitted. |
| `composer.json` `require` | Section `dependencies`. Exported. | `vibgrate:scope` = `direct`. `dependencies` omitted. | Annotation `scope=direct`. `relationships` omitted. |
| `composer.json` `require-dev` | Parsed, then removed before the scan artifact is built. | Absent. `composer.lock` `packages-dev` is not expanded into components. | Absent. |
| `composer.lock` `packages` (a production package the manifest did not declare) | Not expanded into SBOM components. | Absent. | Absent. |
| `pyproject.toml` `[project] dependencies` and `[tool.poetry.dependencies]` | Stored as section `dependencies`. The `python` key is skipped. | `vibgrate:scope` = `direct`. `dependencies` omitted. | Annotation `scope=direct`. `relationships` omitted. |
| `pyproject.toml` `[project.optional-dependencies]`, `[dependency-groups]`, `[tool.poetry.group.dev.dependencies]` | Not parsed. | Absent, unless `poetry.lock` lists the package, in which case `vibgrate:scope` = `transitive`. | Same. |
| `poetry.lock` `category` (`main` or `dev`) | Not read. Name and version only. `uv.lock` uses the same collector. | `direct` when a parsed manifest row has that version, otherwise `transitive`. A `category = "dev"` package is `transitive`. | Annotation `scope=direct` or `scope=transitive`. `relationships` omitted. |

`--no-transitive` keeps the manifest rows (development, optional, and peer included) and omits lockfile-only rows. It also omits CycloneDX `dependencies` and SPDX `relationships`.

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
| `fsevents@2.3.3` | `direct` | omitted | yes (`pkg:npm/fsevents@2.3.3`) | `scope=direct` on `SPDXRef-Package-2` | `DEPENDS_ON` from `SPDXRef-DOCUMENT` |
| `left-pad@1.3.0` | `direct` | omitted | yes | `scope=direct` on `SPDXRef-Package-3` | `DEPENDS_ON` from `SPDXRef-DOCUMENT`. This package `DEPENDS_ON` `SPDXRef-Package-5` (`nested-prod`) |
| `nested-dev@1.0.0` | `transitive` | omitted | no | `scope=transitive` on `SPDXRef-Package-4` | target of `typescript` only |
| `nested-prod@1.0.0` | `transitive` | omitted | no | `scope=transitive` on `SPDXRef-Package-5` | target of `left-pad` only |
| `typescript@5.4.5` | `direct` | omitted | no | `scope=direct` on `SPDXRef-Package-6` | No document relationship. This package `DEPENDS_ON` `SPDXRef-Package-4` (`nested-dev`) |

A CycloneDX component for `typescript` has `type`, `bom-ref`, `name`, `version`, `purl`, and `properties`. The component `scope` member is absent. `properties` includes `vibgrate:scope` = `direct`. The root `dependencies` entry (`bom-ref` `vibgrate-root`) lists `fsevents` and `left-pad`. `typescript` has its own `dependsOn` entry pointing at `nested-dev`.

On a direct row, `vibgrate:project` is the `package.json` name (`scope-fixture`). On a lockfile-only row it is the scanned project whose lockfile supplied the kept row. In a single-project scan that is the same package name. `vibgrate:projects` lists every contributing project. It is not the scan root's directory name.

When the root `package.json` has no `name`, that project name is the directory's last segment instead. When it has no `version`, `repository.version` and the CycloneDX metadata component omit version. `vg sbom export` still writes the dependency rows and prints one `VG_WARN_ROOT_PACKAGE_IDENTITY` warning. The rule is in [DOCS.md](../DOCS.md#root-packagejson-without-a-name-or-version).

The same manifest with a `pnpm-lock.yaml` or a `yarn.lock` writes the same `direct` / `transitive` split for packages the manifest declared, and writes `nested-prod` as `transitive`. Both omit `dependencies` and `relationships`, so nothing records that `left-pad` depends on `nested-prod`, and nothing records that `typescript` is a development dependency.

A Cargo tree with `[dependencies] serde`, `[dependencies] optional-crate` (`optional = true`), `[dev-dependencies] criterion`, and `[build-dependencies] cc` exports `serde` and `optional-crate` as `direct`. `criterion`, `cc`, and the root package entry from `Cargo.lock` are `transitive`. `optional = true` does not become a field. `dependencies` and `relationships` are omitted.

## Gaps

1. CycloneDX component `scope` is omitted on every component. The export never writes `required`, `optional`, or `excluded`. An optional dependency and a development dependency look like any other library.
2. SPDX relationship types other than `DEPENDS_ON` are omitted. There is no `DEV_DEPENDENCY_OF`, `OPTIONAL_DEPENDENCY_OF`, `BUILD_DEPENDENCY_OF`, `TEST_DEPENDENCY_OF`, or `RUNTIME_DEPENDENCY_OF`.
3. `vibgrate:scope` and the SPDX `scope=` annotation take `direct` or `transitive`. The manifest section (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`) is dropped before those fields are written.
4. npm `devDependencies` stay in the component list as `direct`, and they are omitted from the root dependency list. Their own child edges are still written, so a development package can appear to depend on other packages while the document does not depend on it.
5. Lockfile flags are ignored: npm `dev`, `optional`, and `devOptional`; pnpm `dev:` and `optional:`; yarn `optional`; Cargo `optional = true`; Poetry `category`.
6. pnpm and yarn graphs are omitted. Importer dependency kind in `pnpm-lock.yaml` is ignored by the SBOM reader. A transitive dependency of a development package is `transitive`, with no edge back to that development package.
7. The scan's pnpm version index does not read importer `peerDependencies`. A peer whose spec is one concrete version is still exported at that spec, as `direct`, when the index has no pin.
8. Cargo `[dev-dependencies]` and `[build-dependencies]` are not direct rows. When `Cargo.lock` lists them they are `transitive`. The root `[[package]]` is a component too. When the lockfile does not list a dev or build crate, that crate is absent.
9. PHP `require-dev` is absent, including packages under `composer.lock` `packages-dev`. A production package that appears only under `composer.lock` `packages` is also absent. The export does not expand `composer.lock`.
10. Poetry optional extras (`[project.optional-dependencies]`), `[dependency-groups]`, and `[tool.poetry.group.dev.dependencies]` are not manifest rows. `poetry.lock` `category = "dev"` becomes `transitive`. A dev package in the manifest group and missing from the lockfile is absent.
11. `--no-transitive` removes lockfile-only packages and the graph. Development, optional, and peer packages that the manifest declared remain, marked `direct`.
