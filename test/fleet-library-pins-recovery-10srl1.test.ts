import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { cmdFleetLibraryPins } from '../src/cli/fleet-library-pins.js';
import { addPin, libraryPinsPath, listPins, LIBRARY_PINS_MAX } from '../src/core/fleet/library-pins.js';

let home: string;
let clock: number;
let oldHome: string | undefined;
const options = () => ({ home, now: () => clock++ });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'library-pins-'));
  oldHome = process.env.HOME;
  process.env.HOME = home;
  clock = 1_793_577_600_000;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it('dispatches the actual fleet CLI and preserves JSON and removal exit contracts', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleet(['library-pins', '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ v: 1, pins: [] });
  expect(await cmdFleet(['library-pins', 'add', '--kind', 'file', '--ref', '/missing/file', '--title', 'File', '--json'])).toBe(0);
  const pin = JSON.parse(log.mock.calls.at(-1)![0] as string).pin;
  expect(listPins({ home })).toEqual([pin]);
  expect(await cmdFleet(['library-pins', 'remove', pin.id, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ v: 1, removed: true });
  expect(await cmdFleet(['library-pins', 'remove', pin.id, '--json'])).toBe(1);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ v: 1, removed: false });
});

it('stores all kinds, deduplicates kind and ref, orders newest first and caps at 50', () => {
  const first = addPin({ kind: 'memory', ref: 'shared', title: 'Memory' }, options());
  expect(addPin({ kind: 'memory', ref: 'shared', title: 'Changed' }, options())).toEqual(first);
  for (const kind of ['bus', 'file', 'note']) addPin({ kind, ref: 'shared', title: kind }, options());
  expect(listPins(options()).map((pin) => pin.kind)).toEqual(['note', 'file', 'bus', 'memory']);
  for (let i = 0; i < LIBRARY_PINS_MAX; i++) addPin({ kind: 'note', ref: `note-${i}`, title: 'Note' }, options());
  const pins = listPins(options());
  expect(pins).toHaveLength(50);
  expect(pins[0]!.ref).toBe('note-49');
  expect(pins.some((pin) => pin.id === first.id)).toBe(false);
  expect(readdirSync(join(home, '.phantom'))).toEqual(['library-pins.json']);
  if (process.platform !== 'win32') expect(statSync(libraryPinsPath(home)).mode & 0o777).toBe(0o600);
});

it('rejects malformed input and secret-shaped values without writing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const fake = 'sk-' + 'FAKE0000000000000000';
  for (const input of [
    { kind: 'note', ref: fake, title: 'Fake' },
    { kind: 'note', ref: 'ok', title: fake },
    { kind: 'note', ref: 'x'.repeat(513), title: 'ok' },
    { kind: 'note', ref: 'ok', title: 'x'.repeat(161) },
    { kind: 'note', ref: 'two\nlines', title: 'ok' },
    { kind: 'bad', ref: 'ok', title: 'ok' },
  ]) expect(() => addPin(input, options())).toThrow();
  expect(await cmdFleetLibraryPins(['add', '--kind', 'bad', '--ref', 'x', '--title', 'x', '--json'], options())).toBe(2);
  expect(listPins(options())).toEqual([]);
});

it('refuses damaged existing data without overwriting it', async () => {
  mkdirSync(join(home, '.phantom'));
  const damaged = '{"v":1,"pins":[{"id":"nope"}]}';
  writeFileSync(libraryPinsPath(home), damaged);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetLibraryPins(['--json'], options())).toBe(1);
  expect(await cmdFleetLibraryPins(['add', '--kind', 'note', '--ref', 'a', '--title', 'a'], options())).toBe(2);
  expect(await cmdFleetLibraryPins(['remove', 'pin_000000000000'], options())).toBe(1);
  expect(readFileSync(libraryPinsPath(home), 'utf8')).toBe(damaged);
});
