// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Compact scan artifact for efficient upload
 *
 * Reduces artifact size by:
 * 1. Extracting only DB object names (not full CREATE statements)
 * 2. Simplifying API integrations to domains only
 * 3. Using compacted UI purpose evidence
 * 4. Including only first favicon, no logos
 * 5. Capping unbounded arrays
 */

import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type {
  ScanArtifact,
  DataStoresResult,
  ApiSurfaceResult,
  AssetBrandingResult,
  DatabaseSchemaResult,
  DatabaseSchemaUploadCaps,
  ExtendedScanResults,
} from '../types.js';
import { compactUiPurpose } from './compact-evidence.js';

const gzip = promisify(zlib.gzip);

/** Max items per array field to prevent bloat */
const MAX_ITEMS = 50;

/** Default caps for the `databaseSchema` scanner — a large monorepo can carry
 *  hundreds of tables and thousands of columns, so this scanner gets its own
 *  (more generous, but still bounded) limits rather than the generic
 *  `MAX_ITEMS`. Overridable per-field via `scanners.databaseSchema` in
 *  `vibgrate.config.ts` (see DOCS.md § Database Schema), up to
 *  `DB_UPLOAD_HARD_CEILING` below. */
const MAX_DB_MODELS = 300;
const MAX_DB_FIELDS_PER_MODEL = 100;
const MAX_DB_MODEL_FILES = 5;
const MAX_DB_FILES_SCANNED = 500;

/** Absolute ceiling on the `databaseSchema` upload caps, regardless of what a
 *  user configures — mirrored server-side in vibgrate-api's ingest zod schema
 *  as a hard `.max()` so a payload can never exceed these bounds even from a
 *  misconfigured or non-CLI client. */
export const DB_UPLOAD_HARD_CEILING = {
  maxModels: 2000,
  maxFieldsPerModel: 500,
  maxFilesPerModel: 20,
  maxFilesScanned: 5000,
} as const;

function clampCap(configured: number | undefined, fallback: number, ceiling: number): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) return fallback;
  return Math.min(Math.floor(configured), ceiling);
}

/**
 * Extract just the object name from a "name (file)" formatted string
 */
