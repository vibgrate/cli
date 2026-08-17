// ── `vg locale` — Vibgrate Localize command surface ──
//
// Managed localisation for YOUR application: locale projects, keys, and
// translations in Vibgrate Cloud, synced with the locale files in your repo.
//
// Two halves, deliberately:
//   * LOCAL commands (`config`, `format`) only touch the filesystem. They work
//     on every plan and never open a network connection.
//   * CLOUD commands (`push`, `pull`, `save-missing`, `add`, `remove`, `get`,
//     `status`) talk to Vibgrate Cloud over your existing DSN and require a Team
//     plan or above.
//
// `vg localize` is a backward-friendly alias; `vg locale` is canonical.

import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { CliError, ExitCode } from '../../../util/exit.js';
import { resolveDsn } from '../../credentials.js';
import { createLocaleClient, type LocaleClient } from './client.js';
import {
  loadLocaleConfig,
  resolveLocaleSettings,
  writeLocaleConfig,
  type LocaleConfig,
} from './config.js';
import { codecFor, isSupportedFormat, SUPPORTED_FORMATS, type FlatCatalog } from './formats.js';
import {
  diffCatalogs,
  readCatalog,
  resolveLocaleFiles,
  validatePathTemplate,
  writeCatalog,
} from './files.js';

const cwdOption: [string, string] = ['-C, --cwd <dir>', 'Run against this directory (default: current)'];

function root(opts: { cwd?: string }): string {
  return path.resolve(opts.cwd ?? process.cwd());
}

interface CommonOpts {
  cwd?: string;
  dsn?: string;
  project?: string;
  format?: string;
  path?: string;
  namespace?: string;
  language?: string;
  ver?: string;
  json?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
}

/** Apply the global flags every locale subcommand accepts. */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option(...cwdOption)
    .option('--dsn <dsn>', 'DSN token (or use VIBGRATE_DSN, or run "vg login")')
    .option('--project <slug>', 'Locale project slug or id')
    .option('--format <format>', `Locale file format (${SUPPORTED_FORMATS.join(', ')})`)
    .option('--path <template>', 'Path template, e.g. src/locales/{language}/{namespace}.json')
    .option('--namespace <name>', 'Restrict to one namespace')
    .option('--language <code>', 'Restrict to one BCP-47 language')
    .option('--ver <version>', 'Target version (default: latest)')
    .option('--json', 'Machine-readable output')
    .option('-q, --quiet', 'Suppress non-essential output');
}

/**
 * Resolve config + flags into effective settings, failing early with a message
 * that says which field is missing and how to supply it.
 */
function settingsFor(opts: CommonOpts): { dir: string; settings: Required<Pick<LocaleConfig, 'project' | 'format' | 'path' | 'version'>> & LocaleConfig } {
  const dir = root(opts);
  const { config } = loadLocaleConfig(dir);
  const merged = resolveLocaleSettings(config, {
    project: opts.project,
    format: opts.format,
    path: opts.path,
    version: opts.ver,
    namespaces: opts.namespace ? [opts.namespace] : undefined,
    targetLanguages: opts.language ? [opts.language] : undefined,
  });

  if (!merged.project) {
    throw new CliError(
      'No locale project configured.\nRun "vg locale config --project <slug>", or pass --project <slug>.',
      ExitCode.ERROR,
    );
  }
  if (!isSupportedFormat(merged.format!)) {
    // codecFor produces the "planned but not yet" vs "unknown" distinction.
    codecFor(merged.format!);
  }
  const pathError = validatePathTemplate(merged.path!);
  if (pathError) throw new CliError(pathError, ExitCode.ERROR);

  return {
    dir,
    settings: merged as Required<Pick<LocaleConfig, 'project' | 'format' | 'path' | 'version'>> & LocaleConfig,
  };
}

/** Build an authenticated client, or explain exactly how to authenticate. */
function clientFor(opts: CommonOpts): LocaleClient {
  const dsn = resolveDsn(opts.dsn);
  if (!dsn) {
    throw new CliError(
      'No DSN available.\nRun "vg login", set VIBGRATE_DSN, or pass --dsn.',
      ExitCode.ERROR,
    );
  }
  return createLocaleClient(dsn);
}

