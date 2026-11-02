import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetApp, type FleetAppExecOptions } from '../src/cli/fleet-app.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const SCRIPT = '/checkout/scripts/mac-bridge/app_control.py';
const locate = () => SCRIPT;

const okStatus = JSON.stringify({ action: 'status', app: 'Cursor', ok: true, code: 'ok', running: true });
const execOk = (stdout = okStatus) =>
  vi.fn(async (_file: string, _argv: readonly string[], _options: FleetAppExecOptions) => ({ stdout: stdout + '\n', stderr: '' }));
const execExit = (code: number, stdout: string, stderr = '') =>
  vi.fn(async (_file: string, _argv: readonly string[], _options: FleetAppExecOptions) => {
    throw Object.assign(new Error(`exit ${code}`), { code, stdout, stderr });
  });

afterEach(() => vi.restoreAllMocks());

describe('fleet app', () => {
  it('refuses bad arguments with usage on stderr, exit 2, and never spawns', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [
      [],
      ['bogus', 'cursor'],
      ['status'],
      ['status', 'bad;app'],
      ['status', ''],
      ['status', 'a'.repeat(65)],
      ['quit', '--automatic'],
      ['status', 'cursor', 'extra'],
      ['status', 'cursor', '--bogus'],
      ['status', 'cursor', '--json', '--json'],
      ['status', 'cursor', '--root'],
      ['status', 'cursor', '--root', '-x'],
    ]) {
      const exec = execOk();
      expect(await cmdFleetApp(args, { exec, locateScript: locate }), JSON.stringify(args)).toBe(2);
      expect(exec).not.toHaveBeenCalled();
    }
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet app'));
  });

  it('prints its own help on --help and exits 0 without spawning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetApp(['--help'], { exec, locateScript: locate })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet app'));
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs python3 -I with the exact argv, the script path and --output-dir, never --automatic', async () => {
    const exec = execOk();
    expect(await cmdFleetApp(['status', 'cursor', '--root', '/tmp/runs'], { exec, locateScript: locate })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, argv, options] = exec.mock.calls[0]!;
    expect(file).toBe('python3');
    expect(argv).toEqual(['-I', SCRIPT, 'status', 'cursor', '--output-dir', '/tmp/runs']);
    expect(argv).not.toContain('--automatic');
    expect(options).toMatchObject({ encoding: 'utf8', timeout: 30_000 });
  });

  it('defaults --output-dir to ~/.ashlr-runs and passes multi-word app names through', async () => {
    const exec = execOk();
    expect(await cmdFleetApp(['focus', 'grok bot'], { exec, locateScript: locate })).toBe(0);
    const argv = exec.mock.calls[0]![1] as string[];
    expect(argv[3]).toBe('grok bot');
    expect(argv[5]).toMatch(/\.ashlr-runs$/);
  });

  it('says app control needs a source checkout and exits 1 when the script is absent', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetApp(['status', 'cursor'], { exec, locateScript: () => null })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('')).toContain('source checkout');
  });

  it('prints the script JSON unchanged with --json and propagates exit 0', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleetApp(['status', 'cursor', '--json'], { exec: execOk(okStatus), locateScript: locate })).toBe(0);
    expect(write).toHaveBeenCalledWith(okStatus + '\n');
  });

  it('prints a short human line without --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetApp(['status', 'cursor'], { exec: execOk(), locateScript: locate })).toBe(0);
    expect(log).toHaveBeenCalledWith('Cursor: running');
  });

  it('propagates the script nonzero exit with its parseable result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = JSON.stringify({ action: 'quit', app: 'Cursor', ok: false, code: 'quit_timeout' });
    const exec = execExit(1, stdout, 'stderr detail never echoed');
    expect(await cmdFleetApp(['quit', 'cursor'], { exec, locateScript: locate })).toBe(1);
    expect(log).toHaveBeenCalledWith('Cursor quit: quit_timeout');
  });

  it('prints a fixed error and never echoes stderr on a nonzero exit with unparseable output', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exec = execExit(1, 'not json at all', 'hidden stderr detail');
    expect(await cmdFleetApp(['status', 'cursor', '--json'], { exec, locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet app: app control failed without a readable result');
    expect(log).not.toHaveBeenCalled();
    const printed = [...write.mock.calls.flat(), ...err.mock.calls.flat()].join('');
    expect(printed).not.toContain('not json at all');
    expect(printed).not.toContain('hidden stderr detail');
  });

  it('reports a timeout with a fixed error and exit 1', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn(async (_file: string, _argv: readonly string[], _options: FleetAppExecOptions) => {
      throw Object.assign(new Error('Timed out'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
    });
    expect(await cmdFleetApp(['restart', 'cursor'], { exec, locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet app timed out after 30s');
  });

  it('resolves through the real fleet registry and dispatches ashlr fleet app --help', async () => {
    const resolved = resolveFleetSubcommand('app');
    expect(resolved).toEqual({ module: './fleet-app.js', exportName: 'cmdFleetApp' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['app']!();
    expect(typeof loaded[resolved!.exportName]).toBe('function');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['app', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet app'));
  });

  it('locates the real script beside this checkout with the default locator', async () => {
    const exec = execOk();
    expect(await cmdFleetApp(['status', 'cursor'], { exec })).toBe(0);
    const argv = exec.mock.calls[0]![1] as string[];
    expect(argv[1]).toMatch(/scripts[/\\]mac-bridge[/\\]app_control\.py$/);
    expect(existsSync(argv[1]!)).toBe(true);
  });
});
