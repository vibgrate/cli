# Release notes

One markdown file per released version, `v<version>.md` (calendar versions,
`YYYY.MDD.N`). Each file is the body of the GitHub Release for that version —
the Release workflow uses `releases/v<version>.md` as `--notes-file` when it
exists, and falls back to auto-generated notes when it does not.

These files are generated at sync time by the monorepo's release pipeline:
the prose is drawn from the curated changesets for the release, and the
benchmark numbers are rendered verbatim from that release's two-arm benchmark
report (full reports at <https://vibgrate.com/cli/benchmarks>). They are
reviewed as part of the "Sync from monorepo" PR before anything is published.

This folder is append-only: syncs add the new release's file and never remove
earlier ones.