function emit(opts: CommonOpts, payload: unknown, human: () => void): void {
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!opts.quiet) human();
}

// ── config ──

const configCmd = withCommonOptions(
  new Command('config').description('Create or update vibgrate.locale.yaml (no credentials are stored)'),
)
  .option('--source-language <code>', 'Source language (default: en-US)')
  .option('--target-languages <codes>', 'Comma-separated target languages')
  .option('--namespaces <names>', 'Comma-separated namespaces')
  .action(
    async (
      opts: CommonOpts & { sourceLanguage?: string; targetLanguages?: string; namespaces?: string },
    ) => {
      const dir = root(opts);
      const { config, file } = loadLocaleConfig(dir);

      const csv = (v?: string) =>
        v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      const next: LocaleConfig = {
        project: opts.project ?? config.project,
        sourceLanguage: opts.sourceLanguage ?? config.sourceLanguage ?? 'en-US',
        targetLanguages: csv(opts.targetLanguages) ?? config.targetLanguages,
        format: opts.format ?? config.format ?? 'nested',
        path: opts.path ?? config.path ?? 'src/locales/{language}/{namespace}.json',
        namespaces: csv(opts.namespaces) ?? config.namespaces ?? ['common'],
        version: opts.ver ?? config.version ?? 'latest',
      };

      const pathError = validatePathTemplate(next.path!);
      if (pathError) throw new CliError(pathError, ExitCode.ERROR);
      if (!isSupportedFormat(next.format!)) codecFor(next.format!);

      const written = writeLocaleConfig(dir, next, file ?? undefined);

      emit(opts, { file: written, config: next }, () => {
        console.log(chalk.green(`Wrote ${path.relative(dir, written) || path.basename(written)}`));
        console.log(
          chalk.dim('Credentials are not stored here — run "vg login" or set VIBGRATE_DSN.'),
        );
      });
    },
  );

// ── status ──

interface StatusResponse {
  project: { name: string; slug: string; sourceLanguage: string; targetLanguages: string[] };
  coverage: {
    totalKeys: number;
    languages: Array<{
      language: string;
      translated: number;
      needsReview: number;
      machine: number;
      draft: number;
      missing: number;
      coveragePercent: number | null;
    }>;
  };
  namespaces: Array<{ name: string; keys: number }>;
  lastTranslationAt: string | null;
}

const statusCmd = withCommonOptions(
  new Command('status').description('Show translation coverage and health for the locale project'),
).action(async (opts: CommonOpts) => {
  const { settings } = settingsFor(opts);
  const client = clientFor(opts);
  const res = await client.get<StatusResponse>(
    `/projects/${encodeURIComponent(settings.project)}/status`,
  );
  const data = res.data;
  if (!data) throw new CliError('Vibgrate Cloud returned no status data.', ExitCode.ERROR);

  emit(opts, data, () => {
    console.log(chalk.bold(`${data.project.name} (${data.project.slug})`));
    console.log(chalk.dim(`Source: ${data.project.sourceLanguage} · ${data.coverage.totalKeys} keys`));
    console.log('');
    for (const lang of data.coverage.languages) {
      // A project with no keys reports null, which is "nothing to translate yet"
      // — printing 0% there would be a different and wrong claim.
      const pct = lang.coveragePercent === null ? '—' : `${lang.coveragePercent}%`;
      const parts = [`${lang.translated} translated`];
      if (lang.machine) parts.push(chalk.yellow(`${lang.machine} machine`));
      if (lang.needsReview) parts.push(chalk.yellow(`${lang.needsReview} to review`));
      if (lang.missing) parts.push(chalk.dim(`${lang.missing} missing`));
      console.log(`  ${lang.language.padEnd(10)} ${pct.padStart(6)}  ${parts.join(' · ')}`);
    }
    if (data.namespaces.length) {
      console.log('');
      console.log(chalk.dim(`Namespaces: ${data.namespaces.map((n) => `${n.name} (${n.keys})`).join(', ')}`));
    }
    console.log(
      chalk.dim(
        data.lastTranslationAt
          ? `Last translation: ${data.lastTranslationAt}`
          : 'No translations recorded yet.',
      ),
    );
  });
});

