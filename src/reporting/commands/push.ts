import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { resolveIngestHost } from './dsn.js';
import { resolveDsn } from '../credentials.js';
import { availableRegionIds, dashHostForIngestHost } from '../regions.js';
import { prepareCompressedUpload } from '../utils/compact-artifact.js';
import { uploadScanArtifact } from '../utils/upload.js';
import { loadConfig } from '../../core-open/index.js';
import type { ScanArtifact } from '../types.js';

interface ParsedDsn {
  keyId: string;
  secret: string;
  host: string;
  workspaceId: string;
  scheme: 'https' | 'http';
}

export function parseDsn(dsn: string): ParsedDsn | null {
  // vibgrate+https://<key_id>:<secret>@<host>/<workspace_id>
  // vibgrate+http://... allowed for local development
  // Strip invisible/control characters (CR, LF, BOM, zero-width, etc.) that may
  // sneak in from Windows .env files, clipboard pastes, or editor artifacts
  const cleaned = dsn
    .replace(/[\x00-\x1F\x7F\uFEFF\u200B-\u200D\u2060]/g, '') // control chars, BOM, zero-width
    .trim();
  const match = cleaned.match(/^vibgrate\+(https?):?\/\/([^:]+):([^@]+)@([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    scheme: match[1] as 'https' | 'http',
    keyId: match[2]!,
    secret: match[3]!,
    host: match[4]!,
    workspaceId: match[5]!,
  };
}

export function computeHmac(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

export const pushCommand = new Command('push')
  .description('Push scan results to Vibgrate API')
  .option('--dsn <dsn>', 'DSN token (or use VIBGRATE_DSN env)')
  .option('--region <region>', `Override data residency region (${availableRegionIds().join(', ')})`)
  .option('--file <file>', 'Scan artifact file', '.vibgrate/scan_result.json')
  .option('--strict', 'Fail on upload errors')
  .action(async (opts: { dsn?: string; region?: string; file: string; strict?: boolean }) => {
    const dsn = resolveDsn(opts.dsn);

    if (!dsn) {
      console.error(chalk.red('No DSN provided.'));
      console.error(chalk.dim('Run "vibgrate login", set VIBGRATE_DSN, or use the --dsn flag.'));
      if (opts.strict) process.exit(1);
      return;
    }

    const parsed = parseDsn(dsn);
    if (!parsed) {
      console.error(chalk.red('Invalid DSN format.'));
      console.error(chalk.dim('Expected: vibgrate+https://<key_id>:<secret>@<host>/<workspace_id>'));
      if (opts.strict) process.exit(1);
      return;
    }

    const filePath = path.resolve(opts.file);
    if (!(await pathExists(filePath))) {
      console.error(chalk.red(`Scan artifact not found: ${filePath}`));
      console.error(chalk.dim('Run "vibgrate scan" first.'));
      if (opts.strict) process.exit(1);
      return;
    }

    // Load artifact, compact it, and compress for upload. `databaseSchemaCaps`
    // lets `scanners.databaseSchema` in vibgrate.config.ts (read from the
    // current directory, same as `vg scan`) raise/lower the default upload
    // caps (see DOCS.md § Database Schema).
    const artifact = await readJsonFile<ScanArtifact>(filePath);
    const config = await loadConfig(process.cwd());
    const databaseSchemaCaps = config.scanners !== false ? config.scanners?.databaseSchema : undefined;
    const { body, contentEncoding } = await prepareCompressedUpload(artifact, { databaseSchemaCaps });
    const timestamp = String(Date.now());

    // Allow --region to override the host baked into the DSN
    let host = parsed.host;
    if (opts.region) {
      try {
        host = resolveIngestHost(opts.region);
      } catch (e: unknown) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        if (opts.strict) process.exit(1);
        return;
      }
    }

    const originalSize = JSON.stringify(artifact).length;
    const compressedSize = body.length;
    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(0);
    console.log(chalk.dim(`Uploading to ${host}... (${(compressedSize / 1024).toFixed(0)} KB, ${ratio}% smaller)`));

    try {
      // Auto-retries against the workspace's pinned region on a 409 REGION_MISMATCH.
      const { response, host: uploadedHost } = await uploadScanArtifact({
        scheme: parsed.scheme,
        host,
        keyId: parsed.keyId,
        secret: parsed.secret,
        body,
        contentEncoding,
        timestamp,
        // Set only by an automated caller running the scan on the workspace's
        // behalf (e.g. a Vibgrate-hosted remediation run) — never a customer flag.
        runId: process.env.VIBGRATE_SCAN_RUN_ID,
        runToken: process.env.VIBGRATE_SCAN_RUN_TOKEN,
      });
      host = uploadedHost;

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const result = await response.json() as { status: string; ingestId?: string };
      console.log(chalk.green('✔') + ` Scan queued for processing (${result.ingestId ?? 'ok'})`);
      
      // Display feedback prompt
      console.log();
      console.log(chalk.dim('Processing continues in the background. Results available shortly.'));
      console.log();
      
      // Show scan report link
      if (result.ingestId) {
        const dashHost = dashHostForIngestHost(host);
        const reportUrl = `https://${dashHost}/${parsed.workspaceId}/scan/${result.ingestId}`;
        console.log(chalk.dim('View report: ') + chalk.underline(reportUrl));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(chalk.red(`Upload failed: ${msg}`));
      if (opts.strict) process.exit(1);
    }
  });
