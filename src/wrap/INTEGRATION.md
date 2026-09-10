# `src/wrap` — how agent routing is driven

This directory points an AI coding agent at the local compression listener and
puts its configuration back exactly as it was. It is an **engine, not a
command**: there is no `vg wrap` verb, and there must not be one
(`docs/FEATURE-DESIGN-PRINCIPLES.md` P1 — a new top-level verb needs proof that
no existing verb family can host it, and "agent config written" is already
`vg install`'s outcome).

Two surfaces drive it, and one reverts both:

| Intent | Command | What this module does |
|---|---|---|
| Route an agent durably | `vg install <agent> --compress` | `applyProxyToAgent()` — a marker-tracked edit of the agent's own base-URL config, `.vg-backup` beside it, `durable` holder (pid 0). The command then calls `ensureBackgroundListener()` (a detached `vg serve --compress-only --compress-daemon`) and, for Claude Code at project scope, writes a SessionStart hook (`src/install/hooks.ts`) that re-runs `vg serve --compress --background` |
| Route an agent for one session | `vg serve --compress <agent>` | `wrap()` — ensure a listener (`ensureProxyRunning`, same daemon argv — see `daemonArgv()` in `src/proxy/lifecycle.ts`), set the child environment, spawn, forward signals, restore on exit |
| Start or reuse the listener alone | `vg serve --compress --background` | `ensureBackgroundListener()` — the idempotent form the hook and the installer call |
| Undo either | `vg uninstall <agent>` | `unwrap()` — restore the original bytes, skipping a file another live session still holds unless `--force` |
| See what is routed | `vg serve status` | `wrapStatus()` |
| Health rows | `vg doctor` | `wrapDiagnostics()` |

## Assistant id → routing agent

`vg install` and this module keep separate registries, and three ids are spelled
differently. `WRAP_AGENT_ALIASES` in `src/commands/install.ts` is the mapping:

```
factory     → droid
vscode      → vscode-claude   (Claude Code in VS Code; Copilot-in-VS-Code is a GUI setting)
copilot-cli → copilot
```

Everything else maps by identity, and an assistant with no entry in `AGENTS` is
reported as `unsupported` with the per-session form as the suggested fallback —
never silently skipped. A missing alias is a real bug, not a cosmetic one: it
makes a supported agent look unsupported.

## Ownership and concurrency

A durable apply is held by pid 0 and released only by `vg uninstall`. A
one-session run in the same directory inherits that routing and never reverts
it, so a durable install is not undone by an agent exiting. Two concurrent
one-session runs each own their own edits and cannot revert each other's;
`unwrap` reports a file it declined to touch rather than taking it.

## Upstream pins

An agent whose provider is not Anthropic or OpenAI (Grok, Kimi, Mistral Vibe,
Copilot, Gemini CLI, Amp) declares `proxyEnv(env)` on its spec — settings such
as `VG_PROXY_OPENAI_API_URL` or `VG_PROXY_PROVIDER` — which `wrap()` hands to
the listener it starts. They are env, not flags: `vg serve` has no per-provider
URL flags by design. A listener that is already running keeps its own
configuration, so one shared listener serves one upstream; `vg serve config
set` changes it durably.

## Config-file markers

TOML blocks are delimited by `TOML_BLOCK_BEGIN(label)` / `TOML_BLOCK_END`
(`# --- vg compression (managed by …) ---`). JSON and YAML edits record the
previous value per field so a revert is field-precise rather than a whole-file
restore. The label names the command that wrote it, e.g.
`vg install codex --compress`.

## SDK exports (`src/index.ts`)

```ts
export { wrap, unwrap, wrapStatus, wrapDiagnostics, applyProxyToAgent, AGENTS, WRAP_AGENTS, isWrapAgent, loginCopilot, copilotToken, copilotApiHost, trackUsage, windowStatus, CaptureWriter, captureExchange, readCaptureFile, compareCaptures } from './wrap/index.js';
```

## Copilot

`vg install copilot-cli --compress --login` runs the GitHub device flow before
the routing is written, so a fresh machine needs one command rather than a write
followed by an auth failure. The token is stored `0600` at
`VG_COPILOT_AUTH_FILE` and never printed. `--subscription` uses the Copilot
subscription lane (token exchange plus the API-host policy).
