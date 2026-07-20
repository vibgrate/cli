import { describe, it, expect } from 'vitest';
import { extractEmbeddedScript, isContainerLang } from '../src/engine/sfc.js';
import { parseSource } from '../src/engine/parse.js';
import { langForExtension } from '../src/engine/languages.js';
import { relativeResolver } from '../src/engine/module-resolver.js';

describe('extractEmbeddedScript', () => {
  it('returns null for non-container languages', () => {
    expect(extractEmbeddedScript('ts', 'const x = 1;')).toBeNull();
    expect(isContainerLang('vue')).toBe(true);
    expect(isContainerLang('ts')).toBe(false);
  });

  it('masks everything outside the script block, preserving length and lines', () => {
    const src = '<template>\n  <p>{{ x }}</p>\n</template>\n<script>\nconst x = 1;\n</script>\n';
    const out = extractEmbeddedScript('vue', src)!;
    expect(out.langId).toBe('js');
    expect(out.masked.length).toBe(src.length);
    expect(out.masked.split('\n').length).toBe(src.split('\n').length);
    expect(out.masked).toContain('const x = 1;');
    expect(out.masked).not.toContain('template');
    // The script body starts at the same offset as in the original.
    expect(out.masked.indexOf('const x = 1;')).toBe(src.indexOf('const x = 1;'));
  });

  it('picks the TS grammar from a lang attribute and handles multiple blocks', () => {
    const src =
      '<script context="module">\nexport const meta = 1;\n</script>\n' +
      '<script lang="ts">\nlet n: number = 2;\n</script>\n<main/>\n';
    const out = extractEmbeddedScript('svelte', src)!;
    expect(out.langId).toBe('ts');
    expect(out.masked).toContain('export const meta = 1;');
    expect(out.masked).toContain('let n: number = 2;');
    expect(out.masked).not.toContain('<main/>');
  });

  it('extracts the Astro frontmatter fence as TypeScript', () => {
    const src = '---\nimport Card from "./Card.astro";\nconst title: string = "hi";\n---\n<h1>{title}</h1>\n';
    const out = extractEmbeddedScript('astro', src)!;
    expect(out.langId).toBe('ts');
    expect(out.masked).toContain('import Card from "./Card.astro";');
    expect(out.masked).not.toContain('<h1>');
  });

  it('a script-less container masks to blank instead of failing', () => {
    const out = extractEmbeddedScript('vue', '<template><p>static</p></template>\n')!;
    expect(out.masked.trim()).toBe('');
  });
});

describe('parse — Vue/Svelte/Astro single-file components', () => {
  it('registers container extensions in the language registry', () => {
    expect(langForExtension('.vue')?.id).toBe('vue');
    expect(langForExtension('.svelte')?.id).toBe('svelte');
    expect(langForExtension('.astro')?.id).toBe('astro');
  });

  it('extracts defs, calls, and imports from a Vue SFC with correct lines', async () => {
    const src = [
      '<template>', // line 1
      '  <button @click="onClick">{{ label }}</button>',
      '</template>',
      '<script setup lang="ts">', // line 4
      "import { formatCountdownLabel } from './authMessage.service';", // line 5
      'function onClick(): void {', // line 6
      '  formatCountdownLabel(3);', // line 7
      '}',
      '</script>',
    ].join('\n');
    const p = await parseSource('AuthLogin.vue', 'vue', src);

    expect(p.lang).toBe('vue'); // node keeps the container language
    expect(p.defs.map((d) => d.name)).toContain('onClick');
    expect(p.defs.find((d) => d.name === 'onClick')!.startLine).toBe(6);
    const call = p.calls.find((c) => c.callee === 'formatCountdownLabel');
    expect(call).toBeDefined();
    expect(call!.line).toBe(7);
    expect(p.imports.map((i) => i.source)).toContain('./authMessage.service');
  });

  it('extracts from a Svelte component', async () => {
    const src = ['<script>', "import { tick } from 'svelte';", 'export function refresh() { tick(); }', '</script>', '<p>ui</p>'].join('\n');
    const p = await parseSource('Widget.svelte', 'svelte', src);
    expect(p.defs.map((d) => d.name)).toContain('refresh');
    expect(p.calls.map((c) => c.callee)).toContain('tick');
    expect(p.imports.map((i) => i.source)).toContain('svelte');
  });

  it('extracts from Astro frontmatter', async () => {
    const src = ['---', "import { getPosts } from './posts';", 'const posts = await getPosts();', '---', '<ul>{posts}</ul>'].join('\n');
    const p = await parseSource('Blog.astro', 'astro', src);
    expect(p.calls.map((c) => c.callee)).toContain('getPosts');
    expect(p.imports.map((i) => i.source)).toContain('./posts');
  });

  it('is deterministic for the same source', async () => {
    const src = '<script setup>\nfunction f() { return g(); }\n</script>\n<template><p/></template>';
    const a = await parseSource('a.vue', 'vue', src);
    const b = await parseSource('a.vue', 'vue', src);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('module resolution to/from SFCs', () => {
  it('resolves extension-bearing and extensionless imports of a .vue file', () => {
    const files = new Set(['src/pages/AuthLogin.vue', 'src/services/auth.ts']);
    const r = relativeResolver(files);
    expect(r.resolve('src/pages/index.ts', './AuthLogin.vue')).toBe('src/pages/AuthLogin.vue');
    expect(r.resolve('src/pages/index.ts', './AuthLogin')).toBe('src/pages/AuthLogin.vue');
    // …and a .vue file resolves its own imports of plain ts modules.
    expect(r.resolve('src/pages/AuthLogin.vue', '../services/auth')).toBe('src/services/auth.ts');
  });
});
