import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { cmdFleetStandby } from '../src/cli/fleet-standby.js';
import { cmdFleetStandbyConfig } from '../src/cli/fleet-standby-config.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const FLAGS = ['--db', 'leases.sqlite', '--snapshot-store', 'snaps', '--primary', 'primary-fake',
  '--role', 'leader', '--host', 'standby-fake'];
const runs = () => mkdtempSync(join(tmpdir(), 'standby-config-'));
const swap = (flag: string, value: string) => {
  const args = [...FLAGS];
  args[args.indexOf(flag) + 1] = value;
  return args;
};

afterEach(() => vi.restoreAllMocks());

describe('fleet standby-config', () => {
  it('saves absolute paths atomically with mode 0600 and reads them back', async () => {
    const runsDir = runs();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStandbyConfig([...FLAGS, '--max-age', '600'], { runsDir })).toBe(0);
    const file = join(runsDir, 'standby.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ v: 1, primary: 'primary-fake', role: 'leader', host: 'standby-fake', maxAgeSec: 600 });
    expect(isAbsolute(saved.db) && isAbsolute(saved.snapshotStore)).toBe(true);
    log.mockClear();
    expect(await cmdFleetStandbyConfig([], { runsDir })).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('role leader, primary primary-fake');
    log.mockClear();
    expect(await cmdFleetStandbyConfig(['--json'], { runsDir })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(saved);
  });

  it('says so when nothing is saved', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStandbyConfig([], { runsDir: runs() })).toBe(0);
    expect(String(log.mock.calls[0]![0])).toMatch(/^No standby config\. Set one with/);
  });

  it('rejects bad input with usage, exit 2 and writes nothing', async () => {
    const runsDir = runs();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [
      swap('--primary', 'bad host'), swap('--role', 'has space'), swap('--host', '-lead'),
      [...FLAGS, '--max-age', '59'], [...FLAGS, '--max-age', 'abc'],
      [...FLAGS, '--bogus'], [...FLAGS, '--json', '--json'], [...FLAGS, '--db'], FLAGS.slice(0, 8),
    ]) {
      expect(await cmdFleetStandbyConfig(args, { runsDir }), JSON.stringify(args)).toBe(2);
    }
    expect(existsSync(join(runsDir, 'standby.json'))).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet standby-config'));
  });

  it('--clear removes the file and succeeds when absent', async () => {
    const runsDir = runs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdFleetStandbyConfig(FLAGS, { runsDir });
    expect(await cmdFleetStandbyConfig(['--clear'], { runsDir })).toBe(0);
    expect(existsSync(join(runsDir, 'standby.json'))).toBe(false);
    expect(await cmdFleetStandbyConfig(['--clear'], { runsDir })).toBe(0);
  });

  it('resolves through the real registry and dispatches --help', async () => {
    expect(resolveFleetSubcommand('standby-config')).toEqual(
      { module: './fleet-standby-config.js', exportName: 'cmdFleetStandbyConfig' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['standby-config']!();
    expect(typeof loaded['cmdFleetStandbyConfig']).toBe('function');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['standby-config', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet standby-config'));
  });

  it('fleet standby uses the saved config with no flags, and exits 2 without one', async () => {
    const runsDir = runs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn().mockResolvedValue({ stdout: '{"ready":true,"wouldLoseSec":5}', stderr: '' });
    const locateScript = () => '/fake/standby_readiness.py';
    expect(await cmdFleetStandby([], { runsDir, exec, locateScript })).toBe(2);
    expect(exec).not.toHaveBeenCalled();
    await cmdFleetStandbyConfig([...FLAGS, '--max-age', '600'], { runsDir });
    const saved = JSON.parse(readFileSync(join(runsDir, 'standby.json'), 'utf8'));
    expect(await cmdFleetStandby(['--max-age', '120'], { runsDir, exec, locateScript })).toBe(0);
    expect(exec.mock.calls[0]![1]).toEqual(['-B', '/fake/standby_readiness.py',
      '--db', saved.db, '--snapshot-store', saved.snapshotStore, '--primary', 'primary-fake',
      '--role', 'leader', '--host', 'standby-fake', '--max-age', '120']);
    // explicit flags win over the saved file
    exec.mockClear();
    expect(await cmdFleetStandby(swap('--host', 'other-fake'), { runsDir, exec, locateScript })).toBe(0);
    expect(exec.mock.calls[0]![1]).toContain('other-fake');
  });
});
