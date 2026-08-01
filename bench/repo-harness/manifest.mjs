/**
 * Real-repository manifest for the ask relevance harness (run.mjs).
 *
 * Two source kinds:
 *  - `local`      — a repo embedded in this monorepo (test-solutions/*). Always
 *                   runnable, including in network-restricted CI. These are the
 *                   default harness targets.
 *  - `github-tag` — a pinned OSS release downloaded as a tarball from
 *                   codeload.github.com and cached under .cache/ (gitignored).
 *                   `sha256` pins the artifact after first fetch; the fetcher
 *                   refuses a mismatch. Only runs where the network policy
 *                   allows github.com — the runner SKIPS (not fails) these when
 *                   the download is unreachable.
 *
 * Every entry with a `questions` file participates in `pnpm bench:repos`.
 * Question files follow the ask-corpus entry schema and MUST be authored via
 * the verified loop in AUTHORING.md — never commit expectations that have not
 * been checked against a locally built graph.
 */

export const REPOS = [
  // ---- embedded fixtures (always runnable) ----
  {
    slug: 'calcom',
    source: { type: 'local', dir: '../../../../test-solutions/calcom' },
    note: 'Cal.com-shaped pnpm monorepo — scheduling SaaS (web-saas category)',
    questions: 'questions/calcom.json',
  },
  {
    slug: 'eshoponcontainers',
    source: { type: 'local', dir: '../../../../test-solutions/eshoponcontainers' },
    note: '.NET microservices e-commerce (fintech-payments / ecommerce categories)',
    questions: 'questions/eshoponcontainers.json',
  },
  // ---- pinned OSS downloads (network-permitting environments) ----
  // Add entries with verified sha256 after first authoring run, e.g.:
  // {
  //   slug: 'express',
  //   source: { type: 'github-tag', owner: 'expressjs', repo: 'express', tag: '4.19.2', sha256: '<fill-on-first-fetch>' },
  //   questions: 'questions/express.json',
  // },
];
