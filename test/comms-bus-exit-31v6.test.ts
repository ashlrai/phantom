import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { busStatusExitCode } from '../src/cli/comms-bus-exit.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: vi.fn(() => { throw Error('must not load'); }) }));
vi.mock('../src/core/comms/dispatch.js', () => ({ runCommsCycle: vi.fn(() => { throw Error('must not deliver'); }) }));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('busStatusExitCode: success statuses -> 0', () => {
  expect(busStatusExitCode('ok')).toBe(0);
  expect(busStatusExitCode('posted')).toBe(0);
  expect(busStatusExitCode('duplicate')).toBe(0);
});
it('busStatusExitCode: invalid -> 2', () => {
  expect(busStatusExitCode('invalid')).toBe(2);
});
it('busStatusExitCode: store/server failures -> 1', () => {
  expect(busStatusExitCode('unavailable')).toBe(1);
  expect(busStatusExitCode('retryable')).toBe(1);
  expect(busStatusExitCode('full')).toBe(1);
  expect(busStatusExitCode('conflict')).toBe(1);
});
it('busStatusExitCode: unknown -> 1', () => {
  expect(busStatusExitCode('phantom')).toBe(1);
  expect(busStatusExitCode('')).toBe(1);
  expect(busStatusExitCode(null as unknown as string)).toBe(1);
});
it('cmdCommsBus: malformed options returns 2', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['garbage'])).toBe(2);
  expect(await cmdCommsBus(['post', '--oops'])).toBe(2);
  expect(await cmdCommsBus(['read', '--limit', '0'])).toBe(2);
  expect(await cmdCommsBus(['read', '--after', '1e3'])).toBe(2);
}, 60_000);
it('cmdCommsBus: invalid envelope file returns 2', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comms-bus-exit-')); roots.push(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = join(root, 'bad.json');
  writeFileSync(file, 'not json at all', { mode: 0o600 });
  expect(await cmdCommsBus(['post', '--file', file], { root })).toBe(2);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
}, 60_000);
it('cmdCommsBus: out-of-range cursor (invalid status) returns 2', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comms-bus-exit-')); roots.push(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const options = { root, now: () => 100 };
  expect(await cmdCommsBus(['read', '--after', '1'], options)).toBe(2);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
}, 60_000);
it('cmdCommsBus: successful post/read round-trip returns 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comms-bus-exit-')); roots.push(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = join(root, 'env.json');
  writeFileSync(file, JSON.stringify({ id: 'x1', from: 'a', to: 'b', priority: 'P1', ttl: 99999, body: 'hi' }), { mode: 0o600 });
  const options = { root, now: () => 100 };
  expect(await cmdCommsBus(['post', '--file', file], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toHaveProperty('status', 'posted');
  expect(await cmdCommsBus(['read'], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toHaveProperty('status', 'ok');
}, 60_000);
