import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryResume } from '../src/cli/fleet-apps-recovery-resume.js';

const A = '12345678-1234-4123-8123-123456789abc';
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'resume-stdin-')); dirs.push(d); return d; };
const flags = ['--max-age-ms', '1000', '--duration-ms', '10', '--interval-ms', '100', '--wait-all', '--stream'];
let cwd: string, errors: string[];
beforeEach(() => { cwd = process.cwd(); process.chdir(dir()); errors = []; vi.spyOn(console, 'error').mockImplementation((m: string) => { errors.push(String(m)); }); });
afterEach(() => { process.chdir(cwd); vi.restoreAllMocks(); vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const piped = (text?: string) => { const s = new PassThrough({ autoDestroy: false }); if (text !== undefined) s.end(text); return s; };
const body = (root: string, ids: string[] = [A]) => JSON.stringify({ version: 1, invocationIds: ids, root });
const clean = (s: PassThrough) => ['data', 'end', 'error', 'close'].every(e => s.listenerCount(e) === 0);

it('forwards a piped request to the waiter once, with no file written', async () => {
  const root = dir(), waiter = vi.fn(async () => 0), stdin = piped(body(root));
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', ...flags, '--stop-file', 'stop'], { waiter, stdin })).toBe(0);
  expect(waiter).toHaveBeenCalledTimes(1);
  expect(waiter).toHaveBeenCalledWith(['--invocation', A, '--root', root, '--max-age-ms', '1000', '--duration-ms', '10', '--interval-ms', '100', '--wait-all', '--stream', '--stop-file', 'stop']);
  expect(existsSync('-')).toBe(false);
  expect(clean(stdin)).toBe(true);
  expect(stdin.destroyed).toBe(false);
});

it('allows an identical explicit root and rejects a conflicting one', async () => {
  const root = dir(), waiter = vi.fn(async () => 0);
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', '--root', root, ...flags], { waiter, stdin: piped(body(root)) })).toBe(0);
  expect(waiter).toHaveBeenCalledTimes(1);
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', '--root', dir(), ...flags], { waiter, stdin: piped(body(root)) })).toBe(2);
  expect(waiter).toHaveBeenCalledTimes(1);
});

it('rejects invocation arguments in stdin mode', async () => {
  const root = dir(), waiter = vi.fn(async () => 0);
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', '--invocation', A, ...flags], { waiter, stdin: piped(body(root)) })).toBe(2);
  expect(waiter).not.toHaveBeenCalled();
});

it.each([
  ['duplicate ids', (r: string) => body(r, [A, A])],
  ['malformed', () => '{nope'],
  ['empty', () => ''],
  ['relative root', () => body('relative/root')],
  ['oversize', () => 'x'.repeat(16 * 1024 + 1)],
])('rejects %s with one generic diagnostic', async (_n, make) => {
  const root = dir(), waiter = vi.fn(async () => 0), stdin = piped(make(root));
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', ...flags], { waiter, stdin })).toBe(1);
  expect(waiter).not.toHaveBeenCalled();
  expect(errors).toHaveLength(1);
  expect(errors[0]).not.toContain(root);
  expect(existsSync('-')).toBe(false);
  expect(clean(stdin)).toBe(true);
  expect(stdin.destroyed).toBe(false);
});

it('times out on a stream that never ends and cleans up', async () => {
  vi.useFakeTimers();
  const waiter = vi.fn(async () => 0), stdin = new PassThrough();
  stdin.write('{"version"');
  const result = cmdFleetAppsRecoveryResume(['--request', '-', ...flags], { waiter, stdin });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe(1);
  expect(waiter).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(clean(stdin)).toBe(true);
  expect(stdin.destroyed).toBe(false);
});

it('honours the injected deadline and leaves no timer after success', async () => {
  vi.useFakeTimers();
  const root = dir(), waiter = vi.fn(async () => 0), stdin = new PassThrough();
  const result = cmdFleetAppsRecoveryResume(['--request', '-', ...flags], { waiter, stdin, stdinTimeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toBe(1);
  const ok = piped(body(root));
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', ...flags], { waiter, stdin: ok })).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
