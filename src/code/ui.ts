/**
 * Zero-dependency interactive UI for the `vg code` guided flow (VG-CLI-CODE §9).
 *
 * We keep the published CLI lean and install-free, so rather than pull an
 * interactive-prompt dependency we ship a small, focused prompter built on
 * `node:readline` + raw-mode keypresses: an arrow-key `select`, a text `input`,
 * a `confirm`, notes, and a `spinner` that wraps noisy child-process output
 * (e.g. an `ollama pull`) behind a single clean status line.
 *
 * Everything is behind the {@link Prompter} interface so the wizard/REPL logic
 * is driven by a scripted fake in tests — no TTY, no raw mode, fully
 * deterministic. All UI writes go to stderr, leaving stdout clean for piped
 * JSON.
 */

import * as readline from 'node:readline';
import { c } from '../util/output.js';

/** Thrown when the user cancels (Esc / Ctrl-C) so callers can exit gracefully. */
export class PromptCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PromptCancelled';
  }
}

export interface SelectChoice<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface Spinner {
  update(message: string): void;
  stop(finalMessage?: string): void;
  fail(message: string): void;
}

/** The interactive surface the wizard/REPL depend on (injectable for tests). */
export interface Prompter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string): void;
  select<T>(message: string, choices: SelectChoice<T>[]): Promise<T>;
  input(message: string, opts?: { default?: string; placeholder?: string }): Promise<string>;
  confirm(message: string, def?: boolean): Promise<boolean>;
  spinner(message: string): Spinner;
}

const teal = (s: string): string => c.hex('#3FB0A4')(s);
const mint = (s: string): string => c.hex('#4FE3C1')(s);
const err = (s: string): void => {
  process.stderr.write(s);
};

/** The real terminal prompter. Only used at an interactive TTY. */
export class TtyPrompter implements Prompter {
  intro(message: string): void {
    err(`\n${mint('◆')} ${c.bold(message)}\n`);
  }
  outro(message: string): void {
    err(`${mint('◇')} ${message}\n\n`);
  }
  note(message: string): void {
    err(`${c.dim('│')} ${message}\n`);
  }

  async select<T>(message: string, choices: SelectChoice<T>[]): Promise<T> {
    if (choices.length === 0) throw new Error('select called with no choices');
    err(`${teal('?')} ${c.bold(message)} ${c.dim('(↑/↓, Enter)')}\n`);
    const stdin = process.stdin;
    const canRaw = typeof stdin.setRawMode === 'function' && stdin.isTTY;
    // Without a raw-capable TTY, fall back to a numbered prompt.
    if (!canRaw) return this.numberedSelect(message, choices);

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    let index = 0;
    const render = (first = false): void => {
      if (!first) err(`\x1b[${choices.length}A`); // cursor up N lines
      for (let i = 0; i < choices.length; i++) {
        const active = i === index;
        const pointer = active ? mint('❯') : ' ';
        const label = active ? c.bold(choices[i].label) : choices[i].label;
        const hint = choices[i].hint ? c.dim(`  ${choices[i].hint}`) : '';
        err(`\x1b[2K${pointer} ${label}${hint}\n`);
      }
    };
    render(true);
    return new Promise<T>((resolve, reject) => {
      const onKey = (_str: string, key: readline.Key): void => {
        if (!key) return;
        if (key.name === 'up' || (key.name === 'k' && !key.ctrl)) {
          index = (index - 1 + choices.length) % choices.length;
          render();
        } else if (key.name === 'down' || (key.name === 'j' && !key.ctrl)) {
          index = (index + 1) % choices.length;
          render();
        } else if (key.name === 'return' || key.name === 'enter') {
          cleanup();
          err(`${teal('✔')} ${c.dim(choices[index].label)}\n`);
          resolve(choices[index].value);
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          cleanup();
          reject(new PromptCancelled());
        }
      };
      const cleanup = (): void => {
        stdin.removeListener('keypress', onKey);
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
        stdin.pause();
      };
      stdin.on('keypress', onKey);
    });
  }

  /** Numbered fallback when raw mode isn't available (e.g. a dumb terminal). */
  private async numberedSelect<T>(message: string, choices: SelectChoice<T>[]): Promise<T> {
    for (let i = 0; i < choices.length; i++) {
      err(`  ${c.bold(String(i + 1))}. ${choices[i].label}${choices[i].hint ? c.dim(`  ${choices[i].hint}`) : ''}\n`);
    }
    for (;;) {
      const answer = await this.input(`${message} — number`);
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
      this.note(c.yellow(`enter 1–${choices.length}`));
    }
  }

  input(message: string, opts: { default?: string; placeholder?: string } = {}): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const suffix = opts.default ? c.dim(` (${opts.default})`) : opts.placeholder ? c.dim(` (${opts.placeholder})`) : '';
    return new Promise((resolve) => {
      rl.question(`${teal('?')} ${c.bold(message)}${suffix} `, (answer) => {
        rl.close();
        const trimmed = answer.trim();
        resolve(trimmed || opts.default || '');
      });
    });
  }

  async confirm(message: string, def = false): Promise<boolean> {
    const answer = await this.input(`${message} ${c.dim(def ? '[Y/n]' : '[y/N]')}`);
    if (!answer) return def;
    return /^y(es)?$/i.test(answer.trim());
  }

  spinner(message: string): Spinner {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    let current = message;
    const active = process.stderr.isTTY;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (active) {
      timer = setInterval(() => {
        err(`\x1b[2K\r${teal(frames[(i = (i + 1) % frames.length)])} ${current}`);
      }, 80);
      timer.unref?.();
    } else {
      err(`${current}\n`);
    }
    const clear = (): void => {
      if (timer) clearInterval(timer);
      if (active) err(`\x1b[2K\r`);
    };
    return {
      update(m) {
        current = m;
      },
      stop(finalMessage) {
        clear();
        if (finalMessage) err(`${teal('✔')} ${finalMessage}\n`);
      },
      fail(m) {
        clear();
        err(`${c.red('✗')} ${m}\n`);
      },
    };
  }
}
