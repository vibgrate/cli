/**
 * Vibgrate Localize — Cloud client.
 *
 * Authenticates with the same DSN the rest of the CLI uses, presented exactly as
 * the ingest path presents it, so CI configuration that already works for
 * `vg push` works here with no extra secret.
 *
 * The DSN is never logged, never echoed, and never written to the config file.
 * Errors surface the server's envelope message (which is written to be
 * actionable) rather than a status code alone.
 */
import { parseDsn } from '../push.js';
import { CliError, ExitCode } from '../../../util/exit.js';

export interface LocaleEnvelope<T> {
  data: T | null;
  meta: { requestId?: string; pagination?: { limit: number; offset: number; total: number } };
  errors: Array<{ code: string; message: string; field?: string }>;
}

export interface LocaleClient {
  workspaceId: string;
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<LocaleEnvelope<T>>;
  post<T>(path: string, body: unknown): Promise<LocaleEnvelope<T>>;
  patch<T>(path: string, body: unknown): Promise<LocaleEnvelope<T>>;
  del<T>(path: string, body?: unknown): Promise<LocaleEnvelope<T>>;
}

function buildUrl(
  scheme: string,
  host: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(`${scheme}://${host}/v1/locale${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Turn a response into an envelope, or a CliError carrying the server's guidance.
 *
 * A 402 is singled out because it is the one failure a correct, well-formed
 * request can still hit: the workspace is not on a plan that includes Cloud
 * locale features. Telling the user which local commands still work turns a dead
 * end into a next step.
 */
async function toEnvelope<T>(response: Response, url: string): Promise<LocaleEnvelope<T>> {
  let envelope: LocaleEnvelope<T> | null = null;
  const text = await response.text();
  try {
    envelope = text ? (JSON.parse(text) as LocaleEnvelope<T>) : null;
  } catch {
    envelope = null;
  }

  if (response.ok && envelope) return envelope;

  const serverMessage = envelope?.errors?.map((e) => e.message).join(' ') ?? '';
  const requestId = envelope?.meta?.requestId;
  const suffix = requestId ? ` (request ${requestId})` : '';

  if (response.status === 401) {
    throw new CliError(
      `${serverMessage || 'Authentication failed.'}${suffix}\nRun "vg login", set VIBGRATE_DSN, or pass --dsn.`,
      ExitCode.ERROR,
    );
  }
  if (response.status === 402) {
    throw new CliError(`${serverMessage || 'This feature requires a paid plan.'}${suffix}`, ExitCode.ERROR);
  }
  if (response.status === 403) {
    throw new CliError(`${serverMessage || 'Not permitted.'}${suffix}`, ExitCode.ERROR);
  }
  if (response.status === 404) {
    throw new CliError(`${serverMessage || 'Not found.'}${suffix}`, ExitCode.ERROR);
  }
  throw new CliError(
    `Vibgrate Cloud returned ${response.status} for ${new URL(url).pathname}.${suffix}` +
      (serverMessage ? `\n${serverMessage}` : ''),
    ExitCode.ERROR,
  );
}

export function createLocaleClient(dsn: string): LocaleClient {
  const parsed = parseDsn(dsn);
  if (!parsed) {
    throw new CliError(
      'Invalid DSN format.\nExpected: vibgrate+https://<key_id>:<secret>@<host>/<workspace_id>',
      ExitCode.ERROR,
    );
  }

  const request = async <T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<LocaleEnvelope<T>> => {
    const url = buildUrl(parsed.scheme, parsed.host, path, opts.query);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    const response = await fetch(url, {
      method,
      headers: {
        // Same presentation as the ingest path — see the module header.
        Authorization: `VibgrateDSN ${parsed.keyId}:${parsed.secret}`,
        'X-Vibgrate-Timestamp': String(Date.now()),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });

    return toEnvelope<T>(response, url);
  };

  return {
    workspaceId: parsed.workspaceId,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    del: (path, body) => request('DELETE', path, { body }),
  };
}
