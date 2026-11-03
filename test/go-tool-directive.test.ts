import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function offlineCache(): GoCache {
  return new GoCache(new Semaphore(1), undefined, true);
}

async function scan(goMod: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-go-tool-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'go.mod'), goMod);
  const [project] = await scanGoProjects(root, offlineCache());
  return project.dependencies.map((d) => ({
    package: d.package,
    section: d.section,
    currentSpec: d.currentSpec,
  }));
}

describe('Go 1.24 tool directives', () => {
  it('keeps a single-line tool module as a development dependency and drops other indirect requires', async () => {
    const goMod = `module example.com/app

go 1.24

tool golang.org/x/tools/cmd/stringer

require golang.org/x/tools v0.30.0 // indirect

require rsc.io/quote v1.5.2 // indirect
`;
    const first = await scan(goMod);
    const second = await scan(goMod);
    expect(first).toEqual(second);
    expect(first).toEqual([
      { package: 'golang.org/x/tools', section: 'devDependencies', currentSpec: 'v0.30.0' },
    ]);
  });

  it('reads a tool block and keeps each providing module', async () => {
    const rows = await scan(`module example.com/app

go 1.24

tool (
	golang.org/x/tools/cmd/stringer
	honnef.co/go/tools/cmd/staticcheck
)

require (
	golang.org/x/tools v0.30.0 // indirect
	honnef.co/go/tools v0.5.1 // indirect
	rsc.io/quote v1.5.2 // indirect
)
`);
    expect(rows).toEqual([
      { package: 'golang.org/x/tools', section: 'devDependencies', currentSpec: 'v0.30.0' },
      { package: 'honnef.co/go/tools', section: 'devDependencies', currentSpec: 'v0.5.1' },
    ]);
  });

  it('keeps a tool module that is also a direct require in dependencies', async () => {
    const rows = await scan(`module example.com/app

go 1.24

tool golang.org/x/tools/cmd/stringer

require (
	golang.org/x/tools v0.30.0
	rsc.io/quote v1.5.2 // indirect
)
`);
    expect(rows).toEqual([
      { package: 'golang.org/x/tools', section: 'dependencies', currentSpec: 'v0.30.0' },
    ]);
  });

  it('maps a nested tool path to the longest module prefix on a slash boundary', async () => {
    const rows = await scan(`module example.com/app

go 1.24

tool example.com/tools/cmd/stringer

require (
	example.com/tool v1.0.0 // indirect
	example.com/tools v1.2.0 // indirect
	example.com/tools/cmd v1.2.3 // indirect
	example.com/other v0.1.0 // indirect
)
`);
    expect(rows).toEqual([
      { package: 'example.com/tools/cmd', section: 'devDependencies', currentSpec: 'v1.2.3' },
    ]);
  });
});
