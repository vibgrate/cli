/**
 * Process-isolation llm-host: client + server over a Unix/local socket.
 *
 * Management (Code Modes, fit, packs, install) stays in vgd / the CLI.
 * This process only loads weights and decodes (ADR-005).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { generateWithLlamaBinding } from './binding.js';
import { acquireHostSession, generateOnSession } from './session.js';
import type {
  LlmChatMessage,
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmHost,
  LlmMemoryReport,
} from './types.js';

export const LLM_HOST_IPC_SCHEMA = 'llm-host-ipc/0' as const;

export type LlmHostIpcRequest =
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; op: 'load'; modelRef: string }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; op: 'unload' }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; op: 'generate'; messages: LlmChatMessage[]; opts?: LlmGenerateOptions }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; op: 'memory' }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; op: 'capabilities' }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; op: 'ping' };

export type LlmHostIpcResponse =
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; ok: true; op: 'load' | 'unload' | 'ping' }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; ok: true; op: 'generate'; result: LlmGenerateResult }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; ok: true; op: 'memory'; report: LlmMemoryReport }
  | {
      v: typeof LLM_HOST_IPC_SCHEMA;
      id: string;
      ok: true;
      op: 'capabilities';
      constrainedDecoding: boolean;
      isolation: 'process';
    }
  | { v: typeof LLM_HOST_IPC_SCHEMA; id: string; ok: false; error: string };

/** Request body without envelope — distribute Omit over the union (keyof union is only common keys). */
export type LlmHostIpcBody = LlmHostIpcRequest extends infer R
  ? R extends { v: typeof LLM_HOST_IPC_SCHEMA; id: string }
    ? Omit<R, 'v' | 'id'>
    : never
  : never;

export interface ProcessHostServerOptions {
  socketPath: string;
  /** node-llama-cpp module (optional until first generate). */
  binding?: unknown;
  onListen?: (socketPath: string) => void;
}

/**
 * Serve llm-host IPC on a local socket. Resolves when the server is listening;
 * call the returned `close` to stop.
 */
export function startProcessHostServer(options: ProcessHostServerOptions): Promise<{ close: () => Promise<void> }> {
  const state = {
    modelRef: null as string | null,
    loaded: false,
    binding: options.binding ?? null,
  };

  try {
    if (fs.existsSync(options.socketPath)) fs.unlinkSync(options.socketPath);
  } catch {
    /* ignore */
  }
  fs.mkdirSync(path.dirname(options.socketPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          void handleLine(line, state, (resp) => {
            socket.write(`${JSON.stringify(resp)}\n`);
          });
        }
      });
    });

    server.once('error', reject);
    server.listen(options.socketPath, () => {
      options.onListen?.(options.socketPath);
      resolve({
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => {
              try {
                if (fs.existsSync(options.socketPath)) fs.unlinkSync(options.socketPath);
              } catch {
                /* ignore */
              }
              if (err) rej(err);
              else res();
            });
          }),
      });
    });
  });
}

/** Attach binding after server start (e.g. after ensurePackage). */
export type ProcessHostState = {
  modelRef: string | null;
  loaded: boolean;
  binding: unknown | null;
};