// ── push / sync ──

interface PushResponse {
  created: number;
  updated: number;
  translationsWritten: number;
  version: string;
}

/** Read every configured locale file and turn it into the push payload. */
function collectLocalKeys(
  dir: string,
  settings: LocaleConfig,
  languages: string[],
): {
  keys: Array<{
    namespace: string;
    key: string;
    sourceValue: string | null;
    translations: Array<{ language: string; value: string }>;
  }>;
  filesRead: string[];
} {
  const namespaces = settings.namespaces ?? ['common'];
  const sourceLanguage = settings.sourceLanguage ?? 'en-US';
  const format = settings.format!;
  const template = settings.path!;

  const byKey = new Map<
    string,
    { namespace: string; key: string; sourceValue: string | null; translations: Array<{ language: string; value: string }> }
  >();
  const filesRead: string[] = [];

  const allLanguages = [sourceLanguage, ...languages.filter((l) => l !== sourceLanguage)];
  for (const file of resolveLocaleFiles(dir, template, allLanguages, namespaces)) {
    if (!file.exists) continue;
    filesRead.push(file.relative);
    const catalog = readCatalog(file.file, format);
    for (const [key, value] of Object.entries(catalog)) {
      const id = `${file.namespace} ${key}`;
      const entry = byKey.get(id) ?? {
        namespace: file.namespace,
        key,
        sourceValue: null,
        translations: [],
      };
      if (file.language === sourceLanguage) entry.sourceValue = value;
      else entry.translations.push({ language: file.language, value });
      byKey.set(id, entry);
    }
  }

  return { keys: [...byKey.values()], filesRead };
}

/** Batch so a large catalogue does not exceed the server's per-request ceiling. */
const PUSH_BATCH_SIZE = 400;

function makePushCommand(name: string, description: string): Command {
  return withCommonOptions(new Command(name).description(description))
    .option('--dry-run', 'Report what would be pushed without sending anything')
    .option(
      '--source-only',
      'Push only source-language keys, leaving existing translations untouched',
    )
    .action(async (opts: CommonOpts & { sourceOnly?: boolean }) => {
      const { dir, settings } = settingsFor(opts);
      const languages = opts.sourceOnly ? [] : (settings.targetLanguages ?? []);
      const { keys, filesRead } = collectLocalKeys(dir, settings, languages);

      if (!keys.length) {
        throw new CliError(
          `No locale files found for template "${settings.path}".\n` +
            'Check the template with "vg locale config --path <template>", or create the source files first.',
          ExitCode.ERROR,
        );
      }

      if (opts.dryRun) {
        const summary = {
          dryRun: true,
          filesRead,
          keys: keys.length,
          translations: keys.reduce((n, k) => n + k.translations.length, 0),
          version: settings.version,
        };
        emit(opts, summary, () => {
          console.log(chalk.bold('Dry run — nothing was sent.'));
          console.log(`  ${summary.keys} keys from ${filesRead.length} file(s)`);
          console.log(`  ${summary.translations} translations`);
          console.log(chalk.dim(`  version: ${summary.version}`));
        });
        return;
      }

      const client = clientFor(opts);
      let created = 0;
      let updated = 0;
      let translationsWritten = 0;

      for (let i = 0; i < keys.length; i += PUSH_BATCH_SIZE) {
        const batch = keys.slice(i, i + PUSH_BATCH_SIZE);
        const res = await client.post<PushResponse>(
          `/projects/${encodeURIComponent(settings.project)}/keys`,
          {
            version: settings.version,
            keys: batch.map((k) => ({
              namespace: k.namespace,
              key: k.key,
              sourceValue: k.sourceValue,
              translations: k.translations.map((t) => ({
                language: t.language,
                value: t.value,
                origin: 'import',
              })),
            })),
          },
        );
        created += res.data?.created ?? 0;
        updated += res.data?.updated ?? 0;
        translationsWritten += res.data?.translationsWritten ?? 0;
      }

      emit(opts, { created, updated, translationsWritten, version: settings.version }, () => {
        console.log(
          chalk.green(
            `Pushed ${keys.length} keys — ${created} created, ${updated} updated, ${translationsWritten} translations.`,
          ),
        );
      });
    });
}

