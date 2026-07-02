// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import chalk, { type ChalkInstance } from 'chalk';

/**
 * Rounded, single-line section boxes for the report output.
 *
 * Light box-drawing glyphs (`╭─╮ │ ╰─╯`) read smoother than the heavy
 * double-line set (`╔═╗ ║ ╚═╝`), and the rounded corners match the scanner's
 * logo mark. The box keeps the same footprint it replaces — `width` is the
 * interior cell count between the corners, so nothing grows.
 */

// Interior width (cells between the corner glyphs) of the standard report box.
export const BOX_WIDTH = 42;

/**
 * A rounded box around a single bold title line. Returns `[top, title, bottom]`.
 * The border takes `color` (default cyan); the title is bold white, indented two
 * cells. Titles are assumed to be plain ASCII (no ANSI, width-1 glyphs).
 */
export function titleBox(
  title: string,
  color: ChalkInstance = chalk.cyan,
  width = BOX_WIDTH,
): string[] {
  const rule = (left: string, right: string): string => color(left + '─'.repeat(width) + right);
  const indent = 2;
  const fill = Math.max(width - indent - title.length, 0);
  const mid =
    color('│') + ' '.repeat(indent) + chalk.bold.white(title) + ' '.repeat(fill) + color('│');
  return [rule('╭', '╮'), mid, rule('╰', '╯')];
}

// Matches the ANSI SGR escapes chalk emits, so panel padding is computed on the
// *visible* width of a line rather than its raw length (which includes colour codes).
const ANSI_SGR = /\[[0-9;]*m/g;

/** Visible (printable) length of a string, ignoring ANSI colour escapes. */
function visibleLength(s: string): number {
  return s.replace(ANSI_SGR, '').length;
}

/**
 * A rounded, multi-line panel with the title embedded in the top border
 * (`╭─ TITLE ──…──╮`) and each body line boxed to `width` interior cells.
 * Body lines may contain ANSI colour (chalk) — padding is computed on their
 * visible width. Content wider than `width` is left unpadded rather than
 * truncated, so callers should keep lines within `width`. Use this for
 * call-out panels (e.g. the free-plan upsell) that need more than a title.
 */
export function panelBox(
  title: string,
  body: string[],
  color: ChalkInstance = chalk.cyan,
  width = BOX_WIDTH,
): string[] {
  const out: string[] = [];
  const titleSegment = ` ${title} `;
  const dashes = Math.max(width - 1 - titleSegment.length, 0);
  out.push(color('╭─') + chalk.bold.white(titleSegment) + color('─'.repeat(dashes) + '╮'));
  const indent = 1;
  for (const line of body) {
    const pad = Math.max(width - indent - visibleLength(line), 0);
    out.push(color('│') + ' '.repeat(indent) + line + ' '.repeat(pad) + color('│'));
  }
  out.push(color('╰' + '─'.repeat(width) + '╯'));
  return out;
}