function extractName(entry: string): string {
  const match = entry.match(/^(.+?)\s*\(/);
  return match ? match[1].trim() : entry.trim();
}

/**
 * Compact DataStores result - extract only object names, cap arrays
 */
export function compactDataStores(result: DataStoresResult): DataStoresResult {
  return {
    databaseTechnologies: result.databaseTechnologies.slice(0, 10),
    connectionStrings: [], // Don't include connection strings in upload
    connectionPoolSettings: result.connectionPoolSettings.slice(0, MAX_ITEMS),
    replicationSettings: result.replicationSettings.slice(0, 20),
    readReplicaSettings: result.readReplicaSettings.slice(0, 20),
    failoverSettings: result.failoverSettings.slice(0, 20),
    collationAndEncoding: result.collationAndEncoding.slice(0, 20),
    queryTimeoutDefaults: result.queryTimeoutDefaults.slice(0, 20),
    manualIndexes: result.manualIndexes.map(extractName).slice(0, MAX_ITEMS),
    tables: result.tables.map(extractName).slice(0, MAX_ITEMS),
    views: result.views.map(extractName).slice(0, MAX_ITEMS),
    storedProcedures: result.storedProcedures.map(extractName).slice(0, MAX_ITEMS),
    triggers: result.triggers.map(extractName).slice(0, MAX_ITEMS),
    rowLevelSecurityPolicies: result.rowLevelSecurityPolicies.slice(0, 20),
    otherServices: result.otherServices.slice(0, 20),
  };
}

/**
 * Compact ApiSurface result - simplify to domains, cap arrays
 */
export function compactApiSurface(result: ApiSurfaceResult): ApiSurfaceResult {
  // Dedupe integrations by provider domain
  const seenProviders = new Set<string>();
  const uniqueIntegrations = result.integrations.filter((i) => {
    const domain = i.provider.split(':')[0];
    if (seenProviders.has(domain)) return false;
    seenProviders.add(domain);
    return true;
  }).slice(0, MAX_ITEMS).map((i) => ({
    provider: i.provider,
    endpoint: '', // Don't include full endpoints
    version: i.version,
    parameters: [], // Don't include params
    configOptions: [],
    authHints: [],
    files: [], // Don't include file paths
  }));

  return {
    integrations: uniqueIntegrations,
    openApiSpecifications: result.openApiSpecifications.slice(0, 10),
    webhookUrls: result.webhookUrls.slice(0, 20),
    callbackEndpoints: result.callbackEndpoints.slice(0, 20),
    apiVersionPins: result.apiVersionPins.slice(0, 20),
    tokenExpirationPolicies: result.tokenExpirationPolicies.slice(0, 20),
    rateLimitOverrides: result.rateLimitOverrides.slice(0, 20),
    customHeaders: result.customHeaders.slice(0, 20),
    corsPolicies: result.corsPolicies.slice(0, 20),
    oauthScopes: result.oauthScopes.slice(0, 20),
    apiTokens: [], // Don't include token references
  };
}

/**
 * Compact AssetBranding result - first favicon only, no logos
 */
export function compactAssetBranding(result: AssetBrandingResult): AssetBrandingResult {
  return {
    faviconFiles: result.faviconFiles.slice(0, 1),
    productLogos: [], // Don't include logos
  };
}

/**
 * Compact DatabaseSchemaResult — cap models, fields-per-model, and files so a
 * schema-heavy monorepo can't dominate the upload payload. Structural facts
 * only are ever present here to begin with (see `database-schema.ts`); this
 * only trims *how many* of those facts survive, never adds anything new.
 *
 * `caps` lets `scanners.databaseSchema` in `vibgrate.config.ts` raise (or
 * lower) the defaults per-field; each override is clamped to
 * `DB_UPLOAD_HARD_CEILING` so local config can never produce a payload the
 * ingest API's own hard limit would reject outright.
 */
export function compactDatabaseSchema(result: DatabaseSchemaResult, caps?: DatabaseSchemaUploadCaps): DatabaseSchemaResult {
  const maxModels = clampCap(caps?.maxModels, MAX_DB_MODELS, DB_UPLOAD_HARD_CEILING.maxModels);
  const maxFieldsPerModel = clampCap(caps?.maxFieldsPerModel, MAX_DB_FIELDS_PER_MODEL, DB_UPLOAD_HARD_CEILING.maxFieldsPerModel);
  const maxFilesPerModel = clampCap(caps?.maxFilesPerModel, MAX_DB_MODEL_FILES, DB_UPLOAD_HARD_CEILING.maxFilesPerModel);
  const maxFilesScanned = clampCap(caps?.maxFilesScanned, MAX_DB_FILES_SCANNED, DB_UPLOAD_HARD_CEILING.maxFilesScanned);

  return {
    providers: result.providers.slice(0, MAX_ITEMS),
    models: result.models.slice(0, maxModels).map((model) => ({
      ...model,
      fields: model.fields.slice(0, maxFieldsPerModel),
      files: model.files.slice(0, maxFilesPerModel),
    })),
    enums: result.enums.slice(0, MAX_ITEMS),
    filesScanned: result.filesScanned.slice(0, maxFilesScanned),
    projects: result.projects.slice(0, MAX_ITEMS).map((project) => ({
      project: project.project,
      filesScanned: project.filesScanned.slice(0, MAX_ITEMS),
      models: project.models.slice(0, MAX_ITEMS),
      enums: project.enums.slice(0, MAX_ITEMS),
    })),
  };
}

export interface PrepareArtifactForUploadOptions {
  /** Overrides for the `databaseSchema` scanner's upload caps, sourced from
   *  `scanners.databaseSchema` in `vibgrate.config.ts`. */
  databaseSchemaCaps?: DatabaseSchemaUploadCaps;
}

/**
 * Prepare artifact for upload by compacting all extended results
 */
export function prepareArtifactForUpload(artifact: ScanArtifact, opts?: PrepareArtifactForUploadOptions): ScanArtifact {
  const compacted = { ...artifact };

  if (compacted.extended) {
    const ext: ExtendedScanResults = { ...compacted.extended };

    // Compact DataStores
    if (ext.dataStores) {
      ext.dataStores = compactDataStores(ext.dataStores);
    }

    // Compact ApiSurface
    if (ext.apiSurface) {
      ext.apiSurface = compactApiSurface(ext.apiSurface);
    }

    // Compact AssetBranding
    if (ext.assetBranding) {
      ext.assetBranding = compactAssetBranding(ext.assetBranding);
    }

    // Convert UiPurpose to compacted version
    if (ext.uiPurpose) {
      // Replace full UiPurposeResult with CompactUiPurpose structure
      // We store it under the same key but with compacted data
      const compactedUi = compactUiPurpose(ext.uiPurpose);
      // Store as a minimal structure
      ext.uiPurpose = {
        enabled: ext.uiPurpose.enabled,
        detectedFrameworks: compactedUi.detectedFrameworks,
        evidenceCount: compactedUi.originalCount,
        capped: ext.uiPurpose.capped,
        topEvidence: [], // Clear full evidence
        unknownSignals: [],
        // Add compacted data under extended properties
        ...({ compacted: compactedUi } as Record<string, unknown>),
      };
    }

    // Cap other potentially large arrays
    if (ext.runtimeConfiguration) {
      ext.runtimeConfiguration = {
        ...ext.runtimeConfiguration,
        environmentVariables: ext.runtimeConfiguration.environmentVariables.slice(0, 100),
        hiddenConfigFiles: ext.runtimeConfiguration.hiddenConfigFiles.slice(0, MAX_ITEMS),
        startupArguments: ext.runtimeConfiguration.startupArguments.slice(0, 100),
      };
    }

    if (ext.operationalResilience) {
      const ops = ext.operationalResilience;
      ext.operationalResilience = {
        implicitTimeouts: ops.implicitTimeouts.slice(0, 30),
        defaultPaginationSize: ops.defaultPaginationSize.slice(0, 30),
        implicitRetryLogic: ops.implicitRetryLogic.slice(0, 30),
        defaultLocale: ops.defaultLocale.slice(0, 20),
        defaultCurrency: ops.defaultCurrency.slice(0, 20),
        implicitTimezone: ops.implicitTimezone.slice(0, 20),
        defaultCharacterEncoding: ops.defaultCharacterEncoding.slice(0, 20),
        sessionStores: ops.sessionStores.slice(0, 20),
        distributedLocks: ops.distributedLocks.slice(0, 20),
        jobSchedulers: ops.jobSchedulers.slice(0, 30),
        idempotencyKeys: ops.idempotencyKeys.slice(0, 20),
        rateLimitingCounters: ops.rateLimitingCounters.slice(0, 20),
        circuitBreakerState: ops.circuitBreakerState.slice(0, 20),
        abTestToggles: ops.abTestToggles.slice(0, 20),
        regionalEnablementRules: ops.regionalEnablementRules.slice(0, 20),
        betaAccessGroups: ops.betaAccessGroups.slice(0, 20),
        licensingEnforcementLogic: ops.licensingEnforcementLogic.slice(0, 20),
        killSwitches: ops.killSwitches.slice(0, 20),
        connectorRetryLogic: ops.connectorRetryLogic.slice(0, 20),
        apiPollingIntervals: ops.apiPollingIntervals.slice(0, 20),
        fieldMappings: ops.fieldMappings.slice(0, 20),
        schemaRegistryRules: ops.schemaRegistryRules.slice(0, 20),
        deadLetterQueueBehavior: ops.deadLetterQueueBehavior.slice(0, 20),
        dataMaskingRules: ops.dataMaskingRules.slice(0, 20),
        transformationLogic: ops.transformationLogic.slice(0, 20),
        timezoneHandling: ops.timezoneHandling.slice(0, 20),
        encryptionSettings: ops.encryptionSettings.slice(0, 30),
        hardcodedSecretSignals: ops.hardcodedSecretSignals.slice(0, 20),
      };
    }

    // Cap dependencyGraph phantom details
    if (ext.dependencyGraph) {
      ext.dependencyGraph = {
        ...ext.dependencyGraph,
        phantomDependencies: ext.dependencyGraph.phantomDependencies.slice(0, MAX_ITEMS),
        phantomDependencyDetails: ext.dependencyGraph.phantomDependencyDetails?.slice(0, MAX_ITEMS),
        duplicatedPackages: ext.dependencyGraph.duplicatedPackages.slice(0, MAX_ITEMS),
      };
    }

    // Cap databaseSchema (models/fields/files) — see compactDatabaseSchema.
    if (ext.databaseSchema) {
      ext.databaseSchema = compactDatabaseSchema(ext.databaseSchema, opts?.databaseSchemaCaps);
    }

    compacted.extended = ext;
  }

  return compacted;
}

/**
 * Compress artifact JSON with gzip
 */
export async function compressArtifact(artifact: ScanArtifact): Promise<Buffer> {
  const json = JSON.stringify(artifact);
  return gzip(json, { level: 9 });
}

/**
 * Prepare and compress artifact for upload
 */
export async function prepareCompressedUpload(
  artifact: ScanArtifact,
  opts?: PrepareArtifactForUploadOptions,
): Promise<{ body: Buffer; contentEncoding: 'gzip' }> {
  const compacted = prepareArtifactForUpload(artifact, opts);
  const compressed = await compressArtifact(compacted);
  return { body: compressed, contentEncoding: 'gzip' };
}
