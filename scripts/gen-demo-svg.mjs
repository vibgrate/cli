#!/usr/bin/env node
// Generate docs/demo/cli-demo.svg — an animated terminal replay of `vg scan`
// that plays automatically on GitHub (and npm shows the first frame).
//
// The replay reads like a real session:
//   1. the command is typed in character by character, with a brief pause and a
//      blinking cursor before "enter";
//   2. the `vg` brand banner (the same boxy robot mark as src/util/logo.ts) and
//      the scan output print quickly;
//   3. the viewport scrolls up as output streams, settling on the drift-score
//      result so the payoff is what you're left looking at.
//
// Why an animated SVG instead of a GIF: it is tiny, crisp at any zoom,
// text-selectable, dark-mode friendly, and — like everything else here —
// deterministic and regenerable. The frames below are a curated snapshot of the
// canonical `node-turborepo/scan` simulator scenario, so the demo stays faithful
// to real `vg` output. Re-run `node scripts/gen-demo-svg.mjs` after editing.
//
// No external dependencies, no network, no randomness, no Date.now().

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'docs', 'demo', 'cli-demo.svg');

// --- palette (GitHub-dark friendly) ---------------------------------------
const COLORS = {
  def: '#c9d1d9',
  dim: '#6e7681',
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
  cyan: '#39c5cf',
  white: '#ffffff',
  teal: '#3FB0A4', // brand teal (matches src/util/logo.ts)
  mint: '#4FE3C1', // brand mint (matches src/util/logo.ts)
  cmd: '#e6edf3',
};

// A line is a list of [style, text] segments. style = colour name from COLORS,
// optionally suffixed with ' b' (bold) and/or ' u' (underline).
const s = (style, text) => [style, text];
const line = (...segs) => segs;
const blank = () => [];

const step = (label, detail) =>
  line(s('green', '✔'), s('def', ' ' + label.padEnd(24)), s('dim', detail));

// The `vg` brand banner — same glyphs/colours as src/util/logo.ts (robot mark
// with the wordmark stacked beneath it).
const LOGO = [
  line(s('teal', '   ╭──────╮'), s('mint', '➜')),
  line(s('dim', '  ┤'), s('teal', '│'), s('def', ' '), s('mint', '◼'), s('def', '  '), s('mint', '◼'), s('def', ' '), s('teal', '│'), s('dim', '├')),
  line(s('dim', '  ┤'), s('teal', '│'), s('def', '  '), s('dim', '▁▁'), s('def', '  '), s('teal', '│'), s('dim', '├')),
  line(s('teal', '   ╰──────╯')),
  line(s('white b', '  vibgrate'), s('teal', ' graph'), s('dim', '  · deterministic code graph')),
];

// Index 1 is the command line; the typewriter + cursor anchor to it.
const CMD = 'npx @vibgrate/cli scan';
const FRAMES = [
  line(s('dim', '~/vibgrate-demos/node-turborepo')),
  line(s('dim', '$ '), s('cmd b', CMD)),
  blank(),
  ...LOGO,
  blank(),
  step('Discovering workspace', '56 files · 27 dirs'),
  step('Indexing files', '56 files indexed'),
  step('Found Node projects', '9 projects'),
  step('Computing drift score', '74/100 — high risk'),
  step('Building code map', '208 nodes · 293 edges'),
  line(s('dim', '  9 scanners completed in 27.3s')),
  blank(),
  line(s('cyan b', '╔══════════════════════════════════════════╗')),
  line(s('cyan b', '║        Drift Score Summary               ║')),
  line(s('cyan b', '╚══════════════════════════════════════════╝')),
  blank(),
  line(s('def b', '  Drift Score:  '), s('red b', '74/100')),
  line(s('def b', '  Risk Level:   '), s('red b', ' HIGH ')),
  line(s('def b', '  Projects:     '), s('def', '9')),
  blank(),
  line(s('def b u', '  Score Breakdown')),
  line(s('def', '    Runtime:      '), s('red', '████████████████████'), s('def', ' 100')),
  line(s('def', '    Frameworks:   '), s('yellow', '█████████'), s('dim', '░░░░░░░░░░░'), s('def', '  44')),
  line(s('def', '    Dependencies: '), s('red', '██████████████████'), s('dim', '░░'), s('def', '  88')),
  line(s('def', '    EOL Risk:     '), s('red', '████████████████████'), s('def', ' 100')),
  blank(),
  line(s('def b u', '  Top Priority Actions')),
  line(s('cyan b', '  1.'), s('def b', ' Upgrade EOL runtime in node-turborepo')),
  line(s('dim', '     >=18.0.0 → 24.0.0 (6 majors behind)   '), s('green', '−10 drift points')),
  line(s('cyan b', '  2.'), s('def b', ' Upgrade Vite 5.4.21 → 8.1.1 in @repo/admin (+2 more)')),
  line(s('dim', '     3 major versions behind               '), s('green', '−5–15 drift points')),
  blank(),
  line(s('mint', '  ◆ '), s('white b', 'Get AI-aware answers in your editor')),
  line(s('teal', '    vg install --all')),
];

