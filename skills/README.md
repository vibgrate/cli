# Vibgrate CLI skills for AI agents

A **skill** is a ready-made instruction file (plus local MCP wiring) that teaches
an AI coding assistant to use the `vg` code graph instead of grepping or reading
many files — cheaper, more relevant context.

You don't write these by hand. One command installs them:

```bash
vg install --all          # every supported assistant
vg install claude         # or one at a time
vg install --list         # show the support matrix
vg uninstall claude       # remove (add --purge to delete the skill file)
```

Each install is idempotent and repo-local (team-shareable). It writes:

1. A **skill file** (`SKILL.md`) — see [`vg/SKILL.md`](./vg/SKILL.md) for the
   canonical content.
2. A **local MCP server** registration (`vg serve`, [Vibgrate AI Context](https://vibgrate.com/library))
   where the assistant supports it — read-only, auto-approvable tools.
3. An **advisory nudge** in the assistant's instructions file (opt-out, never
   "mandatory").

## Supported assistants

| id | Assistant | Skill | MCP | Nudge |
| --- | --- | :---: | :---: | :---: |
| `claude` | Claude Code | ✓ | ✓ | ✓ |
| `cursor` | Cursor | — | ✓ | ✓ |
| `windsurf` | Windsurf | — | ✓ | ✓ |
| `vscode` | VS Code (Copilot Chat) | — | ✓ | ✓ |
| `codex` | Codex | ✓ | — | ✓ |
| `gemini` | Gemini CLI | ✓ | — | ✓ |
| `opencode` | OpenCode | ✓ | — | ✓ |
| `kilo` | Kilo Code | ✓ | — | ✓ |
| `aider` | Aider | ✓ | — | ✓ |
| `factory` | Factory Droid | ✓ | — | ✓ |
| `trae` | Trae | ✓ | — | ✓ |
| `kiro` | Kiro | ✓ | — | ✓ |
| `amp` | Amp | ✓ | — | ✓ |
| `kimi` | Kimi Code | ✓ | — | ✓ |
| `codebuddy` | CodeBuddy | ✓ | — | ✓ |
| `copilot-cli` | GitHub Copilot CLI | ✓ | — | ✓ |
| `pi` | Pi | ✓ | — | ✓ |
| `devin` | Devin CLI | ✓ | — | ✓ |
| `hermes` | Hermes | ✓ | — | ✓ |
| `openclaw` | OpenClaw | ✓ | — | ✓ |
| `agents` | Agent-Skills (generic) | ✓ | — | ✓ |

MCP registration for the skill-only assistants is added as their formats
stabilise; the skill + nudge work today. Run `vg install --list` for the live
matrix.

The canonical skill content is generated from
[`src/install/content.ts`](../src/install/content.ts) so the published file and
the installed file never drift. See also the
[skills page](https://vibgrate.com/skills).
