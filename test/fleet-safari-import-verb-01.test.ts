/**
 * RQ-PHX-SAFARIIMPORTVERB01 — `ashlr fleet safari-import`: the bounded wrapper
 * over scripts/mac-bridge/safari_import.py. Every test injects a fake exec —
 * no test ever opens Safari, runs osascript or touches a real NEEDS-MASON.md;
 * the needs-mason path only ever appears inside the captured argv.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetSafariImport, type SafariImportExecOptions } from '../src/cli/fleet-safari-import.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const SCRIPT = '/checkout/scripts/mac-bridge/safari_import.py';
const locate = () => SCRIPT;

const resultJson = (extra: Record<string, unknown>): string => JSON.stringify({
  schemaVersion: 1, tool: 'safari-import', importConfirmed: false,
  websitesSignedIn: false, blocked: null, progress: [], ...extra,
});

const execOk = (stdout = resultJson({ mode: 'status' })) =>
  vi.fn(async (_file: string, _argv: readonly string[], _options: SafariImportExecOptions) => ({ stdout: stdout + '\n', stderr: '' }));
const execExit = (code: number, stdout: string, stderr = '') =>
  vi.fn(async (_file: string, _argv: readonly string[], _options: SafariImportExecOptions) => {
    throw Object.assign(new Error(`exit ${code}`), { code, stdout, stderr });
  });

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const runsRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-import-root-'));
  dirs.push(dir);
  return dir;
};

describe('fleet safari-import', () => {
  it('refuses bad arguments with usage on stderr, exit 2, and never spawns', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [
      [],
      ['bogus'],
      ['STATUS'],
      ['status', 'extra'],
      ['--json'],
      ['begin-import', 'status'],
      ['status', '--bogus'],
      ['status', '--json', '--json'],
      ['status', '--root'],
      ['status', '--root', '-x'],
      ['status', '--timeout', '0'],
      ['status', '--timeout', '121'],
      ['status', '--timeout', 'abc'],
      ['status', '--timeout', 'Infinity'],
      ['status', '--timeout'],
      ['status', '--timeout', '15', '--timeout', '30'],
    ]) {
      const exec = execOk();
      expect(await cmdFleetSafariImport(args, { exec, locateScript: locate }), JSON.stringify(args)).toBe(2);
      expect(exec).not.toHaveBeenCalled();
    }
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet safari-import'));
  });

  it('prints its own help on --help and exits 0 without spawning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetSafariImport(['--help'], { exec, locateScript: locate })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet safari-import <status|begin-import>'));
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs python3 -I with the exact argv, the script path and an absolute --needs-mason under --root', async () => {
    const root = runsRoot();
    const exec = execOk(resultJson({ mode: 'begin-import' }));
    expect(await cmdFleetSafariImport(['begin-import', '--root', root, '--timeout', '30'], { exec, locateScript: locate })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, argv, options] = exec.mock.calls[0]!;
    const needsMason = join(root, 'supervisor', 'NEEDS-MASON.md');
    expect(isAbsolute(needsMason)).toBe(true);
    expect(file).toBe('python3');
    expect(argv).toEqual(['-I', SCRIPT, 'begin-import', '--needs-mason', needsMason, '--timeout', '30']);
    expect(options).toMatchObject({ encoding: 'utf8', timeout: 45_000 });
  });

  it('defaults --root to ~/.ashlr-runs and --timeout to 15 (killed at 30s)', async () => {
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status'], { exec, locateScript: locate })).toBe(0);
    const argv = exec.mock.calls[0]![1] as string[];
    const options = exec.mock.calls[0]![2]!;
    expect(argv[4]).toBe(join(homedir(), '.ashlr-runs', 'supervisor', 'NEEDS-MASON.md'));
    expect(argv[6]).toBe('15');
    expect(options.timeout).toBe(30_000);
  });

  it('resolves a relative --root to an absolute needs-mason path', async () => {
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status', '--root', 'relative/dir'], { exec, locateScript: locate })).toBe(0);
    const needsMason = (exec.mock.calls[0]![1] as string[])[4]!;
    expect(isAbsolute(needsMason)).toBe(true);
    expect(needsMason).toBe(join(process.cwd(), 'relative/dir', 'supervisor', 'NEEDS-MASON.md'));
  });

  it('says the verb needs a source checkout and exits 1 when the script is absent', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status'], { exec, locateScript: () => null })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('')).toContain('source checkout');
  });

  it('prints the helper JSON unchanged with --json and propagates exit codes', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const status = resultJson({ mode: 'status', safari: { running: true }, nextAction: 'run begin-import' });
    expect(await cmdFleetSafariImport(['status', '--json'], { exec: execOk(status), locateScript: locate })).toBe(0);
    expect(write).toHaveBeenCalledWith(status + '\n');

    const blocked = resultJson({ mode: 'begin-import', blocked: { reason: 'keychain-prompt', detail: 'd' }, nextAction: 'mason: answer the prompt' });
    expect(await cmdFleetSafariImport(['begin-import', '--json'], { exec: execExit(2, blocked + '\n'), locateScript: locate })).toBe(2);
    expect(write).toHaveBeenCalledWith(blocked + '\n');
  });

  it('blocked exit 2 is a normal result: reason and nextAction on one line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = resultJson({
      mode: 'begin-import',
      blocked: { reason: 'chrome-not-installed', detail: 'Google Chrome.app not found' },
      needsMason: { path: '/x/supervisor/NEEDS-MASON.md', appended: true },
      nextAction: 'mason: confirm Google Chrome.app exists',
    });
    const exec = execExit(2, stdout, 'helper progress noise');
    expect(await cmdFleetSafariImport(['begin-import'], { exec, locateScript: locate })).toBe(2);
    const line = log.mock.calls.flat().join('');
    expect(line).toContain('blocked: chrome-not-installed');
    expect(line).toContain('mason: confirm Google Chrome.app exists');
    expect(line).toContain('/x/supervisor/NEEDS-MASON.md');
    expect(line).not.toContain('helper progress noise');
  });

  it('reports an opened dialog without claiming the import finished or a sign-in', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = resultJson({
      mode: 'begin-import',
      dialog: { alreadyOpen: false, opened: true, titleMatched: true },
      nextAction: "human: in Safari's import sheet choose items and click Import",
    });
    expect(await cmdFleetSafariImport(['begin-import'], { exec: execOk(stdout), locateScript: locate })).toBe(0);
    const line = log.mock.calls.flat().join('');
    expect(line).toContain('import dialog opened in Safari');
    expect(line).not.toMatch(/import confirmed|signed in|import (finished|complete|done)|imported/i);
  });

  it('prints import/signed-in claims only when the helper asserts them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = resultJson({ mode: 'status', importConfirmed: true, websitesSignedIn: true });
    expect(await cmdFleetSafariImport(['status'], { exec: execOk(stdout), locateScript: locate })).toBe(0);
    const line = log.mock.calls.flat().join('');
    expect(line).toContain('import confirmed');
    expect(line).toContain('websites signed in');
  });

  it('prints a fixed error and never echoes stderr on a nonzero exit with unparseable output', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exec = execExit(2, 'this is not json', 'hidden stderr detail');
    expect(await cmdFleetSafariImport(['status', '--json'], { exec, locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet safari-import: helper exited without a readable result');
    expect(log).not.toHaveBeenCalled();
    const printed = [...write.mock.calls.flat(), ...err.mock.calls.flat()].join('');
    expect(printed).not.toContain('this is not json');
    expect(printed).not.toContain('hidden stderr detail');
  });

  it('exit 0 without a JSON result still fails honestly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetSafariImport(['status'], { exec: execOk('not json'), locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet safari-import: helper exited without a readable result');
    expect(log).not.toHaveBeenCalled();
  });

  it('kills the helper at timeout + 15s and reports the bound, not stderr', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn(async (_file: string, _argv: readonly string[], _options: SafariImportExecOptions) => {
      throw Object.assign(new Error('Timed out'), { killed: true, signal: 'SIGKILL', stdout: '', stderr: 'partial progress' });
    });
    expect(await cmdFleetSafariImport(['begin-import', '--timeout', '10'], { exec, locateScript: locate })).toBe(1);
    expect(exec.mock.calls[0]![2]!.timeout).toBe(25_000);
    expect(err).toHaveBeenCalledWith('error: fleet safari-import timed out after 25s');
    expect(err.mock.calls.flat().join('')).not.toContain('partial progress');
  });

  it('reports a fixed error when python3 cannot start', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn(async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); });
    expect(await cmdFleetSafariImport(['status'], { exec, locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet safari-import could not start python3');
  });

  it('propagates a parseable nonzero helper exit such as unsupported-platform', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = resultJson({ mode: 'status', error: 'unsupported-platform' });
    const exec = execExit(1, stdout);
    expect(await cmdFleetSafariImport(['status'], { exec, locateScript: locate })).toBe(1);
    expect(log.mock.calls.flat().join('')).toContain('unsupported-platform');
  });

  it('resolves through the real fleet registry and dispatches ashlr fleet safari-import --help', async () => {
    const resolved = resolveFleetSubcommand('safari-import');
    expect(resolved).toEqual({ module: './fleet-safari-import.js', exportName: 'cmdFleetSafariImport' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['safari-import']!();
    expect(typeof loaded[resolved!.exportName]).toBe('function');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['safari-import', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet safari-import'));
  });

  it('locates the real script beside this checkout with the default locator', async () => {
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status'], { exec })).toBe(0);
    const argv = exec.mock.calls[0]![1] as string[];
    expect(argv[1]).toMatch(/scripts[/\\]mac-bridge[/\\]safari_import\.py$/);
    expect(existsSync(argv[1]!)).toBe(true);
  });
});
