import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stewardSchedule } from '../src/core/steward/schedule.js';
import { cmdSteward } from '../src/cli/steward.js';

const { activate, built } = vi.hoisted(() => ({ activate: vi.fn(() => ({ status: 0, error: undefined as Error | undefined })), built: { ready: true } }));
vi.mock('node:child_process', () => ({ spawnSync: activate }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: import('node:fs').PathLike) => String(path).endsWith('/dist/cli/index.js') ? built.ready : fs.existsSync(path) };
});

describe('steward schedule', () => {
  it('macOS: per-user LaunchAgent, report-only by default', () => {
    const [u] = stewardSchedule({ phmPath: '/opt/phm/bin/phm', apply: false, platform: 'darwin', home: '/Users/m' });
    expect(u!.path).toBe('/Users/m/Library/LaunchAgents/ai.ashlr.phm.steward.plist');
    expect(u!.contents).toContain('<string>steward</string><string>disk</string><string>--json</string>');
    expect(u!.contents).not.toContain('--apply');
  });
  it('linux: user service + timer, apply only when chosen', () => {
    const units = stewardSchedule({ phmPath: '/usr/local/bin/phm', apply: true, hour: 4, platform: 'linux', home: '/home/m' });
    expect(units.map((u) => u.path)).toEqual(['/home/m/.config/systemd/user/phm-steward.service', '/home/m/.config/systemd/user/phm-steward.timer']);
    expect(units[0]!.contents).toContain('"--apply"');
    expect(units[1]!.contents).toContain('OnCalendar=*-*-* 04:17:00');
  });
  it('rejects relative or injected phm paths', () => {
    expect(() => stewardSchedule({ phmPath: 'phm', apply: false, platform: 'linux', home: '/h' })).toThrow();
    expect(() => stewardSchedule({ phmPath: '/x\nExecStart=/bin/sh', apply: false, platform: 'linux', home: '/h' })).toThrow();
  });
  it.each([NaN, Infinity, -1, 24, 3.5])('rejects invalid hour %s', (hour) => {
    expect(() => stewardSchedule({ phmPath: '/bin/phm', apply: false, hour, platform: 'linux' })).toThrow(/hour/);
  });
  it.each(['relative', '/path\rInjected', '/path\u0000bad'])('rejects unsafe paths %j', (path) => {
    for (const field of ['phmPath', 'nodePath', 'home']) {
      expect(() => stewardSchedule({ phmPath: '/bin/phm', apply: false, platform: 'linux', [field]: path })).toThrow(/paths/);
    }
  });
  it('refuses unsupported platforms', () => {
    expect(() => stewardSchedule({ phmPath: '/bin/phm', apply: false, platform: 'win32' })).toThrow(/macOS and Linux/);
  });
  it('escapes XML and pins Node instead of depending on service PATH', () => {
    const [unit] = stewardSchedule({ phmPath: '/path with & <tags>/phm', nodePath: '/node/bin/node', apply: false, platform: 'darwin', home: '/h' });
    expect(unit!.contents).toContain('<string>/node/bin/node</string><string>/path with &amp; &lt;tags&gt;/phm</string>');
    expect(unit!.contents).toContain('<integer>3</integer><key>Minute</key><integer>17</integer>');
  });
  it('quotes systemd argv and neutralizes variable and specifier expansion', () => {
    const [unit] = stewardSchedule({ phmPath: '/a b/"$HOME%h\\phm', nodePath: '/node $USER%h/bin/node', apply: false, platform: 'linux', home: '/home/a b%u' });
    expect(unit!.contents).toContain('ExecStart="/node $USER%%h/bin/node" "/a b/\\"$$HOME%%h\\\\phm" "steward" "disk" "--json"');
    expect(unit!.contents).toContain('StandardOutput=append:/home/a b%%u/.ashlr/logs/steward.jsonl');
    expect(unit!.activate).toEqual(['systemctl', '--user', 'daemon-reload']);
  });
});

