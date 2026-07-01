// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import chalk, { type ChalkInstance } from 'chalk';

/**
 * Smooth horizontal bars for the scanner UI.
 *
 * Two things make a terminal bar read as "smooth":
 *
 * 1. **Sub-cell resolution.** A whole-character bar can only be N states wide, so
 *    it jumps a full cell at a time. Unicode left-fractional block glyphs
 *    (`▏▎▍▌▋▊▉`) fill a cell in eighths, giving ~8× finer motion — the fill
 *    glides instead of stepping.
 * 2. **A colour gradient** across the filled region instead of one flat colour.
 *
 * Colour is applied with `chalk.hex`, which downsamples automatically on
 * 256/16-colour terminals and becomes a no-op under `NO_COLOR` / `--no-color`
 * (chalk level 0), so the bar degrades gracefully everywhere.
 */

// Left-fractional block glyphs: index 1..7 fills 1/8..7/8 of a cell from the left.
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;
const FULL = '█'; // █

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpColor(from: Rgb, to: Rgb, t: number): Rgb {
  return { r: lerp(from.r, to.r, t), g: lerp(from.g, to.g, t), b: lerp(from.b, to.b, t) };
}

function toHex({ r, g, b }: Rgb): string {
  const h = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Render a bar at 1/8-cell resolution with a left→right colour gradient across
 * the filled region. `fraction` is clamped to 0..1; `width` is the cell count.
 * The unfilled trough is a dim glyph (default a light shade block).
 */
export function gradientBar(
  fraction: number,
  width: number,
  from: Rgb,
  to: Rgb,
  troughGlyph = '░', // ░
): string {
  const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(fraction, 1)) : 0;
  const exact = clamped * width;
  const fullCells = Math.min(Math.floor(exact), width);
  const partialIdx = fullCells < width ? Math.floor((exact - fullCells) * 8) : 0;

  const colourAt = (cell: number): ChalkInstance =>
    chalk.hex(toHex(lerpColor(from, to, width > 1 ? cell / (width - 1) : 0)));

  let out = '';
  for (let i = 0; i < fullCells; i++) {
    out += colourAt(i)(FULL);
  }
  let cells = fullCells;
  if (partialIdx > 0) {
    out += colourAt(fullCells)(PARTIAL[partialIdx]!);
    cells++;
  }
  out += chalk.dim(troughGlyph.repeat(Math.max(width - cells, 0)));
  return out;
}

// ── Brand colours (docs/design logo bundle) ──
const TEAL: Rgb = { r: 0x3f, g: 0xb0, b: 0xa4 }; // #3FB0A4
const MINT: Rgb = { r: 0x4f, g: 0xe3, b: 0xc1 }; // #4FE3C1

/**
 * Live scanner progress bar — a smooth teal→mint gradient in the brand colours,
 * advancing at sub-cell resolution so it glides as the scan proceeds.
 */
export function brandProgressBar(fraction: number, width: number): string {
  return gradientBar(fraction, width, TEAL, MINT);
}

// ── Risk ramp for drift/score bars ──
const RISK_GREEN: Rgb = { r: 0x3f, g: 0xb0, b: 0x6a };
const RISK_AMBER: Rgb = { r: 0xe0, g: 0xa8, b: 0x30 };
const RISK_RED: Rgb = { r: 0xe0, g: 0x53, b: 0x53 };

/** Colour along the risk ramp: 0 → green, 50 → amber, 100 → red. */
export function riskColorAt(score: number): Rgb {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(score, 100)) : 0;
  return s <= 50
    ? lerpColor(RISK_GREEN, RISK_AMBER, s / 50)
    : lerpColor(RISK_AMBER, RISK_RED, (s - 50) / 50);
}

/**
 * Drift/score bar: fills to `score`% in a single clean risk colour (green for
 * low, amber for mid, red for high), so a healthy score reads as a short green
 * bar and a bad one as a long red bar. Returns the bar followed by the value.
 */
export function driftBar(score: number, width = 20): string {
  const value = Number.isFinite(score) ? Math.max(0, Math.min(score, 100)) : 0;
  // Solid risk colour (green→amber→red by score). Gradient-filling a single bar
  // green→red interpolates through a muddy olive midpoint, which reads as a
  // dirty band; the bar length already encodes the score, so use one clean hue.
  const colour = riskColorAt(value);
  const bar = gradientBar(value / 100, width, colour, colour);
  return `${bar} ${Math.round(value)}`;
}
