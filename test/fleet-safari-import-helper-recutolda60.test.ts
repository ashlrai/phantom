/**
 * RQ-PHX-RECUTOLDA60 recovers RQ-PHX-SAFARIIMPORTVERB01 (#2774): the `status` and
 * `begin-import` modes of `ashlr fleet safari-import`, a bounded wrapper over
 * scripts/mac-bridge/safari_import.py. Every test injects a fake exec. No test
 * opens Safari, runs osascript or touches a real NEEDS-MASON.md; the needs-mason
 * path only appears inside the captured argv.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetSafariImport } from '../src/cli/fleet-safari-import.js';
import type { SafariImportExecOptions } from '../src/core/fleet/safari-import-helper.js';

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
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-import-recut-'));
  dirs.push(dir);
  return dir;
};

describe('fleet safari-import status|begin-import (recovered #2774)', () => {
  it('refuses bad mode arguments with usage on stderr, exit 2, and never spawns', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [
      ['bogus'],
      ['STATUS'],
      ['status', 'extra'],
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
      ['status', '--runs-dir', '/tmp/x'],
      ['--root', '/tmp/x'],
    ]) {
      const exec = execOk();
      expect(await cmdFleetSafariImport(args, { exec, locateScript: locate }), JSON.stringify(args)).toBe(2);
      expect(exec).not.toHaveBeenCalled();
    }
    expect(err).toHaveBeenCalledWith(expect.stringContaining('ashlr fleet safari-import <status|begin-import>'));
  });

  it('leaves the mode-less NEEDS-MASON ask flow on its own path and never spawns', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    const exec = execOk();
    const runsDir = tempDir();
    expect(await cmdFleetSafariImport(['--json', '--runs-dir', runsDir], { exec, locateScript: locate })).toBe(0);
    expect(JSON.parse(out[0]!).plan).toBe('ask');
    expect(await cmdFleetSafariImport(['--apply', '--runs-dir', runsDir], { exec, locateScript: locate })).toBe(0);
    expect(readFileSync(join(runsDir, 'NEEDS-MASON.md'), 'utf8')).toContain('Safari for Phantom');
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs python3 -I with the exact argv and an absolute --needs-mason under --root', async () => {
    const root = tempDir();
    const exec = execOk(resultJson({ mode: 'begin-import' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetSafariImport(['begin-import', '--root', root, '--timeout', '30'], { exec, locateScript: locate })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, argv, options] = exec.mock.calls[0]!;
    expect(file).toBe('python3');
    expect(argv).toEqual(['-I', SCRIPT, 'begin-import', '--needs-mason', join(root, 'supervisor', 'NEEDS-MASON.md'), '--timeout', '30']);
    expect(options).toMatchObject({ encoding: 'utf8', timeout: 45_000, windowsHide: true });
  });

  it('defaults --root to ~/.ashlr-runs and --timeout to 15 (killed at 30s); resolves a relative --root', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status'], { exec, locateScript: locate })).toBe(0);
    const argv = exec.mock.calls[0]![1] as string[];
    expect(argv[4]).toBe(join(homedir(), '.ashlr-runs', 'supervisor', 'NEEDS-MASON.md'));
    expect(argv[6]).toBe('15');
    expect(exec.mock.calls[0]![2]!.timeout).toBe(30_000);

    const rel = execOk();
    expect(await cmdFleetSafariImport(['status', '--root', 'relative/dir'], { exec: rel, locateScript: locate })).toBe(0);
    const needsMason = (rel.mock.calls[0]![1] as string[])[4]!;
    expect(isAbsolute(needsMason)).toBe(true);
    expect(needsMason).toBe(join(process.cwd(), 'relative/dir', 'supervisor', 'NEEDS-MASON.md'));
  });

  it('says the mode needs a source checkout and exits 1 when the script is absent', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status'], { exec, locateScript: () => null })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('')).toContain('source checkout');
  });

  it('prints the helper JSON unchanged with --json and propagates exit codes', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const status = resultJson({ mode: 'status', safari: { running: true }, nextAction: 'run begin-import' });
    expect(await cmdFleetSafariImport(['--json', 'status'], { exec: execOk(status), locateScript: locate })).toBe(0);
    expect(write).toHaveBeenCalledWith(status + '\n');

    const blocked = resultJson({ mode: 'begin-import', blocked: { reason: 'keychain-prompt', detail: 'd' }, nextAction: 'mason: answer the prompt' });
    expect(await cmdFleetSafariImport(['begin-import', '--json'], { exec: execExit(2, blocked + '\n'), locateScript: locate })).toBe(2);
    expect(write).toHaveBeenCalledWith(blocked + '\n');
  });

  it('treats blocked exit 2 as a normal result: reason, note path and nextAction on one line, no stderr', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = resultJson({
      mode: 'begin-import',
      blocked: { reason: 'chrome-not-installed', detail: 'Google Chrome.app not found' },
      needsMason: { path: '/x/supervisor/NEEDS-MASON.md', appended: true },
      nextAction: 'mason: confirm Google Chrome.app exists',
    });
    expect(await cmdFleetSafariImport(['begin-import'], { exec: execExit(2, stdout, 'helper progress noise'), locateScript: locate })).toBe(2);
    const line = log.mock.calls.flat().join('');
    expect(line).toContain('blocked: chrome-not-installed');
    expect(line).toContain('mason: confirm Google Chrome.app exists');
    expect(line).toContain('/x/supervisor/NEEDS-MASON.md');
    expect(line).not.toContain('helper progress noise');
  });

  it('reports an opened dialog without claiming the import finished; claims only what the helper asserts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const opened = resultJson({
      mode: 'begin-import',
      dialog: { alreadyOpen: false, opened: true, titleMatched: true },
      nextAction: "human: in Safari's import sheet choose items and click Import",
    });
    expect(await cmdFleetSafariImport(['begin-import'], { exec: execOk(opened), locateScript: locate })).toBe(0);
    const first = log.mock.calls.flat().join('');
    expect(first).toContain('import dialog opened in Safari');
    expect(first).not.toMatch(/import confirmed|signed in|import (finished|complete|done)|imported/i);

    log.mockClear();
    const asserted = resultJson({ mode: 'status', importConfirmed: true, websitesSignedIn: true });
    expect(await cmdFleetSafariImport(['status'], { exec: execOk(asserted), locateScript: locate })).toBe(0);
    const second = log.mock.calls.flat().join('');
    expect(second).toContain('import confirmed');
    expect(second).toContain('websites signed in');
  });

  it('fails with a fixed error and never echoes child output when the result is unreadable', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleetSafariImport(['status', '--json'], { exec: execExit(2, 'this is not json', 'hidden stderr detail'), locateScript: locate })).toBe(1);
    expect(await cmdFleetSafariImport(['status'], { exec: execOk('not json'), locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet safari-import: helper exited without a readable result');
    expect(log).not.toHaveBeenCalled();
    const printed = [...write.mock.calls.flat(), ...err.mock.calls.flat()].join('');
    expect(printed).not.toContain('this is not json');
    expect(printed).not.toContain('hidden stderr detail');
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

  it('reports a fixed error when python3 cannot start and propagates a parseable nonzero exit', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const enoent = vi.fn(async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); });
    expect(await cmdFleetSafariImport(['status'], { exec: enoent, locateScript: locate })).toBe(1);
    expect(err).toHaveBeenCalledWith('error: fleet safari-import could not start python3');

    const unsupported = execExit(1, resultJson({ mode: 'status', error: 'unsupported-platform' }));
    expect(await cmdFleetSafariImport(['status'], { exec: unsupported, locateScript: locate })).toBe(1);
    expect(log.mock.calls.flat().join('')).toContain('unsupported-platform');
  });

  it('dispatches ashlr fleet safari-import --help through the real fleet entry and documents both forms', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['safari-import', 'status', '--help'])).toBe(0);
    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('Usage: ashlr fleet safari-import [--json] [--apply | --done]');
    expect(help).toContain('ashlr fleet safari-import <status|begin-import>');
  });

  it('locates the real helper script in this checkout with the default locator', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = execOk();
    expect(await cmdFleetSafariImport(['status'], { exec })).toBe(0);
    const argv = exec.mock.calls[0]![1] as string[];
    expect(argv[1]).toMatch(/scripts[/\\]mac-bridge[/\\]safari_import\.py$/);
    expect(existsSync(argv[1]!)).toBe(true);
  });
});
