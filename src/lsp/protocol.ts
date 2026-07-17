/**
 * Minimal LSP transport — JSON-RPC 2.0 over stdio with `Content-Length` framing.
 *
 * Deliberately zero-dependency. Vibgrate's whole thesis is dependency currency;
 * pulling `vscode-languageserver` (and its tree) into the published CLI to move
 * a few hundred bytes of JSON would be a poor advertisement for the product.
 * The surface we need is small and the framing is fully specified by LSP §3.
 *
 * See `docs/IDE-INTEGRATION-PLAN.md` §3.
 */

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

/** LSP error codes we actually use (LSP §3.16.1). */
export const ErrorCodes = {
  MethodNotFound: -32601,
  InternalError: -32603,
} as const;

/**
 * Reads `Content-Length`-framed JSON-RPC messages from a byte stream.
 *
 * Buffers on a Buffer (not a string) because `Content-Length` counts *bytes*,
 * not characters: a header saying 120 bytes over a body with any multi-byte
 * UTF-8 in it (a package name with a non-ASCII char, an EOL date with an
 * en-dash) would be mis-sliced by string-length accounting, and every message
 * after it in the stream would be shifted. This is the classic LSP framing bug.
 */
export class MessageReader {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns every complete message now available. */
  push(chunk: Buffer): RpcMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: RpcMessage[] = [];

    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unrecoverable: a frame with no length. Drop the header and resync
        // rather than spin forever on the same bytes.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) break; // body not fully arrived

      const body = this.buf.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + length);

      try {
        out.push(JSON.parse(body) as RpcMessage);
      } catch {
        // A malformed body is not worth killing the server over — the editor
        // will re-request. Skip it.
      }
    }

    return out;
  }
}

/** Writes `Content-Length`-framed JSON-RPC messages to a stream. */
export class MessageWriter {
  constructor(private readonly out: NodeJS.WritableStream) {}

  write(msg: RpcMessage): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.out.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.out.write(body);
  }
}

/**
 * A tiny JSON-RPC connection: dispatches requests and notifications, and lets
 * the server push notifications back to the client.
 */
export class Connection {
  private readonly reader = new MessageReader();
  private readonly writer: MessageWriter;
  private readonly requests = new Map<string, RequestHandler>();
  private readonly notifications = new Map<string, NotificationHandler>();

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.writer = new MessageWriter(output);
    input.on('data', (chunk: Buffer) => {
      for (const msg of this.reader.push(chunk)) void this.dispatch(msg);
    });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler);
  }

  /** Push a server→client notification (diagnostics, `vibgrate/score`, …). */
  notify(method: string, params: unknown): void {
    this.writer.write({ jsonrpc: '2.0', method, params });
  }

  private async dispatch(msg: RpcMessage): Promise<void> {
    if (!msg.method) return; // a response to something we sent; we send no requests

    const isRequest = msg.id !== undefined && msg.id !== null;

    if (!isRequest) {
      const handler = this.notifications.get(msg.method);
      if (handler) {
        try {
          await handler(msg.method, msg.params);
        } catch {
          // A failed notification must never take the server down: the editor
          // would show "server crashed" and the user would uninstall us.
        }
      }
      return;
    }

    const handler = this.requests.get(msg.method);
    if (!handler) {
      this.writer.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: ErrorCodes.MethodNotFound, message: `Unhandled method: ${msg.method}` },
      });
      return;
    }

    try {
      const result = await handler(msg.method, msg.params);
      this.writer.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err) {
      this.writer.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: ErrorCodes.InternalError,
          message: err instanceof Error ? err.message : 'Internal error',
        },
      });
    }
  }
}
