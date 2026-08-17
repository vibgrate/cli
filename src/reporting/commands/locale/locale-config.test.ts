/**
 * `vibgrate.locale.yaml` parsing, settings resolution, and path templating.
 *
 * The path template is the one input that decides where `vg locale pull` writes
 * files, so its validation carries real weight: a template that escapes the
 * project root would let a download write anywhere on the machine.
 */
import { describe, it, expect } from 'vitest';
import {
  parseLocaleConfig,
  resolveLocaleSettings,
  serializeLocaleConfig,
} from './config.js';
import { diffCatalogs, renderPath, validatePathTemplate } from './files.js';

describe('parseLocaleConfig', () => {
  it('reads the documented fields', () => {
    const config = parseLocaleConfig(`
project: acme-web
sourceLanguage: en-US
targetLanguages: [fr-FR, de-DE]
format: nested
path: src/locales/{language}/{namespace}.json
namespaces: [common, checkout]
version: latest
`);
    expect(config).toEqual({
      project: 'acme-web',
      sourceLanguage: 'en-US',
      targetLanguages: ['fr-FR', 'de-DE'],
      format: 'nested',
      path: 'src/locales/{language}/{namespace}.json',
      namespaces: ['common', 'checkout'],
      version: 'latest',
    });
  });

  it('degrades to an empty config rather than throwing on junk', () => {
    // A malformed config should surface as "nothing configured", which the
    // commands already explain how to fix, not as a stack trace.
    expect(parseLocaleConfig('')).toEqual({});
    expect(parseLocaleConfig('just a string')).toEqual({});
    expect(parseLocaleConfig('- a\n- b')).toEqual({});
  });

  it('ignores unknown keys so a newer CLI cannot break an older one', () => {
    const config = parseLocaleConfig('project: acme\nfutureOption: true\n');
    expect(config.project).toBe('acme');
    expect((config as Record<string, unknown>).futureOption).toBeUndefined();
  });

  it('drops blank and non-string list entries rather than storing them', () => {
    const config = parseLocaleConfig('targetLanguages: ["fr-FR", "", 7]\n');
    expect(config.targetLanguages).toEqual(['fr-FR']);
  });
});

describe('serializeLocaleConfig', () => {
  it('omits empty fields so the written file stays readable', () => {
    const text = serializeLocaleConfig({
      project: 'acme',
      description: undefined,
      targetLanguages: [],
    } as never);
    expect(text).toContain('project: acme');
    expect(text).not.toContain('targetLanguages');
  });

  it('never writes a credential field, even if one is passed in', () => {
    // The config file is expected to be committed. A DSN here would be a secret
    // in the customer's git history.
    const text = serializeLocaleConfig({ project: 'acme' });
    expect(text).not.toMatch(/dsn|secret|token/i);
  });
});

describe('resolveLocaleSettings', () => {
  it('lets a flag win over the config file', () => {
    const settings = resolveLocaleSettings(
      { project: 'from-config', format: 'yaml' },
      { project: 'from-flag' },
    );
    expect(settings.project).toBe('from-flag');
    expect(settings.format).toBe('yaml');
  });

  it('applies documented defaults when neither supplies a value', () => {
    const settings = resolveLocaleSettings({}, {});
    expect(settings.sourceLanguage).toBe('en-US');
    expect(settings.format).toBe('nested');
    expect(settings.version).toBe('latest');
    expect(settings.namespaces).toEqual(['common']);
    expect(settings.path).toBe('src/locales/{language}/{namespace}.json');
  });

  it('leaves project undefined when nothing supplies it, so the caller can explain', () => {
    // Inventing a project slug here would produce a confusing 404 from the
    // server instead of a clear local "no project configured" message.
    expect(resolveLocaleSettings({}, {}).project).toBeUndefined();
  });
});

describe('validatePathTemplate', () => {
  it('accepts a template containing {language}', () => {
    expect(validatePathTemplate('src/locales/{language}/{namespace}.json')).toBeNull();
    expect(validatePathTemplate('locales/{language}.json')).toBeNull();
  });

  it('requires {language}, naming the missing token', () => {
    expect(validatePathTemplate('src/locales/common.json')).toMatch(/\{language\}/);
  });

  it('rejects an absolute path and a traversal, which could write outside the project', () => {
    expect(validatePathTemplate('/etc/{language}.json')).toMatch(/relative/);
    expect(validatePathTemplate('../../{language}.json')).toMatch(/\.\./);
    expect(validatePathTemplate('src/../../{language}.json')).toMatch(/\.\./);
  });

  it('rejects an empty template', () => {
    expect(validatePathTemplate('')).not.toBeNull();
    expect(validatePathTemplate('   ')).not.toBeNull();
  });
});

describe('renderPath', () => {
  it('substitutes every occurrence of both tokens', () => {
    expect(renderPath('{language}/{namespace}/{language}.json', 'fr-FR', 'common')).toBe(
      'fr-FR/common/fr-FR.json',
    );
  });

  it('leaves a template without {namespace} intact', () => {
    expect(renderPath('locales/{language}.json', 'de-DE', 'common')).toBe('locales/de-DE.json');
  });
});

describe('diffCatalogs', () => {
  it('classifies added, changed, removed, and unchanged keys', () => {
    const diff = diffCatalogs(
      { a: '1', b: '2', gone: '3' },
      { a: '1', b: 'changed', c: 'new' },
    );
    expect(diff.unchanged).toEqual(['a']);
    expect(diff.changed).toEqual(['b']);
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual(['gone']);
  });

  it('treats a value changing to empty string as a change, not a removal', () => {
    // Empty string is a legitimate translation; conflating it with "removed"
    // would make a real edit invisible in a dry-run summary.
    const diff = diffCatalogs({ a: 'text' }, { a: '' });
    expect(diff.changed).toEqual(['a']);
    expect(diff.removed).toEqual([]);
  });
});