async function handleLine(
  line: string,
  state: ProcessHostState,
  reply: (r: LlmHostIpcResponse) => void,
): Promise<void> {
  let req: LlmHostIpcRequest;
  try {
    req = JSON.parse(line) as LlmHostIpcRequest;
  } catch {
    reply({ v: LLM_HOST_IPC_SCHEMA, id: '?', ok: false, error: 'invalid JSON' });
    return;
  }
  if (req.v !== LLM_HOST_IPC_SCHEMA) {
    reply({ v: LLM_HOST_IPC_SCHEMA, id: req.id, ok: false, error: `unsupported schema ${String((req as { v?: string }).v)}` });
    return;
  }

  try {
    switch (req.op) {
      case 'ping':
        reply({ v: LLM_HOST_IPC_SCHEMA, id: req.id, ok: true, op: 'ping' });
        return;
      case 'load':
        state.modelRef = req.modelRef;
        state.loaded = true;
        reply({ v: LLM_HOST_IPC_SCHEMA, id: req.id, ok: true, op: 'load' });
        return;
      case 'unload':
        state.modelRef = null;
        state.loaded = false;
        reply({ v: LLM_HOST_IPC_SCHEMA, id: req.id, ok: true, op: 'unload' });
        return;
      case 'memory':
        reply({
          v: LLM_HOST_IPC_SCHEMA,
          id: req.id,
          ok: true,
          op: 'memory',
          report: { isolation: 'process', modelRef: state.modelRef, loaded: state.loaded },
        });
        return;
      case 'capabilities':
        reply({
          v: LLM_HOST_IPC_SCHEMA,
          id: req.id,
          ok: true,
          op: 'capabilities',
          constrainedDecoding: state.binding != null,
          isolation: 'process',
        });
        return;
      case 'generate': {
        if (!state.loaded || !state.modelRef) {
          reply({ v: LLM_HOST_IPC_SCHEMA, id: req.id, ok: false, error: 'no model loaded' });
          return;
        }
        if (!state.binding) {
          reply({
            v: LLM_HOST_IPC_SCHEMA,
            id: req.id,
            ok: false,
            error: 'binding not loaded in host process — start host after vg models install',
          });
          return;
        }
        // Same warm session path as embedded (Approach B parity for enterprise isolation).
        let result: LlmGenerateResult;
        try {
          const session = await acquireHostSession(state.binding, state.modelRef);
          const report = await generateOnSession(session, req.messages, {
            grammar: req.opts?.grammar,
            requireGrammar: req.opts?.requireGrammar,
            identifierTrie: req.opts?.identifierTrie,
            annotateUnknownIdentifiers: req.opts?.annotateUnknownIdentifiers,
            draftCandidates: req.opts?.draftCandidates,
            maxTokens: req.opts?.maxTokens,
            temperature: req.opts?.temperature,
            promptSegments: req.opts?.promptSegments,
          });
          result = {
            text: report.text,
            model: state.modelRef,
            isolation: 'process',
            constrained: report.constrained,
            unknownIdentifiers: report.unknownIdentifiers,
          };
        } catch {
          const text = await generateWithLlamaBinding({
            lib: state.binding,
            modelPath: state.modelRef,
            messages: req.messages,
            opts: req.opts,
          });
          result = {
            text,
            model: state.modelRef,
            isolation: 'process',
            constrained: !!(req.opts?.grammar && state.binding),
          };
        }
        reply({ v: LLM_HOST_IPC_SCHEMA, id: req.id, ok: true, op: 'generate', result });
        return;
      }
      default:
        reply({ v: LLM_HOST_IPC_SCHEMA, id: (req as { id: string }).id, ok: false, error: 'unknown op' });
    }
  } catch (e) {
    reply({
      v: LLM_HOST_IPC_SCHEMA,
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Client: full {@link LlmHost} over the process socket. */
export class ProcessLlmHost implements LlmHost {
  readonly isolation = 'process' as const;
  private seq = 0;

  constructor(private readonly socketPath: string) {}

  getEndpoint(): string {
    return this.socketPath;
  }

  supportsConstrainedDecoding(): boolean {
    return true; // host may apply grammar when binding is present
  }

  async load(modelRef: string): Promise<void> {
    await this.rpc({ op: 'load', modelRef });
  }

  async unload(): Promise<void> {
    await this.rpc({ op: 'unload' });
  }

  async generate(messages: LlmChatMessage[], opts?: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const res = await this.rpc({ op: 'generate', messages, opts });
    if (!res.ok || res.op !== 'generate') {
      throw new Error(!res.ok ? res.error : 'unexpected response');
    }
    return res.result;
  }

  memoryReport(): LlmMemoryReport {
    // Sync surface required by LlmHost; use last known or empty (async memory via rpc elsewhere).
    return { isolation: 'process', modelRef: null, loaded: false };
  }

  async memoryReportAsync(): Promise<LlmMemoryReport> {
    const res = await this.rpc({ op: 'memory' });
    if (!res.ok || res.op !== 'memory') {
      throw new Error(!res.ok ? res.error : 'unexpected response');
    }
    return res.report;
  }

  private rpc(body: LlmHostIpcBody): Promise<LlmHostIpcResponse> {
    const id = `r${++this.seq}`;
    const req = { v: LLM_HOST_IPC_SCHEMA, id, ...body } as LlmHostIpcRequest;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`llm-host IPC timeout (${this.socketPath})`));
      }, 120_000);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(`${JSON.stringify(req)}\n`);
      });
      socket.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl).trim();
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(line) as LlmHostIpcResponse);
        } catch (e) {
          reject(e);
        }
      });
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

/** @deprecated use ProcessLlmHost */
export class ProcessBridgeLlmHost extends ProcessLlmHost {}
