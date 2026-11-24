import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetPoolReadings } from '../src/cli/fleet-pool-readings.js';
import { showPoolReadings } from '../src/core/usage/pool-reading.js';

const now = 1_800_000_000;
let root = '';
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('measured pool readings', () => {
  it('reports historical measurements and refuses invalid files without modifying them', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    root = await mkdtemp(join(tmpdir(), 'pool-readings-'));
    const queue = join(root, 'queue'); await mkdir(queue);
    const records: Record<string, string> = {
      zero: JSON.stringify({ pct: 0, ts: now - 5, reset_at: now + 100, src: 'fixture zero' }),
      old: JSON.stringify({ pct: 42, ts: now - 28800, reset_at: now + 100, src: 'fixture old' }),
      expired: JSON.stringify({ pct: 7, ts: now - 60, reset_at: now - 1, src: 'fixture expired' }),
      malformed: '{', range: JSON.stringify({ pct: 101, ts: now, reset_at: now + 1, src: 'fixture' }),
      future: JSON.stringify({ pct: 3, ts: now + 1, reset_at: now + 2, src: 'fixture' }),
      large: 'x'.repeat(4096), extra: JSON.stringify({ pct: 0, ts: now, reset_at: now + 1, src: 'fixture', extra: true }),
    };
    for (const [name, contents] of Object.entries(records)) await writeFile(join(queue, `${name}-reading.json`), contents);
    await mkdir(join(queue, 'directory-reading.json'));
    const result = await showPoolReadings(undefined, root);
    const byName = Object.fromEntries(result.readings.map(view => [view.pool, view]));
    expect(byName.zero).toMatchObject({ reading: { pct: 0, reset_at: now + 100, src: 'fixture zero' }, stale: false });
    expect(byName.old).toMatchObject({ reading: { pct: 42 }, stale: true });
    expect(byName.expired).toMatchObject({ reading: { pct: 7, reset_at: now - 1, src: 'fixture expired' }, stale: true });
    for (const name of ['malformed', 'range', 'future', 'large', 'extra', 'directory']) {
      expect(byName[name]).toMatchObject({ reading: null, ageSeconds: null, stale: true, error: 'Reading missing or invalid' });
    }
    expect((await showPoolReadings('absent', root)).readings[0]).toMatchObject({ pool: 'absent', reading: null, stale: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reader = (pool?: string) => showPoolReadings(pool, root);
    expect(await cmdFleetPoolReadings(['--json'], reader)).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(result);
    expect(await cmdFleetPoolReadings(['absent', '--json'], reader)).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).readings[0]).toMatchObject({
      pool: 'absent', reading: null, ageSeconds: null, stale: true,
    });
    expect(await cmdFleetPoolReadings(['expired', '--json'], reader)).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).readings[0]).toMatchObject(byName.expired);
    expect(await cmdFleetPoolReadings(['expired'], reader)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(`reset ${now - 1}`);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('stale');
    expect(await cmdFleetPoolReadings(['absent'], reader)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('Reading missing or invalid · age unknown');
    for (const [name, contents] of Object.entries(records)) expect(await readFile(join(queue, `${name}-reading.json`), 'utf8')).toBe(contents);
    expect((await lstat(join(queue, 'directory-reading.json'))).isDirectory()).toBe(true);
    await expect(lstat(join(queue, 'absent-reading.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses symlinks and preserves both the link and its target', async (context) => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    root = await mkdtemp(join(tmpdir(), 'pool-readings-link-'));
    const queue = join(root, 'queue'); await mkdir(queue);
    const target = join(root, 'target.json');
    const contents = JSON.stringify({ pct: 0, ts: now, reset_at: now + 100, src: 'fixture link target' });
    await writeFile(target, contents);
    const link = join(queue, 'link-reading.json');
    try { await symlink(target, link); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip('Platform does not permit creating fixture symlinks');
        return;
      }
      throw error;
    }
    expect((await showPoolReadings('link', root)).readings[0]).toMatchObject({
      reading: null, ageSeconds: null, stale: true, error: 'Reading missing or invalid',
    });
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe(contents);
  });

  it('sanitizes source labels for text without changing the recorded measurement', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    root = await mkdtemp(join(tmpdir(), 'pool-readings-source-'));
    const queue = join(root, 'queue'); await mkdir(queue);
    const reading = { pct: 12, ts: now, reset_at: now + 100, src: 'fixture\nzero\u200b label\t' + 'x'.repeat(220) };
    const contents = JSON.stringify(reading);
    const file = join(queue, 'label-reading.json'); await writeFile(file, contents);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reader = (pool?: string) => showPoolReadings(pool, root);
    expect(await cmdFleetPoolReadings(['label'], reader)).toBe(0);
    const text = String(log.mock.calls.at(-1)?.[0]);
    expect(text).toContain('fixture zero label ');
    expect(text).not.toMatch(/[\n\t\u200b]/u);
    expect(text).toContain('fixture zero label ' + 'x'.repeat(181));
    expect(text).not.toContain('x'.repeat(183));
    expect((await showPoolReadings('label', root)).readings[0].reading?.src).toBe(reading.src);
    expect(await readFile(file, 'utf8')).toBe(contents);
  });

  it('distinguishes a missing queue from an unreadable queue and reports CLI read errors', async () => {
    root = await mkdtemp(join(tmpdir(), 'pool-readings-missing-'));
    expect(await showPoolReadings(undefined, root)).toEqual({ readings: [], staleAfterSeconds: 28800 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = (pool?: string) => showPoolReadings(pool, root);
    expect(await cmdFleetPoolReadings([], reader)).toBe(0);
    expect(log).toHaveBeenLastCalledWith('No readings recorded.');
    await writeFile(join(root, 'queue'), 'fixture invalid directory');
    await expect(showPoolReadings(undefined, root)).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await cmdFleetPoolReadings(['--json'], reader)).toBe(1);
    expect(error).toHaveBeenLastCalledWith('error: pool readings unavailable');
  });

  it('rejects invalid arguments without reading', async () => {
    const reader = vi.fn(); vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--bad'], ['Bad'], ['../outside'], [''], ['a'.repeat(41)], ['a', 'b'], ['--json', '--json']]) {
      expect(await cmdFleetPoolReadings(args, reader)).toBe(2);
    }
    expect(reader).not.toHaveBeenCalled();
  });
});
