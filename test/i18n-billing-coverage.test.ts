import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SOURCE_EXCLUDE_FILES } from '../src/core-open/utils/fs.js';
import { classifyProject } from '../src/core-open/scanners/project-classification.js';

/**
 * Localisation files must count towards billable project size.
 *
 * Vibgrate is gaining localisation tooling, which means Vibgrate Cloud stores
 * these files — so they have to be inside the metrics that pick a project's
 * billing tier (`fileCount` / `sizeBytes` → `classifyProject`), not outside it.
 *
 * They already are: `sourceMetricsUnder` counts **every** walked file except
 * lockfiles and generated dependency manifests, and no localisation format is
 * excluded by extension. That is easy to break by accident, though — adding
 * `.json` to the walk's skip list, or `locales/` to the skipped directories, or
 * a translation format to {@link SOURCE_EXCLUDE_FILES}, would each silently
 * shrink billed size and give the storage away for free.
 *
 * These tests exist so that break is loud. They assert the *property* (locale
 * files are billable) rather than any particular implementation of it.
 *
 * One deliberate exclusion is pinned at the bottom, and a second is documented
 * there, so a change to either is a conscious pricing decision, not a side effect.
 */

/** Every localisation file format the CLI is expected to recognise. */
const I18N_EXTENSIONS = [
  '.json', // react-i18next, next-intl, vue-i18n, FormatJS
  '.yaml',
  '.yml', // Rails, Symfony, i18next-yaml
  '.arb', // Flutter / Dart application resource bundles
  '.po',
  '.pot', // gettext
  '.xliff',
  '.xlf', // XLIFF interchange (Angular, Symfony)
  '.resx', // .NET resource files
  '.properties', // Java / Spring message bundles
  '.strings', // Apple .strings
  '.stringsdict', // Apple plural rules
  '.ftl', // Mozilla Fluent
  '.toml', // some Rust/Go i18n stacks
  '.ini', // legacy desktop stacks
  '.csv', // translation exports
  '.xml', // Android strings.xml
];

/** Conventional locations translations live in, across ecosystems. */
const I18N_PATHS = [
  'locales/en/common.json',
  'public/locales/fr/app.json',
  'src/i18n/messages.de.json',
  'src/locales/es.yaml',
  'lib/l10n/app_en.arb',
  'translations/messages.pt.po',
  'Resources/Strings.resx',
  'src/main/resources/messages_en.properties',
  'app/src/main/res/values-fr/strings.xml',
  'ios/en.lproj/Localizable.strings',
];

/** Mirror of the walk's binary/media skip list, read from the source of truth. */
function walkSkippedExtensions(): Set<string> {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'core-open', 'utils', 'fs.ts'),
    'utf8',
  );
  const block = /const SKIP_EXTENSIONS = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  if (!block) throw new Error('SKIP_EXTENSIONS not found — update this test to match fs.ts');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

describe('localisation files are billable', () => {
  it('does not skip any localisation format during the walk', () => {
    const skipped = walkSkippedExtensions();
    const wronglySkipped = I18N_EXTENSIONS.filter((ext) => skipped.has(ext));
    expect(
      wronglySkipped,
      `these localisation formats would stop counting towards billable size: ${wronglySkipped.join(', ')}`,
    ).toEqual([]);
  });

  it('does not treat any localisation file as a generated dependency manifest', () => {
    const wronglyExcluded = I18N_PATHS.map((p) => path.basename(p).toLowerCase()).filter((base) =>
      SOURCE_EXCLUDE_FILES.has(base),
    );
    expect(wronglyExcluded).toEqual([]);
  });

  it('counts a translation corpus towards the billing tier', () => {
    // A project that is nano on its source alone, plus a real translation set.
    const sourceOnly = { fileCount: 4, sizeBytes: 40_000, dependencyCount: 3 };
    expect(classifyProject(sourceOnly)).toBe('nano');

    // 24 locale files totalling ~1.4 MB — the shape of a modestly localised app.
    const withTranslations = {
      fileCount: sourceOnly.fileCount + 24,
      sizeBytes: sourceOnly.sizeBytes + 1_400_000,
      dependencyCount: sourceOnly.dependencyCount,
    };
    expect(
      classifyProject(withTranslations),
      'a localised project must not be billed as if it were source-only',
    ).not.toBe('nano');
  });

  /**
   * Pinned exclusions. Neither is a bug — both are deliberate — but both mean
   * translation files that exist on disk are NOT billed, so a change here is a
   * pricing decision and should be made on purpose.
   */
  describe('deliberate exclusions (pricing decisions, not accidents)', () => {
    it('excludes build output, so compiled locale bundles are not double-counted', async () => {
      const { isSkippedDirName } = await import('../src/core-open/utils/fs.js');
      // A locale bundle emitted into dist/ is the same content as its source,
      // already counted where it was authored.
      expect(isSkippedDirName('dist')).toBe(true);
      expect(isSkippedDirName('build')).toBe(true);
      // The authored locations are never skipped.
      expect(isSkippedDirName('locales')).toBe(false);
      expect(isSkippedDirName('i18n')).toBe(false);
      expect(isSkippedDirName('translations')).toBe(false);
    });

    /**
     * NOT covered by a test, deliberately: the walk honours `.gitignore`, so a
     * project whose translations are pulled in at build time
     * (Crowdin/Lokalise/Phrase) and gitignored contributes **nothing** for
     * them — verified by measurement, not asserted here because the behaviour
     * belongs to the walk's ignore handling rather than to billing.
     *
     * If Vibgrate Cloud ends up storing those files, this is the assumption
     * that has to change, and it is a pricing decision.
     */
  });
});
