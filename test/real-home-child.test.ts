/**
 * A Vitest worker opts into process home in-process. Spawned Node children
 * do not inherit that symbol, so the setup preload has to. This locks the
 * boundary that keeps KILL and enrollment out of the account home.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('child authority home boundary', () => {
  it.each([
    { name: 'preloaded test child follows HOME', vitest: 'true', preload: true, fixture: true, missing: false },
    { name: 'VITEST alone does not redirect account home', vitest: 'true', preload: false, fixture: false, missing: false },
    { name: 'false VITEST ignores the preload override', vitest: 'false', preload: true, fixture: false, missing: false },
    { name: 'missing account home preserves throwing and nullable APIs', vitest: 'false', preload: true, fixture: false, missing: true },
  ])('$name', ({ vitest, preload, fixture, missing }) => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-child-home-'));
    homes.push(home);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/core/real-home.ts')).href;
    const strictUrl = pathToFileURL(join(process.cwd(), 'src/core/util/real-home.ts')).href;
    const source = `import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      if (${missing}) { os.userInfo = () => { throw new Error('no account home'); }; syncBuiltinESMExports(); }
      const { realHome: nullable } = await import(${JSON.stringify(moduleUrl)});
      const { realHome: strict } = await import(${JSON.stringify(strictUrl)});
      let value = null, threw = false;
      try { value = strict(); } catch { threw = true; }
      const expected = ${missing ? 'null' : fixture ? 'process.env.HOME' : 'os.userInfo().homedir'};
      process.stdout.write(String(nullable() === expected && value === expected && threw === ${missing}));`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, VITEST: vitest,
        NODE_OPTIONS: preload ? `--require=${JSON.stringify(join(process.cwd(), 'test/setup/child-process-home.cjs'))}` : '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('true');
  });
});
