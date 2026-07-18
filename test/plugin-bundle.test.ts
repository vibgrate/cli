import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillMarkdown } from '../src/install/content.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(pkgRoot, 'plugins', 'claude', 'vg');

/**
 * The Claude Code plugin bundle is a static distribution surface for the same
 * content `vg install claude` writes. These tests pin the bundle to its
 * canonical sources so the two can never drift apart silently.
 */
describe('claude plugin bundle', () => {
  it('SKILL.md is exactly the canonical skill for the claude client', () => {
    const bundled = fs.readFileSync(path.join(pluginDir, 'skills', 'vg', 'SKILL.md'), 'utf8');
    expect(bundled).toBe(skillMarkdown('claude'));
  });

  it('.mcp.json registers the npx launcher (a plugin cannot assume vg on PATH)', () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.mcpServers.vg).toEqual({ command: 'npx', args: ['-y', '-p', '@vibgrate/cli', 'vg', 'serve'] });
  });

  it('plugin.json and the marketplace listing agree on the plugin name', () => {
    const plugin = JSON.parse(
      fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string };
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(pkgRoot, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: { name: string; source: string }[] };
    const listed = marketplace.plugins.find((p) => p.name === plugin.name);
    expect(listed).toBeDefined();
    expect(listed!.source).toBe('./plugins/claude/vg');
  });
});