describe.each(['darwin', 'linux'] as const)('steward schedule CLI (%s)', (platform) => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  let output: string[];
  let errors: string[];
  let previousHome: string;
  let home: string;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 });
    built.ready = true;
    previousHome = process.env['HOME']!;
    home = mkdtempSync(join(tmpdir(), 'steward-schedule-'));
    process.env['HOME'] = home;
    output = []; errors = []; activate.mockReset().mockReturnValue({ status: 0, error: undefined });
    vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor); else delete process.getuid;
    process.env['HOME'] = previousHome; rmSync(home, { recursive: true, force: true });
  });
  const units = () => stewardSchedule({ phmPath: '/bin/phm', apply: false });
  it('previews without creating jobs or logs or starting services', async () => {
    expect(await cmdSteward(['schedule'])).toBe(0);
    expect(output.join('\n')).toContain('/bin/ashlr');
    expect(output.join('\n')).not.toContain('src/cli/index.ts');
    expect(output.join('\n')).not.toContain('--apply</string>');
    expect(existsSync(units()[0]!.path)).toBe(false);
    expect(existsSync(join(homedir(), '.ashlr', 'logs'))).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it.each([
    ['schedule', '--install', '--apply', '--help'], ['schedule', '-h'],
  ])('help does not install: %j', async (...args) => {
    expect(await cmdSteward(args)).toBe(0);
    expect(output.join('\n')).toContain('Usage:');
    expect(activate).not.toHaveBeenCalled();
    expect(existsSync(units()[0]!.path)).toBe(false);
  });
  it.each([
    ['--hour'], ['--hour', 'NaN'], ['--hour', '24'], ['--hour', '3.5'],
    ['--hour', ''], ['--hour', '--apply'], ['--instal'], ['--install', '--install'], ['--json'],
  ])('refuses invalid options before writing: %j', async (...args) => {
    expect(await cmdSteward(['schedule', ...args])).toBe(2);
    expect(existsSync(units()[0]!.path)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it('installs private user jobs and activates them, without opting into cleanup', async () => {
    expect(await cmdSteward(['schedule', '--install', '--hour', '4'])).toBe(0);
    for (const unit of units()) {
      expect(lstatSync(unit.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(unit.path, 'utf8')).not.toContain('--apply');
    }
    expect(activate.mock.calls).toEqual(units().filter((unit) => unit.activate.length).map((unit) => [unit.activate[0], unit.activate.slice(1), { stdio: 'inherit', timeout: 30_000 }]));
    expect(output.join('\n')).toContain('Steward scheduled daily (report-only)');
  });
  it('installs apply only when explicitly selected', async () => {
    expect(await cmdSteward(['schedule', '--install', '--apply'])).toBe(0);
    expect(readFileSync(units()[0]!.path, 'utf8')).toContain('--apply');
  });
  it('refuses root installation before writing', async () => {
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 });
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(errors.join('\n')).toContain('not root');
    expect(existsSync(units()[0]!.path)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it('refuses installation without a built CLI', async () => {
    built.ready = false;
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(errors.join('\n')).toContain('Compiled CLI missing');
    expect(existsSync(units()[0]!.path)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it('refuses unsupported platforms without writing', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(errors.join('\n')).toContain('macOS and Linux');
    expect(activate).not.toHaveBeenCalled();
  });
  it('preserves an existing job and never activates a partial install', async () => {
    const last = units().at(-1)!;
    mkdirSync(dirname(last.path), { recursive: true }); writeFileSync(last.path, 'existing job');
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(readFileSync(last.path, 'utf8')).toBe('existing job');
    if (units().length > 1) expect(existsSync(units()[0]!.path)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it('refuses linked configuration directories', async () => {
    const outside = join(homedir(), 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(homedir(), process.platform === 'darwin' ? 'Library' : '.config'));
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(existsSync(join(outside, process.platform === 'darwin' ? 'LaunchAgents' : 'systemd'))).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it('refuses a linked log and removes newly written jobs', async () => {
    const outside = join(homedir(), 'precious'); writeFileSync(outside, 'keep');
    mkdirSync(join(homedir(), '.ashlr', 'logs'), { recursive: true });
    symlinkSync(outside, join(homedir(), '.ashlr', 'logs', 'steward.jsonl'));
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    for (const unit of units()) expect(existsSync(unit.path)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it.each([{ status: 1, error: undefined }, { status: 0, error: new Error('spawn failed') }])('reports activation failure: %j', async (result) => {
    activate.mockReturnValue(result);
    expect(await cmdSteward(['schedule', '--install'])).toBe(1);
    expect(errors.join('\n')).toContain('activation failed');
    expect(output.join('\n')).not.toContain('Steward scheduled daily');
    expect(existsSync(units()[0]!.path)).toBe(true);
  });
});