// ── pull / download ──

interface KeyListResponse {
  keys: Array<{
    key: string;
    namespace: string;
    sourceValue: string | null;
    translation?: { value: string | null; status: string; origin: string };
  }>;
}

const PULL_PAGE_SIZE = 200;

/** Page through every key for one language. */
async function fetchAllKeys(
  client: LocaleClient,
  project: string,
  language: string,
  namespace?: string,
): Promise<KeyListResponse['keys']> {
  const out: KeyListResponse['keys'] = [];
  let offset = 0;
  for (;;) {
    const res = await client.get<KeyListResponse>(`/projects/${encodeURIComponent(project)}/keys`, {
      language,
      namespace,
      limit: PULL_PAGE_SIZE,
      offset,
    });
    const page = res.data?.keys ?? [];
    out.push(...page);
    const total = res.meta?.pagination?.total ?? out.length;
    offset += page.length;
    if (!page.length || out.length >= total) break;
  }
  return out;
}

function makePullCommand(name: string, description: string): Command {
  return withCommonOptions(new Command(name).description(description))
    .option('--dry-run', 'Report what would change without writing any file')
    .option(
      '--include-machine',
      'Also write machine and needs-review translations (default: accepted translations only)',
    )
    .action(async (opts: CommonOpts & { includeMachine?: boolean }) => {
      const { dir, settings } = settingsFor(opts);
      const client = clientFor(opts);

      const languages = opts.language
        ? [opts.language]
        : (settings.targetLanguages ?? []);
      if (!languages.length) {
        throw new CliError(
          'No target languages configured.\n' +
            'Run "vg locale config --target-languages fr-FR,de-DE", or pass --language <code>.',
          ExitCode.ERROR,
        );
      }
      const namespaces = settings.namespaces ?? ['common'];

      const results: Array<{ file: string; changed: boolean; added: number; updated: number }> = [];

      for (const language of languages) {
        for (const namespace of namespaces) {
          const keys = await fetchAllKeys(client, settings.project, language, namespace);

          const catalog: FlatCatalog = {};
          for (const entry of keys) {
            const t = entry.translation;
            if (!t || t.value === null) continue;
            // Unaccepted output stays out of the working tree by default: writing
            // a machine draft into a source file makes it indistinguishable from
            // reviewed copy the moment it is committed.
            const accepted = t.status === 'translated';
            if (!accepted && !opts.includeMachine) continue;
            catalog[entry.key] = t.value;
          }

          const target = resolveLocaleFiles(dir, settings.path!, [language], [namespace])[0]!;
          const before = readCatalog(target.file, settings.format!);
          const diff = diffCatalogs(before, catalog);
          const write = writeCatalog(target.file, settings.format!, catalog, {
            dryRun: opts.dryRun,
          });

          results.push({
            file: target.relative,
            changed: write.changed,
            added: diff.added.length,
            updated: diff.changed.length,
          });
        }
      }

      const changed = results.filter((r) => r.changed);
      emit(opts, { dryRun: Boolean(opts.dryRun), files: results }, () => {
        if (opts.dryRun) console.log(chalk.bold('Dry run — no files were written.'));
        for (const r of changed) {
          console.log(`  ${chalk.green(r.changed ? 'update' : 'ok')} ${r.file} (+${r.added} ~${r.updated})`);
        }
        const unchanged = results.length - changed.length;
        console.log(
          chalk.dim(
            `${changed.length} file(s) ${opts.dryRun ? 'would change' : 'written'}, ${unchanged} unchanged.`,
          ),
        );
      });
    });
}

// ── save-missing ──

