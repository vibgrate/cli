#!/usr/bin/env node
/**
 * Scripted fake ACP v1 agent, shaped like Grok Build's `grok agent stdio`
 * (vendor rails included: `_x.ai/session_notification` updates,
 * `x.ai/ask_user_question` requests, `_x.ai/interject` steer). Used by
 * src/code/acp-client.test.ts and by scripts/parity-check.ts --self-test.
 *
 * It is a SIMULATION for protocol testing — it never calls a model, and any
 * numbers measured against it describe this harness, not Grok Build.
 *
 * Usage: node fake-acp-agent.mjs <scenario.json>   (or FAKE_ACP_SCENARIO=path)
 * Optional FAKE_ACP_RECORD=<file>: append every message received (NDJSON).
 *
 * Scenario shape:
 * {
 *   "agentInfo": { "name": "fake-grok", "version": "0.0.0" },
 *   "requireAuth": false, "authMethods": [{ "id": "x", "type": "agent" }],
 *   "promptCapabilities": { "image": false },
 *   "vendorRail": false,          // send updates via _x.ai/session_notification
 *   "modes": { "currentModeId": "default", "availableModes": [{ "id": "plan", "name": "Plan" }] },
 *   "stepDelayMs": 0,             // latency before every step
 *   "exitOnPrompt": false,        // crash mid-turn (exit 3)
 *   "turns": [ { "steps": [ ... ], "stopReason": "end_turn" } ],
 *   "turnsByPrompt": [ { "match": "regex", "steps": [ ... ] } ]   // picked by prompt text first
 * }
 * Steps: message{text} · thought{text} · plan{entries} · read{id,path} ·
 *   search{id,title,output} · edit{id,path,search,replace,via:"fs"|"diff",permission} ·
 *   create{id,path,content,permission} · execute{id,command,output,permission} ·
 *   ask{question,options} · other{id,title,output} · sleep{ms} · notice{title}
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

const scenarioPath = process.argv[2] ?? process.env.FAKE_ACP_SCENARIO;
if (!scenarioPath) {
  process.stderr.write('fake-acp-agent: pass a scenario file\n');
  process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const record = process.env.FAKE_ACP_RECORD;
const cwdState = { cwd: process.cwd() };

let nextId = 1000;
const pending = new Map();
let sessionId = null;
let turnIndex = 0;
let cancelled = false;
let authed = !scenario.requireAuth;
const steers = [];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (u) => {
  if (scenario.vendorRail) send({ method: '_x.ai/session_notification', params: { sessionId, update: u } });
  else send({ method: 'session/update', params: { sessionId, update: u } });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (p) => path.resolve(cwdState.cwd, p);

async function permission(toolCall) {
  const res = await request('session/request_permission', {
    sessionId,
    toolCall,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const o = res?.outcome;
  return o?.outcome === 'selected' && (o.optionId === 'allow' || o.optionId === 'always');
}

async function runStep(step) {
  if (scenario.stepDelayMs) await sleep(scenario.stepDelayMs);
  switch (step.type) {
    case 'message':
      for (const chunk of String(step.text).match(/.{1,24}/gs) ?? []) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
      }
      return;
    case 'thought':
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.text } });
      return;
    case 'plan':
      update({ sessionUpdate: 'plan', entries: step.entries });
      return;
    case 'notice':
      update({ sessionUpdate: 'notice', severity: 'info', title: step.title });
      return;
    case 'sleep':
      await sleep(step.ms ?? 10);
      return;
    case 'read': {
      update({ sessionUpdate: 'tool_call', toolCallId: step.id, title: `Read ${step.path}`, kind: 'read', status: 'in_progress', locations: [{ path: abs(step.path) }] });
      let text = '';
      try {
        const r = await request('fs/read_text_file', { sessionId, path: abs(step.path) });
        text = r.content;
      } catch (e) {
        update({ sessionUpdate: 'tool_call_update', toolCallId: step.id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: String(e.message) } }] });
        return;
      }
      update({ sessionUpdate: 'tool_call_update', toolCallId: step.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: text.slice(0, 200) } }] });
      return;
    }
    case 'search':
    case 'other':
      update({ sessionUpdate: 'tool_call', toolCallId: step.id, title: step.title ?? 'search', ...(step.type === 'search' ? { kind: 'search' } : { kind: 'other' }), status: 'pending' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: step.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: step.output ?? '' } }] });
      return;
    case 'edit':
    case 'create': {
      let before = null;
      try {
        before = fs.readFileSync(abs(step.path), 'utf8');
      } catch {
        before = null;
      }
      const after = step.type === 'create' ? step.content : String(before ?? '').replace(step.search, step.replace);
      const diff = { type: 'diff', path: abs(step.path), oldText: before, newText: after };
      update({ sessionUpdate: 'tool_call', toolCallId: step.id, title: `Edit ${step.path}`, kind: 'edit', status: 'pending', content: [diff], locations: [{ path: abs(step.path) }], rawInput: { path: step.path } });
      if (step.permission !== false) {
        const ok = await permission({ toolCallId: step.id, title: `Edit ${step.path}`, kind: 'edit', content: [diff] });
        if (!ok) {
          update({ sessionUpdate: 'tool_call_update', toolCallId: step.id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected by user' } }] });
          return;
        }
      }
      if (step.via === 'diff') {
        // Agent writes on its own; the client only sees the diff content.
        fs.mkdirSync(path.dirname(abs(step.path)), { recursive: true });
        fs.writeFileSync(abs(step.path), after);
      } else {
        try {
          await request('fs/write_text_file', { sessionId, path: abs(step.path), content: after });
        } catch (e) {
          update({ sessionUpdate: 'tool_call_update', toolCallId: step.id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: String(e.message) } }] });
          return;
        }
      }
      update({ sessionUpdate: 'tool_call_update', toolCallId: step.id, status: 'completed', content: [diff] });
      return;
    }
    case 'execute': {
      update({ sessionUpdate: 'tool_call', toolCallId: step.id, title: `Run ${step.command}`, kind: 'execute', status: 'pending', rawInput: { command: step.command } });
      const ok = step.permission === false ? true : await permission({ toolCallId: step.id, title: `Run ${step.command}`, kind: 'execute', rawInput: { command: step.command } });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: step.id,
        status: ok ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: ok ? step.output ?? '' : 'rejected by user' } }],
      });
      return;
    }
    case 'ask': {
      const res = await request('x.ai/ask_user_question', { sessionId, question: step.question, options: step.options });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `You said: ${res?.answer ?? ''}. ` } });
      return;
    }
    default:
      return;
  }
}

async function onPrompt(id, params) {
  cancelled = false;
  if (scenario.exitOnPrompt) {
    process.stderr.write('fake-acp-agent: simulated crash\n');
    process.exit(3);
  }
  const text = (params?.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  // `turnsByPrompt: [{ match: "regex", steps, stopReason }]` picks the turn by
  // prompt text (the parity harness drives one scenario file for every prompt).
  const byPrompt = (scenario.turnsByPrompt ?? []).find((t) => new RegExp(t.match, 'i').test(text));
  const turn = byPrompt ?? scenario.turns?.[Math.min(turnIndex, (scenario.turns?.length ?? 1) - 1)] ?? { steps: [] };
  turnIndex++;
  if (/^\[The user sent this/.test(text)) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Follow-up noted.' } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  for (const step of turn.steps ?? []) {
    if (cancelled) break;
    await runStep(step);
  }
  if (steers.length) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` (steer applied: ${steers.splice(0).join('; ')})` } });
  }
  send({ id, result: { stopReason: cancelled ? 'cancelled' : turn.stopReason ?? 'end_turn' } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (record) fs.appendFileSync(record, JSON.stringify(msg) + '\n');
  if (msg.method === undefined && msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: scenario.promptCapabilities ?? { image: false } },
          authMethods: scenario.authMethods ?? [],
          agentInfo: scenario.agentInfo ?? { name: 'fake-acp-agent', version: '0.0.0' },
        },
      });
      return;
    case 'authenticate':
      authed = true;
      send({ id, result: {} });
      return;
    case 'session/new':
      if (!authed) {
        send({ id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      cwdState.cwd = params?.cwd ?? process.cwd();
      sessionId = `fake-${Date.now().toString(36)}`;
      send({ id, result: { sessionId, ...(scenario.modes ? { modes: scenario.modes } : {}) } });
      return;
    case 'session/set_mode':
      if (scenario.modes) scenario.modes.currentModeId = params?.modeId;
      send({ id, result: {} });
      return;
    case 'session/prompt':
      void onPrompt(id, params);
      return;
    case 'session/cancel':
      cancelled = true;
      return;
    case '_x.ai/interject':
      steers.push((params?.prompt ?? []).map((b) => b.text).join(' '));
      send({ id, result: {} });
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
rl.on('close', () => process.exit(0));