// --- geometry -------------------------------------------------------------
const FONT = 13;
const LH = 18;
const PAD_X = 16;
const TITLEBAR = 30;
const PAD_TOP = 10;
const VIS_ROWS = 18; // visible terminal rows (the viewport)
const CHAR_W = 7.81; // advance for 13px monospace; textLength snaps each line to this grid

const lineChars = (segs) => segs.reduce((n, [, t]) => n + t.length, 0);
const COLS = Math.max(...FRAMES.map(lineChars), 48);
const WIDTH = Math.ceil(PAD_X * 2 + COLS * CHAR_W);
const VIEW_H = VIS_ROWS * LH;
const CONTENT_TOP = TITLEBAR + PAD_TOP;
const HEIGHT = CONTENT_TOP + VIEW_H + PAD_TOP;

// --- timing (seconds) -----------------------------------------------------
const T_TYPE_START = 0.35;
const TYPE_DUR = 1.5;                       // command types in
const T_TYPE_END = T_TYPE_START + TYPE_DUR; // 1.85
const PAUSE = 0.85;                          // slight pause before "enter"
const T_ENTER = T_TYPE_END + PAUSE;         // 2.7
const T_LOGO_STEP = 0.1;                     // logo lines linger a beat
const T_OUT_STEP = 0.06;                     // output prints fast
const HOLD = 2.6;                            // hold on the result

// reveal time per line
const reveals = new Array(FRAMES.length);
reveals[0] = 0.12;                 // cwd / prompt appears first
reveals[1] = T_TYPE_START;         // command (typed via clip)
let t = T_ENTER;
const LOGO_START = 3;
const LOGO_END = 3 + LOGO.length;  // exclusive
for (let i = 2; i < FRAMES.length; i++) {
  reveals[i] = t;
  t += i >= LOGO_START && i < LOGO_END ? T_LOGO_STEP : T_OUT_STEP;
}
const CYCLE = +(reveals[FRAMES.length - 1] + HOLD).toFixed(2);

const pct = (sec) => +((sec / CYCLE) * 100).toFixed(3);
const scrollLines = (i) => Math.max(0, i - (VIS_ROWS - 1));
const FINAL_DY = -scrollLines(FRAMES.length - 1) * LH;

const xml = (str) =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (style) => COLORS[style.split(' ')[0]] || COLORS.def;
const weight = (style) => (style.split(' ').includes('b') ? '700' : '400');
const deco = (style) => (style.split(' ').includes('u') ? 'underline' : 'none');

// render one line's segments as flowing tspans, snapped to the monospace grid
const tspansFor = (segs) =>
  segs
    .map(
      ([style, text]) =>
        `<tspan fill="${fill(style)}" font-weight="${weight(style)}" text-decoration="${deco(
          style
        )}">${xml(text)}</tspan>`
    )
    .join('');
