import { c } from './output.js';
import { VERSION } from '../version.js';

/**
 * The `vg` brand banner — the same boxy robot mark and brand colours (teal/mint)
 * as the Vibgrate scanner (`vibgrate-cli/src/ui/progress.ts`), replicated here so
 * the open graph package stays standalone.
 *
 * The wordmark is stacked BELOW the mark rather than beside it: the robot's eye
 * (`◼`) and arrow (`➜`) glyphs are East-Asian "ambiguous"/wide, so terminals that
 * render them double-width make the rows unequal — text placed to their right
 * (the scanner's layout) then misaligns. Nothing sits beside the art here, so the
 * banner lines up in every terminal. Shown on `vg build` for a human at a TTY;
 * never on `--json`, `--quiet`, or under a pipe.
 */

const teal = (s: string): string => c.hex('#3FB0A4')(s);
const mint = (s: string): string => c.hex('#4FE3C1')(s);

// ── Boxy robot mark — identical glyphs/colours to the scanner's ROBOT ──
const ROBOT = [
  '   ' + teal('╭──────╮') + mint('➜'),
  '  ' + c.dim('┤') + teal('│') + ' ' + mint('◼') + '  ' + mint('◼') + ' ' + teal('│') + c.dim('├'),
  '  ' + c.dim('┤') + teal('│') + '  ' + c.dim('▁▁') + '  ' + teal('│') + c.dim('├'),
  '   ' + teal('╰──────╯'),
] as const;

/**
 * The banner as lines (no I/O) so it is unit-testable. The robot mark is a
 * self-contained block; the wordmark/tagline sit on their OWN lines beneath it
 * (never beside the variable-width glyphs), so the banner aligns in any terminal.
 */
export function logoLines(root?: string): string[] {
  return [
    '',
    `  ${ROBOT[0]}`,
    `  ${ROBOT[1]}`,
    `  ${ROBOT[2]}`,
    `  ${ROBOT[3]}`,
    `  ${c.bold.white('vibgrate')} ${teal('graph')}  ${c.dim(`· deterministic code graph · v${VERSION}`)}`,
    ...(root ? [`  ${c.dim(root)}`] : []),
    '',
  ];
}

/** Print the banner to stderr, only for an interactive human (TTY). */
export function printLogo(root?: string): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`${logoLines(root).join('\n')}\n`);
}