const saveMissingCmd = withCommonOptions(
  new Command('save-missing').description(
    'Push only keys that do not exist in Vibgrate Cloud yet (never overwrites a translation)',
  ),
)
  .option('--dry-run', 'Report what would be sent without sending anything')
  .action(async (opts: CommonOpts) => {
    const { dir, settings } = settingsFor(opts);
    const client = clientFor(opts);
    const sourceLanguage = settings.sourceLanguage ?? 'en-US';

    const { keys } = collectLocalKeys(dir, settings, []);
    const namespaces = settings.namespaces ?? ['common'];

    // Ask for what exists first, then send only the difference. This is the
    // "low-cost / safe" verb: it must never clobber a reviewed translation.
    const existing = new Set<string>();
    for (const namespace of namespaces) {
      const remote = await fetchAllKeys(client, settings.project, sourceLanguage, namespace);
      for (const entry of remote) existing.add(`${entry.namespace} ${entry.key}`);
    }

    const missing = keys.filter((k) => !existing.has(`${k.namespace} ${k.key}`));

    if (!missing.length) {
      emit(opts, { missing: 0 }, () => console.log(chalk.dim('No missing keys — nothing to send.')));
      return;
    }

    if (opts.dryRun) {
      emit(opts, { dryRun: true, missing: missing.length, keys: missing.map((k) => `${k.namespace}:${k.key}`) }, () => {
        console.log(chalk.bold(`Dry run — ${missing.length} missing key(s) would be created.`));
        for (const k of missing.slice(0, 20)) console.log(`  ${chalk.green('+')} ${k.namespace}:${k.key}`);
        if (missing.length > 20) console.log(chalk.dim(`  …and ${missing.length - 20} more`));
      });
      return;
    }

    let created = 0;
    for (let i = 0; i < missing.length; i += PUSH_BATCH_SIZE) {
      const res = await client.post<PushResponse>(
        `/projects/${encodeURIComponent(settings.project)}/keys`,
        {
          version: settings.version,
          keys: missing.slice(i, i + PUSH_BATCH_SIZE).map((k) => ({
            namespace: k.namespace,
            key: k.key,
            sourceValue: k.sourceValue,
          })),
        },
      );
      created += res.data?.created ?? 0;
    }

    emit(opts, { created }, () => console.log(chalk.green(`Created ${created} missing key(s).`)));
  });

// ── add / remove / get ──

const addCmd = withCommonOptions(
  new Command('add').description('Add or update a single key').argument('<key>', 'Key name').argument(
    '[value]',
    'Source value',
  ),
).action(async (key: string, value: string | undefined, opts: CommonOpts) => {
  const { settings } = settingsFor(opts);
  const client = clientFor(opts);
  const namespace = opts.namespace ?? settings.namespaces?.[0] ?? 'common';

  const res = await client.post<PushResponse>(
    `/projects/${encodeURIComponent(settings.project)}/keys`,
    {
      version: settings.version,
      keys: [
        {
          namespace,
          key,
          sourceValue: value ?? null,
          translations:
            opts.language && value !== undefined
              ? [{ language: opts.language, value, origin: 'manual' }]
              : [],
        },
      ],
    },
  );

  emit(opts, res.data, () =>
    console.log(chalk.green(`${res.data?.created ? 'Created' : 'Updated'} ${namespace}:${key}`)),
  );
});

const removeCmd = withCommonOptions(
  new Command('remove').description('Remove one or more keys').argument('<keys...>', 'Key names'),
).action(async (keys: string[], opts: CommonOpts) => {
  const { settings } = settingsFor(opts);
  const client = clientFor(opts);
  const namespace = opts.namespace ?? settings.namespaces?.[0] ?? 'common';

  const res = await client.del<{ removed: number; translationsRemoved: number }>(
    `/projects/${encodeURIComponent(settings.project)}/keys`,
    { namespace, keys },
  );

  emit(opts, res.data, () =>
    console.log(
      chalk.green(
        `Removed ${res.data?.removed ?? 0} key(s) and ${res.data?.translationsRemoved ?? 0} translation(s).`,
      ),
    ),
  );
});

