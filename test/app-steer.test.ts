import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdApp } from '../src/cli/app.js';
import { steerLeaders } from '../src/core/fleet/app-steer.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'app-steer-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('writes one inbox entry, then reports a duplicate without a second write', async () => {
  const first = await steerLeaders('  Pause new PRs on fake-repo.  ', { runsDir: dir });
  expect(first).toMatchObject({ ok: true, status: 'accepted', channel: 'cli' });
  const second = await steerLeaders('Pause new PRs on fake-repo.', { runsDir: dir });
  expect(second).toMatchObject({ ok: true, status: 'duplicate' });
  const inbox = readdirInbox(dir);
  expect(inbox.match(/Pause new PRs on fake-repo\./g)).toHaveLength(1);
});

it('refuses empty and oversize text', async () => {
  expect(await steerLeaders('   ', { runsDir: dir })).toEqual({ ok: false, reason: 'empty' });
  expect(await steerLeaders('x'.repeat(6001), { runsDir: dir })).toEqual({ ok: false, reason: 'too-long' });
});

it('never writes secret shapes to the inbox', async () => {
  const secret = `sk-ant-api03-${'A'.repeat(40)}`;
  await steerLeaders(`use key ${secret} now`, { runsDir: dir });
  expect(readdirInbox(dir)).not.toContain(secret);
});

it('cmdApp steer --json prints one object and exits 0', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdApp(['steer', '--text', 'Hello fake leaders', '--json'], { runsDir: dir })).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ ok: true, status: 'accepted', channel: 'cli' });
});

it('cmdApp rejects bad arguments with exit 2 and help exits 0', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdApp(['steer'], { runsDir: dir })).toBe(2);
  expect(await cmdApp(['steer', '--text'], { runsDir: dir })).toBe(2);
  expect(await cmdApp(['steer', '--text', 'a', '--bogus'], { runsDir: dir })).toBe(2);
  expect(await cmdApp(['nope'], { runsDir: dir })).toBe(2);
  expect(await cmdApp(['steer', '--help'])).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('phm app steer --text');
});

function readdirInbox(root: string): string {
  try { return readFileSync(join(root, 'leader', 'MASON-INBOX.md'), 'utf8'); } catch { return ''; }
}
