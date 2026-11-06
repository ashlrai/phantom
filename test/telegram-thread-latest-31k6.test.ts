import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupTelegramMessage, recordTelegramMessages, telegramIdForThread, THREAD_MAP_KEEP } from '../src/core/comms/telegram-thread-map.js';

describe('Telegram thread mapping recency', () => {
  let home: string;
  let previousHome: string | undefined;
  let path: string;

  beforeEach(() => {
    previousHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'telegram-thread-latest-'));
    process.env['HOME'] = home;
    path = join(home, '.ashlr', 'comms', 'telegram-thread.json');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('selects the last recorded message, independently of ID or timestamp', () => {
    recordTelegramMessages([900], { kind: 'message', threadId: 'thread', at: 'later' });
    recordTelegramMessages([100, 50], { kind: 'message', threadId: 'thread', at: 'earlier' });
    expect(telegramIdForThread('thread')).toBe(50);
    expect(telegramIdForThread('absent')).toBeUndefined();
    expect(telegramIdForThread(undefined)).toBeUndefined();
  });

  it('moves a rerecorded ID to the latest position and replaces its old mapping', () => {
    recordTelegramMessages([1, 2], { kind: 'message', threadId: 'thread' });
    recordTelegramMessages([1], { kind: 'answer', threadId: 'thread' });
    expect(telegramIdForThread('thread')).toBe(1);
    expect(lookupTelegramMessage(1)?.kind).toBe('answer');
    recordTelegramMessages([1], { kind: 'message', threadId: 'other' });
    expect(telegramIdForThread('thread')).toBe(2);
    expect(telegramIdForThread('other')).toBe(1);
  });

  it('records only positive safe integer IDs', () => {
    const invalid = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
    recordTelegramMessages(invalid, { kind: 'message', threadId: 'invalid' });
    expect(telegramIdForThread('invalid')).toBeUndefined();
    recordTelegramMessages([...invalid, 1, Number.MAX_SAFE_INTEGER], { kind: 'message', threadId: 'valid' });
    expect(telegramIdForThread('valid')).toBe(Number.MAX_SAFE_INTEGER);
    for (const id of invalid) expect(lookupTelegramMessage(id)).toBeNull();
    expect(lookupTelegramMessage(1)?.threadId).toBe('valid');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('ignores malformed persisted entries without hiding older valid mappings', () => {
    mkdirSync(join(home, '.ashlr', 'comms'), { recursive: true });
    const entry = { tg: 7, threadId: 'thread', kind: 'message', at: 'recorded' };
    writeFileSync(path, JSON.stringify({ entries: [
      entry, null, {}, { ...entry, tg: -2 }, { ...entry, tg: 1.5 },
      { ...entry, tg: Number.MAX_SAFE_INTEGER + 1 }, { ...entry, tg: '8' },
      { ...entry, tg: 8, kind: ['message'] }, { ...entry, tg: 9, at: null },
      { ...entry, tg: 10, actionIds: ['ok', 1] }, { ...entry, tg: 11, threadId: 42 },
    ] }));
    expect(telegramIdForThread('thread')).toBe(7);
    expect(lookupTelegramMessage(8)).toBeNull();
    expect(lookupTelegramMessage(9)).toBeNull();
    expect(lookupTelegramMessage(10)).toBeNull();
    recordTelegramMessages([12], { kind: 'message', threadId: 'other' });
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(2);
    expect(telegramIdForThread('thread')).toBe(7);
  });

  it('retains only the latest bounded entries at the retention boundary', () => {
    recordTelegramMessages(Array.from({ length: THREAD_MAP_KEEP }, (_, i) => i + 1), { kind: 'message', threadId: 'thread' });
    expect(lookupTelegramMessage(1)?.tg).toBe(1);
    recordTelegramMessages([THREAD_MAP_KEEP + 1], { kind: 'message', threadId: 'other' });
    expect(lookupTelegramMessage(1)).toBeNull();
    expect(lookupTelegramMessage(2)?.tg).toBe(2);
    expect(telegramIdForThread('thread')).toBe(THREAD_MAP_KEEP);
    expect(telegramIdForThread('other')).toBe(THREAD_MAP_KEEP + 1);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(THREAD_MAP_KEEP);
  });
});
