import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetLibraryPins } from '../src/cli/fleet-library-pins.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'pins-cli-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return { last: () => JSON.parse(log.mock.calls.at(-1)![0] as string), log, error };
}

it('lists as JSON, adds then removes', async () => {
  const out = capture();
  expect(await cmdFleetLibraryPins(['--json'], { home })).toBe(0);
  expect(out.last()).toEqual({ v: 1, pins: [] });

  expect(await cmdFleetLibraryPins(['add', '--kind', 'bus', '--ref', 'm7', '--title', 'worker → leader: shipped', '--json'], { home })).toBe(0);
  const { pin } = out.last();
  expect(pin).toMatchObject({ kind: 'bus', ref: 'm7', title: 'worker → leader: shipped' });
  expect(Number.isFinite(Date.parse(pin.pinnedAt))).toBe(true);

  expect(await cmdFleetLibraryPins(['--json'], { home })).toBe(0);
  expect(out.last().pins).toEqual([pin]);

  expect(await cmdFleetLibraryPins(['remove', pin.id, '--json'], { home })).toBe(0);
  expect(out.last()).toEqual({ v: 1, removed: true });
  expect(await cmdFleetLibraryPins(['remove', pin.id], { home })).toBe(1);
  expect(await cmdFleetLibraryPins(['--json'], { home })).toBe(0);
  expect(out.last().pins).toEqual([]);
});

it('refuses bad input with usage or a reason', async () => {
  const out = capture();
  expect(await cmdFleetLibraryPins(['add', '--kind', 'note', '--ref', 'x'], { home })).toBe(2);
  expect(await cmdFleetLibraryPins(['add', '--kind', 'note', '--ref', 'sk-' + 'FAKE0000000000000000', '--title', 'k'], { home })).toBe(2);
  expect(out.error.mock.calls.at(-1)![0]).toMatch(/looks like a secret/);
  expect(await cmdFleetLibraryPins(['bogus'], { home })).toBe(2);
  expect(await cmdFleetLibraryPins(['--help'], { home })).toBe(0);
  expect(out.log.mock.calls.at(-1)![0]).toMatch(/ashlr fleet library-pins/);
});