const gridAttr = (segs) => {
  const n = lineChars(segs);
  return n ? ` textLength="${(n * CHAR_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : '';
};

// --- build line groups + per-line reveal keyframes ------------------------
const groups = [];
const keyframes = [];
const promptPx = PAD_X + 2 * CHAR_W; // after "$ "
const cmdPx = CMD.length * CHAR_W;

FRAMES.forEach((segs, i) => {
  const y = i * LH + FONT;
  const p = pct(reveals[i]);
  const p0 = Math.max(0, +(p - 0.01).toFixed(3));
  keyframes.push(`.l${i}{opacity:0;animation:l${i} ${CYCLE}s infinite}@keyframes l${i}{0%,${p0}%{opacity:0}${p}%,100%{opacity:1}}`);

  if (i === 1) {
    // command line: static "$ " + typewriter-clipped command text
    groups.push(
      `<g class="l1">` +
        `<text x="${PAD_X}" y="${y}" xml:space="preserve" textLength="${(2 * CHAR_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs"><tspan fill="${COLORS.dim}">$ </tspan></text>` +
        `<g clip-path="url(#typeclip)"><text x="${promptPx.toFixed(1)}" y="${y}" xml:space="preserve" textLength="${cmdPx.toFixed(1)}" lengthAdjust="spacingAndGlyphs"><tspan fill="${COLORS.cmd}" font-weight="700">${xml(CMD)}</tspan></text></g>` +
        `</g>`
    );
  } else {
    groups.push(`<g class="l${i}"><text x="${PAD_X}" y="${y}" xml:space="preserve"${gridAttr(segs)}>${tspansFor(segs)}</text></g>`);
  }
});

// --- scroll keyframes: hold at top through type+pause, then track output ---
const scrollStops = [`0%{transform:translateY(0)}`, `${pct(T_ENTER)}%{transform:translateY(0)}`];
let lastDy = 0;
for (let i = 2; i < FRAMES.length; i++) {
  const dy = -scrollLines(i) * LH;
  if (dy !== lastDy) {
    scrollStops.push(`${pct(reveals[i])}%{transform:translateY(${dy}px)}`);
    lastDy = dy;
  }
}
scrollStops.push(`100%{transform:translateY(${FINAL_DY}px)}`);
keyframes.push(`.scroll{animation:scroll ${CYCLE}s linear infinite}@keyframes scroll{${scrollStops.join('')}}`);

// --- typewriter clip width (steps → char-by-char) -------------------------
const tStart = pct(T_TYPE_START);
const tEnd = pct(T_TYPE_END);
keyframes.push(
  `#typeclip rect{animation:type ${CYCLE}s steps(${CMD.length},end) infinite}` +
    `@keyframes type{0%,${tStart}%{width:0}${tEnd}%,100%{width:${cmdPx.toFixed(1)}px}}`
);

// --- block cursor: appears at full command, blinks during the pause, gone after enter
const cursorX = promptPx + cmdPx;
const pTypeEnd = pct(T_TYPE_END);
const pEnter = pct(T_ENTER);
const span = pEnter - pTypeEnd;
const at = (f) => (pTypeEnd + span * f).toFixed(3);
keyframes.push(
  `.cur{opacity:0;animation:cur ${CYCLE}s infinite}` +
    `@keyframes cur{0%,${pTypeEnd}%{opacity:0}` +
    `${at(0.02)}%,${at(0.32)}%{opacity:1}${at(0.34)}%,${at(0.62)}%{opacity:0}` +
    `${at(0.64)}%,${at(0.96)}%{opacity:1}${at(0.98)}%,100%{opacity:0}}`
);

const css = `
.term{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px}
${keyframes.join('\n')}
`.trim();

const cmdBaselineY = 1 * LH + FONT;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Animated terminal replay: typing 'npx @vibgrate/cli scan', then the Vibgrate banner and scan output print and scroll up to a 74/100 drift score with a score breakdown and ranked upgrade priorities.">
<title>vibgrate CLI — vg scan demo</title>
<style>${css}</style>
<defs>
<clipPath id="typeclip"><rect x="${promptPx.toFixed(1)}" y="${1 * LH}" width="0" height="${LH}"/></clipPath>
<clipPath id="viewport"><rect x="0" y="${CONTENT_TOP}" width="${WIDTH}" height="${VIEW_H}"/></clipPath>
</defs>
<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${TITLEBAR}" rx="10" fill="#161b22"/>
<rect x="0.5" y="${TITLEBAR - 10}" width="${WIDTH - 1}" height="10" fill="#161b22"/>
<circle cx="18" cy="15" r="5" fill="#ff5f56"/>
<circle cx="36" cy="15" r="5" fill="#ffbd2e"/>
<circle cx="54" cy="15" r="5" fill="#27c93f"/>
<text x="${WIDTH / 2}" y="19" text-anchor="middle" fill="#7d8590" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11">vibgrate — vg scan</text>
<g clip-path="url(#viewport)">
<g transform="translate(0,${CONTENT_TOP})">
<g class="scroll">
<g class="term" fill="${COLORS.def}">
${groups.join('\n')}
<rect class="cur" x="${(cursorX + 1).toFixed(1)}" y="${cmdBaselineY - FONT + 2}" width="${(CHAR_W - 1).toFixed(1)}" height="${FONT}" fill="${COLORS.mint}"/>
</g>
</g>
</g>
</g>
</svg>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}  (${WIDTH}×${HEIGHT}, cycle ${CYCLE}s, ${FRAMES.length} lines, ${VIS_ROWS} visible)`);
