import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import chalk from 'chalk';
import { pathExists, readJsonFile, writeTextFile } from '../utils/fs.js';

/**
 * The in-toto predicate type for an OpenVEX attestation. Passed to
 * `cosign attest --type …` in the release pipeline and verified by buyers.
 */
export const OPENVEX_PREDICATE_TYPE = 'openvex';

/** OpenVEX context URI (spec version this generator emits). */
const OPENVEX_CONTEXT = 'https://openvex.dev/ns/v0.2.0';

/** Valid OpenVEX statement statuses. */
const VEX_STATUSES = ['not_affected', 'affected', 'fixed', 'under_investigation'] as const;
export type VexStatus = (typeof VEX_STATUSES)[number];

/** Justifications permitted for a `not_affected` status (OpenVEX spec). */
const VEX_JUSTIFICATIONS = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
] as const;
export type VexJustification = (typeof VEX_JUSTIFICATIONS)[number];

export interface VexStatementInput {
  vulnerability: string;
  /** Product references (e.g. `pkg:…` or an image digest). Falls back to the document default. */
  products?: string[];
  status: VexStatus;
  justification?: VexJustification;
  impact_statement?: string;
  action_statement?: string;
}

interface OpenVexStatement {
  vulnerability: { name: string };
  products: Array<{ '@id': string }>;
  status: VexStatus;
  justification?: VexJustification;
  impact_statement?: string;
  action_statement?: string;
}

export interface OpenVexDocument {
  '@context': string;
  '@id': string;
  author: string;
  timestamp: string;
  version: number;
  statements: OpenVexStatement[];
}

export interface BuildVexOptions {
  author: string;
  /** Default product applied to statements that don't carry their own. */
  defaultProduct?: string;
  timestamp?: string;
  id?: string;
  statements: VexStatementInput[];
}

/** A validation problem found while assembling the document. */
export class VexValidationError extends Error {}

/**
 * Builds a spec-compliant OpenVEX document from a set of statements. Pure: given
 * the same inputs (including an explicit `timestamp`/`id`) it returns the same
 * document, so an attested VEX is reproducible. A document with zero statements
 * is valid and honest — it asserts no known affected components.
 */
export function buildVexDocument(opts: BuildVexOptions): OpenVexDocument {
  const statements: OpenVexStatement[] = opts.statements.map((s, i) => {
    if (!s.vulnerability || typeof s.vulnerability !== 'string') {
      throw new VexValidationError(`statement[${i}]: "vulnerability" is required`);
    }
    if (!VEX_STATUSES.includes(s.status)) {
      throw new VexValidationError(
        `statement[${i}] (${s.vulnerability}): invalid status "${s.status}". Expected one of: ${VEX_STATUSES.join(', ')}`,
      );
    }

    const products = (s.products && s.products.length > 0
      ? s.products
      : opts.defaultProduct
        ? [opts.defaultProduct]
        : []);
    if (products.length === 0) {
      throw new VexValidationError(
        `statement[${i}] (${s.vulnerability}): no product. Set "products" on the statement or pass --product.`,
      );
    }

    // OpenVEX requires a justification or impact_statement for not_affected, and
    // an action_statement is expected for affected.
    if (s.status === 'not_affected' && !s.justification && !s.impact_statement) {
      throw new VexValidationError(
        `statement[${i}] (${s.vulnerability}): "not_affected" requires a justification or impact_statement.`,
      );
    }
    if (s.justification && !VEX_JUSTIFICATIONS.includes(s.justification)) {
      throw new VexValidationError(
        `statement[${i}] (${s.vulnerability}): invalid justification "${s.justification}". Expected one of: ${VEX_JUSTIFICATIONS.join(', ')}`,
      );
    }
    if (s.status === 'affected' && !s.action_statement) {
      throw new VexValidationError(
        `statement[${i}] (${s.vulnerability}): "affected" requires an action_statement.`,
      );
    }

    const out: OpenVexStatement = {
      vulnerability: { name: s.vulnerability },
      products: products.map((p) => ({ '@id': p })),
      status: s.status,
    };
    if (s.justification) out.justification = s.justification;
    if (s.impact_statement) out.impact_statement = s.impact_statement;
    if (s.action_statement) out.action_statement = s.action_statement;
    return out;
  });

  return {
    '@context': OPENVEX_CONTEXT,
    '@id': opts.id ?? `https://vibgrate.com/vex/${randomUUID()}`,
    author: opts.author,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    version: 1,
    statements,
  };
}

/**
 * Reads statements from a JSON file. Accepts either a bare array of statements or
 * an object with a `statements` array (e.g. an existing OpenVEX document).
 */
async function loadStatementsFile(filePath: string): Promise<VexStatementInput[]> {
  const data = await readJsonFile<unknown>(filePath);
  const arr = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray((data as { statements?: unknown }).statements)
        ? (data as { statements: unknown[] }).statements
        : null);
  if (!arr) {
    throw new VexValidationError(
      `${filePath}: expected a JSON array of statements or an object with a "statements" array.`,
    );
  }
  return arr as VexStatementInput[];
}

function collectStatement(value: string, previous: VexStatementInput[]): VexStatementInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VexValidationError(`--statement must be a JSON object: ${value.slice(0, 60)}…`);
  }
  return [...previous, parsed as VexStatementInput];
}

export const vexCommand = new Command('vex')
  .description('Generate an OpenVEX document (exploitability statements) for attestation')
  .option('--from <file>', 'Read statements from a JSON file (array, or an object with a "statements" array)')
  .option(
    '--statement <json>',
    'Add a statement as inline JSON, e.g. \'{"vulnerability":"CVE-2024-1","status":"not_affected","justification":"vulnerable_code_not_present"}\'. Repeatable.',
    collectStatement,
    [] as VexStatementInput[],
  )
  .option('--product <ref>', 'Default product reference applied to statements without their own (e.g. an image digest)')
  .option('--author <name>', 'Document author', 'Vibgrate')
  .option('--timestamp <iso>', 'Override the document timestamp (ISO 8601) for reproducible output')
  .option('--id <uri>', 'Override the document @id (otherwise a uuid URN is generated)')
  .option('--out <file>', 'Write the document to a file (default: stdout)')
  .action(async (opts: {
    from?: string;
    statement: VexStatementInput[];
    product?: string;
    author: string;
    timestamp?: string;
    id?: string;
    out?: string;
  }) => {
    try {
      const statements: VexStatementInput[] = [];
      if (opts.from) {
        const fromPath = path.resolve(opts.from);
        if (!(await pathExists(fromPath))) {
          process.stderr.write(chalk.red(`Statements file not found: ${fromPath}\n`));
          process.exit(1);
        }
        statements.push(...(await loadStatementsFile(fromPath)));
      }
      statements.push(...opts.statement);

      const doc = buildVexDocument({
        author: opts.author,
        defaultProduct: opts.product,
        timestamp: opts.timestamp,
        id: opts.id,
        statements,
      });

      const json = JSON.stringify(doc, null, 2);
      if (opts.out) {
        await writeTextFile(path.resolve(opts.out), json + '\n');
        process.stderr.write(
          chalk.green('✔') + ` Wrote OpenVEX document (${doc.statements.length} statement(s)) to ${path.resolve(opts.out)}\n`,
        );
      } else {
        process.stdout.write(json + '\n');
      }
    } catch (err) {
      if (err instanceof VexValidationError) {
        process.stderr.write(chalk.red(`VEX validation error: ${err.message}\n`));
        process.exit(1);
      }
      throw err;
    }
  });