const getCmd = withCommonOptions(
  new Command('get').description('Show one key and its translations').argument('<key>', 'Key name'),
).action(async (key: string, opts: CommonOpts) => {
  const { settings } = settingsFor(opts);
  const client = clientFor(opts);
  const namespace = opts.namespace ?? settings.namespaces?.[0] ?? 'common';

  const res = await client.get<KeyListResponse>(
    `/projects/${encodeURIComponent(settings.project)}/keys`,
    { namespace, q: key, language: opts.language, limit: 50 },
  );
  const match = (res.data?.keys ?? []).find((k) => k.key === key);
  if (!match) {
    throw new CliError(`Key "${key}" not found in namespace "${namespace}".`, ExitCode.ERROR);
  }

  emit(opts, match, () => {
    console.log(chalk.bold(`${match.namespace}:${match.key}`));
    if (match.sourceValue !== null) console.log(`  source: ${match.sourceValue}`);
    if (match.translation) {
      const value = match.translation.value ?? chalk.dim('(not translated)');
      console.log(`  ${opts.language}: ${value} ${chalk.dim(`[${match.translation.status}]`)}`);
    }
  });
});

// ── format (local-only) ──

const formatCmd = withCommonOptions(
  new Command('format').description(
    'Re-format local locale files in place (local-only — no network, works on any plan)',
  ),
)
  .option('--dry-run', 'Report which files would change without writing')
  .action(async (opts: CommonOpts) => {
    const dir = root(opts);
    const { config } = loadLocaleConfig(dir);
    const settings = resolveLocaleSettings(config, {
      format: opts.format,
      path: opts.path,
      namespaces: opts.namespace ? [opts.namespace] : undefined,
      targetLanguages: opts.language ? [opts.language] : undefined,
    });

    const pathError = validatePathTemplate(settings.path!);
    if (pathError) throw new CliError(pathError, ExitCode.ERROR);

    const languages = [
      settings.sourceLanguage ?? 'en-US',
      ...(settings.targetLanguages ?? []),
    ];
    const files = resolveLocaleFiles(dir, settings.path!, languages, settings.namespaces ?? ['common']);

    const changed: string[] = [];
    for (const file of files) {
      if (!file.exists) continue;
      const catalog = readCatalog(file.file, settings.format!);
      const result = writeCatalog(file.file, settings.format!, catalog, { dryRun: opts.dryRun });
      if (result.changed) changed.push(file.relative);
    }

    emit(opts, { dryRun: Boolean(opts.dryRun), changed }, () => {
      for (const f of changed) console.log(`  ${chalk.green('format')} ${f}`);
      console.log(
        chalk.dim(`${changed.length} file(s) ${opts.dryRun ? 'would be reformatted' : 'reformatted'}.`),
      );
    });
  });

// ── registration ──

export function buildLocaleCommand(name: string): Command {
  const cmd = new Command(name).description(
    'Manage application translations — locale projects, keys, and translations in Vibgrate Cloud',
  );

  cmd.addCommand(configCmd);
  cmd.addCommand(makePushCommand('push', 'Upload local locale files to Vibgrate Cloud'));
  cmd.addCommand(makePushCommand('sync', 'Alias for push'));
  cmd.addCommand(makePullCommand('pull', 'Write translations from Vibgrate Cloud into local files'));
  cmd.addCommand(makePullCommand('download', 'Alias for pull'));
  cmd.addCommand(saveMissingCmd);
  cmd.addCommand(addCmd);
  cmd.addCommand(removeCmd);
  cmd.addCommand(getCmd);
  cmd.addCommand(statusCmd);
  cmd.addCommand(formatCmd);

  cmd.addHelpText(
    'after',
    '\nLocal-only commands (no network, any plan): config, format' +
      '\nCloud commands (Team plan or above): push, pull, save-missing, add, remove, get, status\n',
  );

  return cmd;
}

/** `vg locale` is canonical; `vg localize` is the backward-friendly alias. */
export function registerLocale(program: Command): void {
  program.addCommand(buildLocaleCommand('locale'));
  const alias = buildLocaleCommand('localize');
  // Keep the alias out of `--help` so there is one obvious way to do it.
  alias.description('Alias for "vg locale"');
  program.addCommand(alias, { hidden: true });
}
