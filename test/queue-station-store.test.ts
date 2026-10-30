import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { stationEvent } from '../src/core/observability/router-queue.js';
import { appendStationEvents, MAX_STATION_JOURNAL_BYTES, readStationEvents } from '../src/core/observability/router-queue-store.js';

const job = { jobId: 'RQ-QUEUE-2', repo: 'ashlrai/phantom', attempt: '1' };
const observedAt = '2026-10-26T12:00:00.000Z';
const planned = () => stationEvent(job, 'planned', observedAt, 'router-queue', {});
const ready = () => stationEvent(job, 'READY', observedAt, 'router-queue', {});
let directory: string;
let journal: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'phantom-queue-store-'));
  journal = join(directory, 'stations.json');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('router queue station journal', () => {
  it('treats a missing journal as empty without creating state', () => {
    const absent = join(directory, 'absent', 'stations.json');
    expect(readStationEvents(absent)).toEqual([]);
    expect(appendStationEvents(absent, [])).toEqual({ added: [], events: [] });
    expect(existsSync(join(directory, 'absent'))).toBe(false);
  });

  it('creates private state and preserves the complete ordered history', () => {
    journal = join(directory, 'new-store', 'stations.json');
    expect(appendStationEvents(journal, [planned()])).toEqual({ added: [planned()], events: [planned()] });
    expect(appendStationEvents(journal, [ready()])).toEqual({ added: [ready()], events: [planned(), ready()] });
    expect(readStationEvents(journal)).toEqual([planned(), ready()]);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual({ schemaVersion: 1, events: [planned(), ready()] });
    if (process.platform !== 'win32') {
      expect(lstatSync(journal).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(directory, 'new-store')).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(`${journal}.lock`)).toBe(false);
  });

  it('deduplicates both a batch and replay while keeping the first observation time', () => {
    appendStationEvents(journal, [planned(), planned(), ready()]);
    const before = lstatSync(journal);
    const later = { ...planned(), observedAt: '2026-10-26T13:00:00.000Z' };
    expect(appendStationEvents(journal, [later])).toEqual({ added: [], events: [planned(), ready()] });
    expect(lstatSync(journal).ino).toBe(before.ino);
  });

  it('fails closed on malformed data without overwriting it or exposing content', () => {
    const corrupt = '{"secret":"SECRET_CANARY"';
    writeFileSync(journal, corrupt, { mode: 0o600 });
    expect(() => readStationEvents(journal)).toThrow('Station journal is unavailable or unsafe');
    expect(() => appendStationEvents(journal, [ready()])).toThrow('Station journal is unavailable or unsafe');
    expect(readFileSync(journal, 'utf8')).toBe(corrupt);
    expect(existsSync(`${journal}.lock`)).toBe(false);
  });

  it.each([
    { schemaVersion: 2, events: [] },
    { schemaVersion: 1, events: [], extra: 'SECRET_CANARY' },
    { schemaVersion: 1, events: [planned(), planned()] },
    { schemaVersion: 1, events: [{ ...planned(), eventId: '0'.repeat(64) }] },
  ])('refuses invalid journal envelopes and event identities: %j', value => {
    writeFileSync(journal, JSON.stringify(value), { mode: 0o600 });
    expect(() => readStationEvents(journal)).toThrow('Station journal is unavailable or unsafe');
  });

  it('validates an entire incoming batch before changing disk', () => {
    appendStationEvents(journal, [planned()]);
    const before = readFileSync(journal, 'utf8');
    expect(() => appendStationEvents(journal, [ready(), { ...planned(), eventId: 'invalid' }])).toThrow('Invalid station journal events');
    expect(readFileSync(journal, 'utf8')).toBe(before);
  });

  it('refuses an oversized journal instead of dropping evidence', () => {
    writeFileSync(journal, '', { mode: 0o600 });
    truncateSync(journal, MAX_STATION_JOURNAL_BYTES + 1);
    expect(() => readStationEvents(journal)).toThrow('Station journal is unavailable or unsafe');
    expect(() => appendStationEvents(journal, [ready()])).toThrow('Station journal is unavailable or unsafe');
    expect(lstatSync(journal).size).toBe(MAX_STATION_JOURNAL_BYTES + 1);
  });

  it.skipIf(process.platform === 'win32')('refuses symlink files and directories without touching their targets', () => {
    const target = join(directory, 'target.json');
    writeFileSync(target, 'untouched', { mode: 0o600 });
    symlinkSync(target, journal);
    expect(() => readStationEvents(journal)).toThrow('Station journal is unavailable or unsafe');
    expect(() => appendStationEvents(journal, [planned()])).toThrow('Station journal is unavailable or unsafe');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    const realDirectory = join(directory, 'real');
    mkdirSync(realDirectory, { mode: 0o700 });
    const alias = join(directory, 'alias');
    symlinkSync(realDirectory, alias);
    expect(() => appendStationEvents(join(alias, 'events.json'), [planned()])).toThrow('Station journal is unavailable or unsafe');
    expect(existsSync(join(realDirectory, 'events.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses hardlinks and non-private permissions', () => {
    appendStationEvents(journal, [planned()]);
    linkSync(journal, join(directory, 'hardlink'));
    expect(() => readStationEvents(journal)).toThrow('Station journal is unavailable or unsafe');
    rmSync(join(directory, 'hardlink'));
    chmodSync(journal, 0o644);
    expect(() => readStationEvents(journal)).toThrow('Station journal is unavailable or unsafe');
    chmodSync(journal, 0o600);
    chmodSync(directory, 0o755);
    expect(() => appendStationEvents(journal, [ready()])).toThrow('Station journal is unavailable or unsafe');
    expect(lstatSync(directory).mode & 0o777).toBe(0o755);
    chmodSync(directory, 0o700);
  });

  it('refuses a contended writer lock without replacing its owner or losing receipts', () => {
    appendStationEvents(journal, [planned()]);
    const lock = acquireLocalStoreLock(`${journal}.lock`, 0, { anchorPath: directory, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try {
      expect(() => appendStationEvents(journal, [ready()])).toThrow('Station journal is busy or unavailable');
      expect(ownsLocalStoreLock(lock)).toBe(true);
      expect(readStationEvents(journal)).toEqual([planned()]);
    } finally { expect(releaseLocalStoreLock(lock)).toBe(true); }
    expect(appendStationEvents(journal, [ready()]).events).toEqual([planned(), ready()]);
  });
});
