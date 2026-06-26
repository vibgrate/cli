// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { RuntimeCatalog } from './types.js';

/**
 * Bundled Runtime Catalog snapshot — the offline/air-gapped floor and the
 * fallback when the live `/v1/reference/runtimes` lookup is unavailable.
 *
 * This is *generated*, not authored: run `node scripts/refresh-runtimes.mjs`
 * (which hits endoflife.date) to regenerate it on every release so the offline
 * floor never drifts more than a release cycle. The values below are a
 * hand-seeded baseline as of `generatedAt`; the live catalog supersedes them
 * whenever it is reachable.
 */
export const BUNDLED_RUNTIME_CATALOG: RuntimeCatalog = {
  generatedAt: '2026-06-01',
  source: 'endoflife.date',
  products: {
    nodejs: {
      product: 'nodejs',
      cycles: [
        { cycle: '24', releaseDate: '2025-05-06', lts: '2025-10-28', eol: '2028-04-30' },
        { cycle: '23', releaseDate: '2024-10-16', lts: false, eol: '2025-06-01' },
        { cycle: '22', releaseDate: '2024-04-24', lts: '2024-10-29', eol: '2027-04-30' },
        { cycle: '20', releaseDate: '2023-04-18', lts: '2023-10-24', eol: '2026-04-30' },
        { cycle: '18', releaseDate: '2022-04-19', lts: '2022-10-25', eol: '2025-04-30' },
      ],
    },
    python: {
      product: 'python',
      cycles: [
        { cycle: '3.14', releaseDate: '2025-10-07', eol: '2030-10-01' },
        { cycle: '3.13', releaseDate: '2024-10-07', eol: '2029-10-01' },
        { cycle: '3.12', releaseDate: '2023-10-02', eol: '2028-10-01' },
        { cycle: '3.11', releaseDate: '2022-10-24', eol: '2027-10-01' },
        { cycle: '3.10', releaseDate: '2021-10-04', eol: '2026-10-01' },
        { cycle: '3.9', releaseDate: '2020-10-05', eol: '2025-10-01' },
        { cycle: '3.8', releaseDate: '2019-10-14', eol: '2024-10-07' },
      ],
    },
    dotnet: {
      product: 'dotnet',
      cycles: [
        { cycle: '10.0', releaseDate: '2025-11-11', lts: true, eol: '2028-11-10' },
        { cycle: '9.0', releaseDate: '2024-11-12', lts: false, eol: '2026-05-12' },
        { cycle: '8.0', releaseDate: '2023-11-14', lts: true, eol: '2026-11-10' },
        { cycle: '7.0', releaseDate: '2022-11-08', lts: false, eol: '2024-05-14' },
        { cycle: '6.0', releaseDate: '2021-11-08', lts: true, eol: '2024-11-12' },
      ],
    },
    java: {
      product: 'java',
      cycles: [
        { cycle: '25', releaseDate: '2025-09-16', lts: true, eol: '2033-09-01' },
        { cycle: '21', releaseDate: '2023-09-19', lts: true, eol: '2031-09-01' },
        { cycle: '17', releaseDate: '2021-09-14', lts: true, eol: '2029-09-01' },
        { cycle: '11', releaseDate: '2018-09-25', lts: true, eol: '2026-09-01' },
        { cycle: '8', releaseDate: '2014-03-18', lts: true, eol: '2030-12-01' },
      ],
    },
    php: {
      product: 'php',
      cycles: [
        { cycle: '8.4', releaseDate: '2024-11-21', eol: '2028-12-31' },
        { cycle: '8.3', releaseDate: '2023-11-23', eol: '2027-12-31' },
        { cycle: '8.2', releaseDate: '2022-12-08', eol: '2026-12-31' },
        { cycle: '8.1', releaseDate: '2021-11-25', eol: '2025-12-31' },
        { cycle: '8.0', releaseDate: '2020-11-26', eol: '2023-11-26' },
      ],
    },
    ruby: {
      product: 'ruby',
      cycles: [
        { cycle: '3.5', releaseDate: '2025-12-25', eol: '2029-03-31' },
        { cycle: '3.4', releaseDate: '2024-12-25', eol: '2028-03-31' },
        { cycle: '3.3', releaseDate: '2023-12-25', eol: '2027-03-31' },
        { cycle: '3.2', releaseDate: '2022-12-25', eol: '2026-03-31' },
        { cycle: '3.1', releaseDate: '2021-12-25', eol: '2025-03-31' },
      ],
    },
    go: {
      product: 'go',
      cycles: [
        { cycle: '1.25', releaseDate: '2025-08-13', eol: false },
        { cycle: '1.24', releaseDate: '2025-02-11', eol: false },
        { cycle: '1.23', releaseDate: '2024-08-13', eol: true },
        { cycle: '1.22', releaseDate: '2024-02-06', eol: true },
      ],
    },
  },
};
