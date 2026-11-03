# VG Code host UI rules (stream-json protocol v6)

How a host (the VS Code VG Code panel, or any UI driving
`vg code --stream-json`) should render a turn by default so the transcript is
quiet and decisive: a few activity lines, one Changes card, the answer. Raw
frames stay available for a debug view.

These rules apply to every backend: the native VG Code loop and an external ACP
agent (`vg code --provider grok-build`, `--acp-command`). Both emit the same
frames.

The reference implementation of these defaults is
[`host-transcript.ts`](./host-transcript.ts) (`visibleTranscript`). Tests,
`--profile`, and `scripts/parity-check.ts` use it to count visible lines.

## Default rules

1. **Collapse every tool group. Show only the `activity` line.**
   `{event:'event', type:'activity', group, final, summary, ...}` is one line
   per `group`. Draw it the first time a `group` id appears in the turn, and
   **update that line in place** on later frames with the same id. `final: true`
   closes it. Group ids restart at 1 every turn. Do not render `tool-call` /
   `tool-result` rows unless debug is on. The line can expand to show them.
2. **Always render `changes-summary` as a sticky card at the end of the turn.**
   `files[{path, added, removed, status}]`, `totalAdded`, `totalRemoved` are net
   per-file stats for the whole turn: a file edited three times is one row, and
   an edit that was reverted drops out. The engine sends it only when files
   changed, so a Q&A turn has no card.
3. **Collapse `thinking` and `progress` by default.** Show a one-line
   "Thinking…" / "Plan (3/5)" affordance that expands.
4. **Hide `notice`, `metrics`, `session-graph`, `capsule`, `capsule-delta`,
   `step`, `usage`, `checkpoint`, `compact` and `change` unless a debug toggle is
   on.** `checkpoint` still powers the Undo affordance on the Changes card. It
   just doesn't get its own row.
5. **Permission cards (`approve-request`) stay expanded and show the diff.**
   They are the governance gate, so never collapse or auto-dismiss them.
   `user-question` cards are also always shown.
6. **Assistant prose (`assistant`) is shown.** Prose closes the open activity
   group, and the engine sends the closing `activity` frame *before* the prose,
   so the line sits above the text that follows it.
7. **The answer.** `done.result.finalText` is the answer. If it matches the
   last `assistant` message already shown (a streamed prose answer), mark that
   message as the answer instead of repeating it.

## Order of the terminal frames

```
… activity(final: true) → changes-summary (if files changed) → metrics → done → [plan-ready] → idle
```

On the ACP backend the agent's final prose streams before the card
(`activity → assistant → changes-summary`). On the native backend the
`finish` summary arrives with `done` (`activity → changes-summary → done`).
Both render as activity line(s), Changes card, answer.

## Target shape

A simple edit should render as **at most 2 activity lines + 1 Changes card +
the final answer**, plus any permission cards. `--profile` prints the counts
per turn (`activity=… cards=…`), and `--profile-out` records them as JSONL.

## Compatibility

v6 is additive. A v5 host ignores `activity` / `changes-summary` and keeps
rendering raw tool rows as before. A v6 host can check
`session-start.protocolVersion >= 6` before hiding raw rows. Against an older
engine, keep the v5 rendering.
