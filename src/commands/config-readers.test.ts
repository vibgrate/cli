import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProjectConfigError,
  assertProjectConfig,
  loadConfig,
  parseDataConfig,
} from '../core-open/config.js';
import { readConfigExcludes } from '../engine/discover.js';
import { areaSkillsEnabled } from '../install/area-skills.js';
import { loadReviewConfig } from '../review/config.js';
import type { GitRunner } from '../review/git.js';
import { configNotes } from './doctor.js';
import { runBuild } from './build.js';
import { main } from '../cli.js';

const TOKEN = 'sk-live-SUPERSECRET';

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-config-readers-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('settings read outside a scan follow the one config file', () => {
  it('reads exclude and areaSkills from .vibgrate/config.yml', () => {
    const root = project({ '.vibgrate/config.yml': 'areaSkills: true\nexclude:\n  - legacy/**\n' });
    expect(readConfigExcludes(root)).toEqual(['legacy/**']);
    expect(areaSkillsEnabled(root)).toBe(true);
  });

  it('ignores vibgrate.config.json when a YAML config exists', () => {
    const root = project({
      '.vibgrate/config.yml': 'exclude: []\n',
      'vibgrate.config.json': '{"areaSkills":true,"exclude":["from-json/**"]}',
    });
    expect(readConfigExcludes(root)).toEqual([]);
    expect(areaSkillsEnabled(root)).toBe(false);
  });

  it('still reads vibgrate.config.json on its own', () => {
    const root = project({ 'vibgrate.config.json': '{"areaSkills":true,"exclude":["legacy/**"]}' });
    expect(readConfigExcludes(root)).toEqual(['legacy/**']);
    expect(areaSkillsEnabled(root)).toBe(true);
  });
});

describe('vg doctor config notes', () => {
  it('is quiet for a single config', () => {
    expect(configNotes(project({ '.vibgrate/config.yml': 'exclude: []\n' }))).toEqual([]);
    expect(configNotes(project({}))).toEqual([]);
  });

  it('names a shadowed config file', () => {
    const root = project({ '.vibgrate/config.yml': 'exclude: []\n', 'vibgrate.config.json': '{}' });
    expect(configNotes(root)).toEqual(['vibgrate.config.json is ignored: .vibgrate/config.yml is the config in use']);
  });

  it('names legacy review files a review block replaces', () => {
    const root = project({
      'vibgrate.config.json': '{"review":{"enforcement":"advisory"}}',
      '.vibgrate/review.toml': '[review]\n',
      '.vibgrate/review/settings.md': 'mode: precise\n',
    });
    expect(configNotes(root)).toEqual([
      '.vibgrate/review.toml is ignored: review settings come from the review block in vibgrate.config.json',
      '.vibgrate/review/settings.md is ignored: review settings come from the review block in vibgrate.config.json',
    ]);
  });

  it('surfaces a config that does not parse', () => {
    const root = project({ '.vibgrate/config.yml': 'exclude: [unclosed\n' });
    expect(configNotes(root)[0]).toMatch(/\.vibgrate\/config\.yml is not valid YAML/);
  });
});

const noGit: GitRunner = () => ({ stdout: '', status: 1 });

