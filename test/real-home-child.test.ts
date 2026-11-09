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

describe('test children follow the relocated home', () => {
  it('resolves realHome inside HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-child-home-'));
    homes.push(home);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/core/real-home.ts')).href;
    const source = `import { realHome } from ${JSON.stringify(moduleUrl)}; process.stdout.write(realHome() ?? '');`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(home);
  });
});
