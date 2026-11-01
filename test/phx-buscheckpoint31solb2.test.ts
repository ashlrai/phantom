import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

const io = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (io.fail && String(args[0]).includes('.bus-checkpoint-')) throw new Error('fake write failure');
    return fs.openSync(...args);
  } };
});

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-checkpoint-')); roots.push(root);
  return { root, path: join(root, 'checkpoint.json') };
}
afterEach(() => { io.fail = false; vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (id: string, to = 'worker') => ({ id, from: 'coordinator', to, priority: 'P1', ttl: 3600000, body: 'fake-private-content' });
const state = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

it('two real CLI processes resume filtered scan state and retain later matching messages', () => {
  const { root, path } = setup();
  const run = (args: string[]) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), 'comms', 'bus', ...args], {
      env: { ...process.env, HOME: root, ASHLR_HOME: join(root, 'bus') }, encoding: 'utf8', timeout: 30000,
    });
    expect(child.stderr).toBe(''); expect(child.status).toBe(0);
    return JSON.parse(child.stdout);
  };
  const post = (id: string, to?: string) => {
    const file = join(root, `${id}.json`); writeFileSync(file, JSON.stringify(message(id, to)), { mode: 0o600 });
    expect(run(['post', '--file', file]).status).toBe('posted');
  };
  post('unmatched', 'elsewhere');
  expect(run(['read', '--checkpoint', path, '--to', 'worker', '--limit', '1'])).toEqual({ status: 'ok', messages: [], nextCursor: 1 });
  expect(state(path).scanCursor).toBe(1);
  post('later');
  const resumed = run(['watch', '--checkpoint', path, '--to', 'worker', '--max-pages', '1']);
  expect(resumed.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['later']);
  expect(state(path).scanCursor).toBe(2);
  expect(readFileSync(path, 'utf8')).not.toContain('fake-private-content');
  if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
}, 60000);

it.each(['read', 'watch'])('%s does not advance on rejected output and releases its lock', async verb => {
  const { root, path } = setup();
  expect(appendBusInbox(message('one'), { root }).status).toBe('posted');
  const args = [verb, '--checkpoint', path, ...(verb === 'watch' ? ['--max-pages', '1'] : [])];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdCommsBus(args, { root }, { emit: async () => { throw new Error('fake sink failure'); } })).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(await cmdCommsBus(args, { root }, { emit: () => {} })).toBe(0);
  expect(state(path).scanCursor).toBe(1);
  const previous = readFileSync(path, 'utf8');
  expect(appendBusInbox(message('two'), { root }).status).toBe('posted');
  expect(await cmdCommsBus(args, { root }, { emit: () => { throw new Error('fake sink failure'); } })).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(previous);
});

it.each(['{', '{}', 'x'.repeat(8193)])('refuses corrupt or unrelated state (%#) without overwriting it', async text => {
  const { root, path } = setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  writeFileSync(path, text, { mode: 0o600 });
  expect(await cmdCommsBus(['read', '--checkpoint', path], { root })).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(text);
});

it('fails clearly on filter mismatch without overwriting state', async () => {
  const { root, path } = setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', path, '--to', 'worker'], { root }, { emit: () => {} })).toBe(0);
  const previous = readFileSync(path, 'utf8');
  expect(await cmdCommsBus(['read', '--checkpoint', path], { root })).toBe(1);
  expect(String(error.mock.calls.at(-1))).toContain('filter mismatch');
  expect(readFileSync(path, 'utf8')).toBe(previous);
});

it('refuses symlinks and an unrelated file introduced during output', async () => {
  const { root, path } = setup(), target = join(root, 'unrelated');
  writeFileSync(target, 'unrelated', { mode: 0o600 }); symlinkSync(target, path);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', path], { root })).toBe(1);
  rmSync(path);
  expect(await cmdCommsBus(['read', '--checkpoint', path], { root }, { emit: () => { writeFileSync(path, 'unrelated', { mode: 0o600 }); } })).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe('unrelated');
  expect(readFileSync(target, 'utf8')).toBe('unrelated');
});

it('rejects relative paths and combining after with checkpoint', async () => {
  const { root, path } = setup();
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', path, '--after', '0'], { root })).toBe(2);
  expect(await cmdCommsBus(['read', '--checkpoint', 'relative'], { root })).toBe(1);
  expect(existsSync(path)).toBe(false);
});

it('retains the last delivered cursor when a private write fails', async () => {
  const { root, path } = setup();
  const args = ['read', '--checkpoint', path];
  expect(await cmdCommsBus(args, { root }, { emit: () => {} })).toBe(0);
  const previous = readFileSync(path, 'utf8');
  expect(appendBusInbox(message('one'), { root }).status).toBe('posted');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const emit = vi.fn(() => { io.fail = true; });
  expect(await cmdCommsBus(args, { root }, { emit })).toBe(1);
  expect(emit).toHaveBeenCalledOnce();
  expect(readFileSync(path, 'utf8')).toBe(previous);
  io.fail = false;
  expect(await cmdCommsBus(args, { root }, { emit: () => {} })).toBe(0);
  expect(state(path).scanCursor).toBe(1);
});