describe('project config parse errors', () => {
  it('names the file, line, and key for a malformed file and does not echo the line', () => {
    const yaml = `exclude: [${TOKEN}\n`;
    const message = `.vibgrate/config.yml is not valid YAML at line 2, key exclude`;
    expect(() => parseDataConfig(yaml, '.vibgrate/config.yml')).toThrow(new ProjectConfigError(message));
    const root = project({ '.vibgrate/config.yml': yaml });
    expect(configNotes(root)).toEqual([message]);
    expect(() => readConfigExcludes(root)).toThrow(new ProjectConfigError(message));
    expect(() => assertProjectConfig(root)).toThrow(new ProjectConfigError(message));
    expect(() => loadReviewConfig(root, undefined, noGit)).toThrow(new ProjectConfigError(message));
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('\n');

    const json = `{ "exclude": "${TOKEN}"`;
    const jsonMessage = 'vibgrate.config.json is not valid JSON at line 1, key exclude';
    expect(() => parseDataConfig(json, 'vibgrate.config.json')).toThrow(new ProjectConfigError(jsonMessage));
    expect(jsonMessage).not.toContain(TOKEN);
  });

  it('rejects an exclude value that is not a list of strings', () => {
    const yaml = `exclude: ${TOKEN}\n`;
    const message = '.vibgrate/config.yml: exclude must be a list of strings at line 1';
    const root = project({ '.vibgrate/config.yml': yaml });
    expect(configNotes(root)).toEqual([message]);
    expect(() => readConfigExcludes(root)).toThrow(new ProjectConfigError(message));
    expect(() => loadReviewConfig(root, 'origin/main', noGit)).toThrow(new ProjectConfigError(message));
    expect(message).not.toContain(TOKEN);

    const numbers = project({ '.vibgrate/config.yml': 'exclude:\n  - 1\n' });
    expect(() => readConfigExcludes(numbers)).toThrow(/exclude must be a list of strings at line 1/);
    expect(readConfigExcludes(project({ '.vibgrate/config.yml': 'exclude: []\n' }))).toEqual([]);
  });

  it('treats an empty file as an empty config', async () => {
    const root = project({ '.vibgrate/config.yml': '' });
    expect(configNotes(root)).toEqual([]);
    expect(() => assertProjectConfig(root)).not.toThrow();
    expect(readConfigExcludes(root)).toEqual([]);
    expect((await loadConfig(root)).exclude).toEqual([]);
    expect(loadReviewConfig(root, undefined, noGit).source).toBe('defaults');
    expect(parseDataConfig('   \n# comment\n', '.vibgrate/config.yml')).toEqual({});
  });

  it('reads a valid config', async () => {
    const root = project({ '.vibgrate/config.yml': 'exclude:\n  - legacy/**\nareaSkills: true\n' });
    expect(configNotes(root)).toEqual([]);
    expect(() => assertProjectConfig(root)).not.toThrow();
    expect(readConfigExcludes(root)).toEqual(['legacy/**']);
    expect(areaSkillsEnabled(root)).toBe(true);
    expect((await loadConfig(root)).exclude).toEqual(['legacy/**']);
    const noted = project({
      '.vibgrate/config.yml': 'review:\n  enforcement: advisory\n',
    });
    expect(loadReviewConfig(noted, undefined, noGit)).toMatchObject({
      source: 'working-tree',
      file: '.vibgrate/config.yml',
      enforcement: 'advisory',
    });
  });

  it('leaves .ts and .js configs on the code path', () => {
    for (const file of ['vibgrate.config.ts', 'vibgrate.config.js']) {
      const root = project({ [file]: `export default { exclude: ['${TOKEN}'] };\n` });
      expect(configNotes(root)).toEqual([]);
      expect(() => assertProjectConfig(root)).not.toThrow();
      expect(readConfigExcludes(root)).toEqual([]);
    }
  });

  it('stops scan, build, and review on a malformed file and lets doctor report it', async () => {
    const message = '.vibgrate/config.yml is not valid YAML at line 2, key exclude';
    const root = project({ '.vibgrate/config.yml': `exclude: [${TOKEN}\n` });
    await expect(runBuild([], {}, { cwd: root, offline: true, quiet: true, json: true })).rejects.toThrow(
      new ProjectConfigError(message),
    );

    const { scanCommand } = await import('../reporting/commands/scan.js');
    await expect(
      scanCommand.parseAsync(['node', 'scan', root, '--offline', '--quiet', '--no-graph', '--no-daemon']),
    ).rejects.toThrow(new ProjectConfigError(message));

    const { buildProgram } = await import('../cli.js');
    const program = buildProgram();
    program.exitOverride((err) => {
      throw err;
    });
    await expect(
      program.parseAsync(['review', '-C', root, '--offline', '--quiet', '--no-auto-build'], { from: 'user' }),
    ).rejects.toThrow(new ProjectConfigError(message));

    const invalid = project({ '.vibgrate/config.yml': `exclude: ${TOKEN}\n` });
    const excludeMessage = '.vibgrate/config.yml: exclude must be a list of strings at line 1';
    await expect(
      scanCommand.parseAsync(['node', 'scan', invalid, '--offline', '--quiet', '--no-graph', '--no-daemon']),
    ).rejects.toThrow(new ProjectConfigError(excludeMessage));
  });
});

describe('vg reports a config error without a stack trace', () => {
  function capture(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const write = (chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
      chunks.push(String(chunk));
      const done = typeof encOrCb === 'function' ? encOrCb : cb;
      if (typeof done === 'function') done();
      return true;
    };
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(write as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(write as never);
    return {
      text: () => chunks.join(''),
      restore: () => {
        stdout.mockRestore();
        stderr.mockRestore();
      },
    };
  }

  it('exits 1 from scan, build, and review, and doctor keeps going', async () => {
    const message = '.vibgrate/config.yml is not valid YAML at line 2, key exclude';
    const root = project({ '.vibgrate/config.yml': `exclude: [${TOKEN}\n` });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const saved = process.exitCode;
    const savedNoColor = process.env.NO_COLOR;
    process.exitCode = undefined;
    process.env.NO_COLOR = '1';

    const fail = async (args: string[]): Promise<string> => {
      const io = capture();
      try {
        await expect(main(['node', 'vg', ...args, '--offline', '--quiet'])).rejects.toThrow('exit:1');
        return io.text();
      } finally {
        io.restore();
      }
    };

    try {
      for (const args of [
        ['scan', root, '--no-graph', '--no-daemon'],
        ['build', '-C', root, '--no-daemon'],
        ['review', '-C', root, '--no-auto-build'],
      ]) {
        const text = await fail(args);
        expect(text).toContain(`error: ${message}`);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain('parseDataConfig');
        expect(text).not.toMatch(/^ {2,}at /m);
      }

      exit.mockClear();
      const io = capture();
      try {
        await main(['node', 'vg', 'doctor', '-C', root, '--offline', '--quiet']);
        expect(exit).not.toHaveBeenCalled();
        expect(process.exitCode ?? 0).toBe(0);
        const text = io.text();
        expect(text).toContain(message);
        expect(text).not.toContain(TOKEN);
      } finally {
        io.restore();
      }
    } finally {
      exit.mockRestore();
      process.exitCode = saved;
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
  });
});
