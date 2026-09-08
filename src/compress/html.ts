/**
 * HTML → readable text. Content extraction, not token-level compression:
 * scripts, styles, comments, `<head>`, navigation / header / footer / aside /
 * form boilerplate are removed; the main region (`<main>` / `<article>` /
 * `<body>`) is rendered to a markdown-ish text with headings, list items,
 * links (`[text](href)`) and tables (`| a | b |`) preserved. Entities are
 * decoded. Tolerant single-pass tokenizer — never throws on broken markup.
 */

import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export interface HtmlExtractorConfig {
  includeLinks: boolean;
  includeImages: boolean;
  includeTables: boolean;
  /** Keep only `<main>`/`<article>` when present. */
  favorMainContent: boolean;
}

export const DEFAULT_HTML_CONFIG: Readonly<HtmlExtractorConfig> = { includeLinks: true, includeImages: false, includeTables: true, favorMainContent: true };

const SKIP_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'head', 'iframe', 'object', 'embed', 'video', 'audio', 'map']);
const BOILERPLATE_ELEMENTS = new Set(['nav', 'header', 'footer', 'aside', 'form', 'menu', 'dialog']);
const BLOCK_ELEMENTS = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'li', 'tr', 'table', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'dt', 'dd', 'dl', 'figure', 'figcaption', 'address', 'details', 'summary', 'body', 'html', 'thead', 'tbody', 'tfoot', 'caption', 'option']);
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', deg: '°', euro: '€', pound: '£', yen: '¥', times: '×' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? m;
  });
}

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!(?:doctype|DOCTYPE)[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;

function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

export interface HtmlExtraction {
  text: string;
  title?: string;
  links: number;
  tables: number;
  usedMainContent: boolean;
}

/** Extract readable text from HTML. Empty input → empty text. */
export function extractHtml(html: string, cfg: HtmlExtractorConfig = DEFAULT_HTML_CONFIG): HtmlExtraction {
  const out: string[] = [];
  let title: string | undefined;
  let skipDepth = 0;
  let skipTag: string | null = null;
  let boilerplateDepth = 0;
  const openStack: string[] = [];
  let inTitle = false;
  let inPre = false;
  let listDepth = 0;
  let orderedCounter: number[] = [];
  let linkHref: string | null = null;
  let linkText = '';
  let links = 0;
  let tables = 0;
  let inCell = false;
  let cellText = '';
  let rowCells: string[] = [];
  let inRow = false;
  const hasMain = cfg.favorMainContent && /<(?:main|article)[\s>]/i.test(html);
  let mainDepth = 0;
  let insideMain = !hasMain;
  const mainStack: number[] = [];

  const pushText = (t: string): void => {
    if (!insideMain || skipDepth > 0 || boilerplateDepth > 0) return;
    if (inTitle) {
      title = (title ?? '') + t;
      return;
    }
    if (linkHref !== null) {
      linkText += t;
      return;
    }
    if (inCell) {
      cellText += t;
      return;
    }
    out.push(t);
  };
  const newline = (): void => {
    if (!insideMain || skipDepth > 0 || boilerplateDepth > 0 || inCell || inTitle) return;
    if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n');
  };

  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > last) {
      const raw = html.slice(last, m.index);
      if (skipDepth === 0) {
        const text = decodeEntities(raw);
        pushText(inPre ? text : text.replace(/[ \t\r\n]+/g, ' '));
      }
    }
    last = m.index + m[0].length;
    const nameRaw = m[1];
    if (!nameRaw) continue; // comment / doctype / cdata
    const name = nameRaw.toLowerCase();
    const closing = m[0].startsWith('</');
    const selfClosing = m[3] === '/' || VOID_ELEMENTS.has(name);

    if (skipDepth > 0) {
      if (name === skipTag) {
        if (closing) {
          skipDepth--;
          if (skipDepth === 0) skipTag = null;
        } else if (!selfClosing) skipDepth++;
      }
      continue;
    }
    if (!closing && SKIP_ELEMENTS.has(name) && !selfClosing) {
      if (name === 'head') {
        // still harvest the title from head
        const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(last, last + 20000));
        if (tm && !title) title = decodeEntities(tm[1]).replace(/\s+/g, ' ').trim();
      }
      skipDepth = 1;
      skipTag = name;
      continue;
    }
    if (name === 'title') {
      inTitle = !closing;
      continue;
    }
    if (hasMain && (name === 'main' || name === 'article')) {
      if (!closing) {
        mainDepth++;
        insideMain = true;
        mainStack.push(openStack.length);
      } else {
        mainDepth = Math.max(0, mainDepth - 1);
        if (mainDepth === 0) {
          newline();
          insideMain = false;
        }
      }
    }
    if (BOILERPLATE_ELEMENTS.has(name) && !selfClosing) {
      if (!closing) boilerplateDepth++;
      else boilerplateDepth = Math.max(0, boilerplateDepth - 1);
      continue;
    }
    if (boilerplateDepth > 0 || !insideMain) continue;

    if (!closing) {
      if (!selfClosing) openStack.push(name);
      switch (name) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          newline();
          pushText(`${'#'.repeat(Number(name[1]))} `);
          break;
        case 'br':
          pushText('\n');
          break;
        case 'hr':
          newline();
          pushText('---\n');
          break;
        case 'p':
        case 'div':
        case 'section':
        case 'blockquote':
        case 'figure':
        case 'dt':
        case 'dd':
        case 'details':
        case 'summary':
          newline();
          if (name === 'blockquote') pushText('> ');
          break;
        case 'ul':
          listDepth++;
          orderedCounter.push(0);
          newline();
          break;
        case 'ol':
          listDepth++;
          orderedCounter.push(1);
          newline();
          break;
        case 'li': {
          newline();
          const counter = orderedCounter[orderedCounter.length - 1] ?? 0;
          const indent = '  '.repeat(Math.max(0, listDepth - 1));
          if (counter > 0) {
            pushText(`${indent}${counter}. `);
            orderedCounter[orderedCounter.length - 1] = counter + 1;
          } else pushText(`${indent}- `);
          break;
        }
        case 'pre':
          inPre = true;
          newline();
          pushText('```\n');
          break;
        case 'code':
          if (!inPre) pushText('`');
          break;
        case 'a': {
          const href = cfg.includeLinks ? attr(m[2], 'href') : undefined;
          if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
            linkHref = href;
            linkText = '';
          }
          break;
        }
        case 'img': {
          if (cfg.includeImages) {
            const alt = attr(m[2], 'alt') ?? '';
            const src = attr(m[2], 'src') ?? '';
            if (src) pushText(`![${alt}](${src})`);
          } else {
            const alt = attr(m[2], 'alt');
            if (alt) pushText(alt);
          }
          break;
        }
        case 'table':
          if (cfg.includeTables) {
            tables++;
            newline();
          }
          break;
        case 'tr':
          if (cfg.includeTables) {
            inRow = true;
            rowCells = [];
          } else newline();
          break;
        case 'td':
        case 'th':
          if (cfg.includeTables && inRow) {
            inCell = true;
            cellText = '';
          } else pushText(' ');
          break;
        default:
          if (BLOCK_ELEMENTS.has(name)) newline();
      }
    } else {
      const idx = openStack.lastIndexOf(name);
      if (idx >= 0) openStack.splice(idx);
      switch (name) {
        case 'a':
          if (linkHref !== null) {
            const href = linkHref;
            const text = linkText.replace(/\s+/g, ' ').trim();
            linkHref = null;
            linkText = '';
            links++;
            pushText(text ? `[${text}](${href})` : href);
          }
          break;
        case 'pre':
          inPre = false;
          pushText('\n```\n');
          break;
        case 'code':
          if (!inPre) pushText('`');
          break;
        case 'ul':
        case 'ol':
          listDepth = Math.max(0, listDepth - 1);
          orderedCounter.pop();
          newline();
          break;
        case 'td':
        case 'th':
          if (inCell) {
            rowCells.push(cellText.replace(/\s+/g, ' ').trim());
            inCell = false;
            cellText = '';
          }
          break;
        case 'tr':
          if (inRow) {
            inRow = false;
            if (rowCells.length) pushText(`| ${rowCells.join(' | ')} |`);
            newline();
            rowCells = [];
          }
          break;
        default:
          if (BLOCK_ELEMENTS.has(name)) newline();
      }
    }
  }
  if (last < html.length && skipDepth === 0) pushText(decodeEntities(html.slice(last)).replace(/[ \t\r\n]+/g, ' '));
  if (linkHref !== null) pushText(linkText);

  let text = out.join('');
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+(?=[^-\d ])/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (title && !text.startsWith(`# ${title}`)) text = `# ${title}\n\n${text}`;
  return { text, title, links, tables, usedMainContent: hasMain };
}

export class HtmlCompressor implements Compressor {
  readonly strategy = 'html' as const;
  readonly config: HtmlExtractorConfig;

  constructor(config: Partial<HtmlExtractorConfig> = {}) {
    this.config = { ...DEFAULT_HTML_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['html', 'passthrough'], ccrHashes: [], info });
    try {
      if (!/<[a-zA-Z!]/.test(content)) return passthrough('not_html');
      const r = extractHtml(content, this.config);
      if (!r.text.trim()) return passthrough('empty_extraction');
      if (r.text.length >= content.length) return passthrough('no_savings');
      return { content: r.text, strategy: 'html', chain: ['html'], ccrHashes: [], info: `html(${content.length}->${r.text.length} chars, ${r.links} links, ${r.tables} tables)` };
    } catch {
      return passthrough('error');
    }
  }
}
