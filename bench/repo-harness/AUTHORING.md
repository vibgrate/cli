# Authoring a repo question set (agent-assisted, verification-required)

Question files under `questions/<slug>.json` are the ground truth the ask
relevance harness scores against. They are authored with an AI agent (Claude)
doing the exploration, but **no expectation is ever committed unverified** —
the runner is the referee, the agent only drafts.

## The loop

1. **Add the repo to `manifest.mjs`.**
   - Embedded repo (preferred, always CI-runnable): `source: { type: 'local', dir: '../../../../test-solutions/<name>' }`.
   - Pinned OSS release: `source: { type: 'github-tag', owner, repo, tag }`.
     The first fetch prints the artifact's sha256 — copy it into the manifest so
     later runs refuse a tampered or drifted artifact. Network-restricted
     environments skip (never fail) these entries.

2. **Explore what the graph actually contains** — not what the repo's README
   claims:

   ```
   pnpm run bench:repos -- --repo <slug> --dump ""            # all symbols by directory
   pnpm run bench:repos -- --repo <slug> --dump src/payments  # one area
   ```

   If the dump is symbol-poor (only manifests / templated stubs), stop — a
   repo with no real symbols cannot anchor relevance questions. (This is why
   `python-django` from test-solutions is not in the manifest: 6 nodes.)

3. **Draft questions across the standard categories**, aiming for both breadth
   and the known failure modes:
   - `name-usage` / `name-callers` — asks naming a real symbol; `expectFile`
     (or `expectAnyFiles` when the fixture duplicates a symbol across apps).
   - `intent-<area>` — natural-language asks sharing no identifier with the
     target ("where are customer shopping baskets stored and updated?");
     `expectAnyFiles` + `domainDirs` + `minShare` + `firstSeedDomain`.
   - `trap-weak-verbs` — add/create/new/via-dense phrasings of a real topic.
   - `weak-only-must-miss` / `off-topic-must-miss` — asks that must return an
     honest empty seed list. Pick off-topic domains the repo genuinely lacks.
   Entry schema: see `bench/ask-corpus.mjs` header.

4. **Run and reconcile.** `pnpm run bench:repos -- --repo <slug>`. For each
   failure decide honestly which side is wrong:
   - *Expectation too narrow* — the seeds are genuinely relevant code you did
     not anticipate (e.g. the Mobile BFF's `OrderDraftService` for "how are
     orders handled"). Widen `domainDirs`/`expectAnyFiles`.
   - *Ranking defect* — the seeds are surface-form noise. Do NOT weaken the
     expectation. Reduce the failure to a synthetic case in the intent fixture
     (bench/intent-fixture.mjs + ask-corpus.mjs) so the merge-blocking gate
     owns it, then fix the ranker (engine/query.ts / engine/concepts.ts).

5. **Commit only a fully passing file.** The question file + manifest entry +
   (for downloads) the sha256 pin land together.

## Rules

- Expectations describe **what the graph should return**, not what the ranker
  currently returns — reconciliation in step 4 is a judgement call, and "make
  the test pass" is never the criterion by itself.
- Questions must be phrased as a developer would ask them, not as identifier
  soup — identifier asks belong to `name-*` categories only.
- Every file needs at least one `must-miss` probe; honest emptiness is part of
  the contract.
- Category coverage should map back to the app landscape
  (`bench/app-landscape.mjs`) — note in the manifest entry which categories the
  repo exercises.
