/**
 * `phm upgrade` is an alias of `phm update`: new users try `upgrade` first
 * and used to hit "Unknown command". Only the help path runs here, so the
 * test never fetches, installs or touches a real checkout.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { HELP_ENTRIES } from '../src/cli/help.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-upgrade-alias-')); homes.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  delete env.ASHLR_HOME;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env,
  });
  return { home, result };
}

describe('CLI: phm upgrade', () => {
  it('prints the same help as phm update and changes nothing', () => {
    const upgrade = run(['upgrade', '--help']);
    const update = run(['update', '--help']);
    expect(upgrade.result.status).toBe(0);
    expect(upgrade.result.stderr).not.toContain('Unknown command');
    expect(upgrade.result.stdout).toContain('phm update');
    expect(upgrade.result.stdout).toBe(update.result.stdout);
    expect(readdirSync(upgrade.home)).toEqual([]);
  });

  it('is completable and listed in help', () => {
    expect(TOP_LEVEL_COMMANDS).toContain('upgrade');
    expect(HELP_ENTRIES.some((e) => e.cmd.split(' ')[0] === 'upgrade')).toBe(true);
  });
});
