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
