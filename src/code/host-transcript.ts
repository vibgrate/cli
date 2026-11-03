/**
 * Reference model of the DEFAULT host transcript (HOST_UI.md rules, protocol v6).
 *
 * Given the NDJSON lines a `vg code --stream-json` run wrote, this computes
 * what a host following HOST_UI.md shows with no debug toggle on: one line per
 * activity group, the Changes card, assistant prose, permission / question
 * cards, errors and the final answer — and nothing else. It exists so "the
 * transcript is quiet" is a measured number (tests, `--profile`, the parity
 * harness) rather than a screenshot judgement.
 *
 * Pure: no I/O, no clock.
 */

export type VisibleKind = 'activity' | 'changes' | 'message' | 'answer' | 'permission' | 'question' | 'error';

export interface VisibleItem {
  kind: VisibleKind;
  text: string;
}

export interface VisibleTranscript {
  items: VisibleItem[];
  /** Distinct activity lines (groups) across all turns. */
  activityLines: number;
  /** Changes cards shown. */
  changesCards: number;
  /** Permission cards shown. */
  permissionCards: number;
  /** The last turn's final answer text ('' when the turn produced none). */
  answer: string;
  /** Lines a host hides by default, by event type (raw tool rows, thinking, …). */
  hidden: Record<string, number>;
}

type Line = Record<string, unknown>;

/** Collapse whitespace so "same answer" comparisons ignore reflow. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function visibleTranscript(lines: readonly Line[]): VisibleTranscript {
  const items: VisibleItem[] = [];
  const hidden: Record<string, number> = {};
  /** turn:group → index into items, so later frames update the line in place. */
  const activityIndex = new Map<string, number>();
  let turn = 0;
  let lastMessage = '';
  let answer = '';
  let changesCards = 0;
  let permissionCards = 0;

  const hide = (key: string): void => {
    hidden[key] = (hidden[key] ?? 0) + 1;
  };

  for (const line of lines) {
    const ev = String(line.event ?? '');
    if (ev === 'event') {
      const type = String(line.type ?? '');
      if (type === 'activity') {
        const key = `${turn}:${String(line.group ?? 0)}`;
        const text = String(line.summary ?? '');
        const at = activityIndex.get(key);
        if (at === undefined) {
          activityIndex.set(key, items.length);
          items.push({ kind: 'activity', text });
        } else {
          items[at] = { kind: 'activity', text };
        }
        continue;
      }
      if (type === 'changes-summary') {
        const files = Array.isArray(line.files) ? (line.files as Array<{ path?: unknown }>) : [];
        changesCards++;
        items.push({
          kind: 'changes',
          text: `${files.length} file(s) · +${Number(line.totalAdded ?? 0)} −${Number(line.totalRemoved ?? 0)}`,
        });
        continue;
      }
      if (type === 'assistant') {
        const text = String(line.text ?? '').trim();
        if (text) {
          items.push({ kind: 'message', text });
          lastMessage = text;
        }
        continue;
      }
      hide(type || 'unknown');
      continue;
    }
    if (ev === 'approve-request') {
      permissionCards++;
      const action = (line.action ?? {}) as Record<string, unknown>;
      items.push({ kind: 'permission', text: String(action.kind ?? 'action') });
      continue;
    }
    if (ev === 'user-question') {
      items.push({ kind: 'question', text: String(line.question ?? '') });
      continue;
    }
    if (ev === 'error') {
      items.push({ kind: 'error', text: String(line.message ?? '') });
      turn++;
      continue;
    }
    if (ev === 'done') {
      const result = (line.result ?? {}) as { finalText?: unknown };
      const finalText = typeof result.finalText === 'string' ? result.finalText.trim() : '';
      answer = finalText;
      // A prose answer already streamed as an `assistant` message is not shown
      // twice: that message becomes the answer, where it already sits.
      if (finalText && lastMessage && norm(finalText) === norm(lastMessage)) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === 'message' && norm(items[i].text) === norm(finalText)) {
            items[i] = { kind: 'answer', text: items[i].text };
            break;
          }
        }
      } else if (finalText) {
        items.push({ kind: 'answer', text: finalText });
      }
      lastMessage = '';
      turn++;
      continue;
    }
    hide(ev || 'unknown');
  }

  return {
    items,
    activityLines: activityIndex.size,
    changesCards,
    permissionCards,
    answer,
    hidden,
  };
}
