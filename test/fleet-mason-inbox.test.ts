import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendInboxEntry, formatInboxEntry, INBOX_MAX_CHARS, parseInbox, readInboxEntries,
} from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const when = new Date('2026-01-02T05:04:05Z');
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'mason-inbox-'));
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

describe('Mason inbox', () => {
  it('appends exact UTF-8 entries and dispatch events in order', async () => {
    const first = '\n## 2026-01-02 00:04 ET (Mason, Phantom desktop) PRIORITY P0\nHéllo\nline two\n';
    const second = '\n## 2026-01-02 00:04 ET (Mason, Telegram) PRIORITY P0\nNext\n';
    expect(await appendInboxEntry('  Héllo\r\nline two  ', { runsDir, now: () => when })).toEqual({
      ok: true, at: '2026-01-02 00:04', bytes: Buffer.byteLength(first),
    });
    expect(await appendInboxEntry('Next', { runsDir, source: 'Telegram', now: () => when })).toEqual({
      ok: true, at: '2026-01-02 00:04', bytes: Buffer.byteLength(second),
    });
    expect(await readFile(inboxPath(), 'utf8')).toBe(first + second);
    expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8')).toBe(
      '2026-01-02 00:04:05 INBOX new entry from Phantom desktop\n' +
      '2026-01-02 00:04:05 INBOX new entry from Telegram\n',
    );
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [
      { at: '2026-01-02 00:04', source: 'Telegram', priority: 'P0', text: 'Next' },
      { at: '2026-01-02 00:04', source: 'Phantom desktop', priority: 'P0', text: 'Héllo\nline two' },
    ] });
  });

  it('formats Eastern time across daylight saving changes', () => {
    expect(formatInboxEntry(' x ', 'terminal', new Date('2026-07-04T16:03:02Z'))).toBe(
      '\n## 2026-07-04 12:03 ET (Mason, terminal) PRIORITY P0\nx\n',
    );
  });

  it('refuses invalid text before creating any files', async () => {
    expect(await appendInboxEntry(' \r\n ', { runsDir })).toEqual({ ok: false, reason: 'empty' });
    expect(await appendInboxEntry('x'.repeat(INBOX_MAX_CHARS + 1), { runsDir })).toEqual({ ok: false, reason: 'too-long' });
    expect(await appendInboxEntry('sk-FAKEFAKEFAKEFAKEFAKEFAKE1234', { runsDir })).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'missing', entries: [] });
    await expect(readFile(join(runsDir, 'dispatch-events.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await appendInboxEntry('x'.repeat(INBOX_MAX_CHARS), { runsDir })).ok).toBe(true);
  });

  it('falls back for unsafe, overlong, and secret-shaped sources', async () => {
    for (const source of ['terminal\ninjected', 'x'.repeat(41), 'sk-FAKEFAKEFAKEFAKEFAKEFAKE1234']) {
      expect((await appendInboxEntry('safe', { runsDir, source, now: () => when })).ok).toBe(true);
    }
    const file = await readFile(inboxPath(), 'utf8');
    expect(file.match(/Mason, Phantom desktop/g)).toHaveLength(3);
    expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8')).toBe(
      '2026-01-02 00:04:05 INBOX new entry from Phantom desktop\n'.repeat(3),
    );
  });

  it('parses current and legacy headings newest first, with a limit', () => {
    const fixture = [
      'preamble',
      '## 2026-01-01 01:02 ET (Mason, terminal) PRIORITY P1', 'first',
      '## legacy heading', 'old', 'body',
      '## 2026-01-02 03:04 ET (Someone, Phantom page) PRIORITY P2', 'second',
      '## 2026-01-03 05:06 ET (Mason, Telegram) PRIORITY P0', 'third', '',
    ].join('\n');
    const expected = [
      { at: '2026-01-03 05:06', source: 'Telegram', priority: 'P0', text: 'third' },
      { at: '2026-01-02 03:04', source: 'Phantom page', priority: 'P2', text: 'second' },
      { at: '## legacy heading', source: 'unknown', priority: null, text: 'old\nbody' },
      { at: '2026-01-01 01:02', source: 'terminal', priority: 'P1', text: 'first' },
    ];
    expect(parseInbox(fixture)).toEqual(expected);
    expect(parseInbox(fixture, 2)).toEqual(expected.slice(0, 2));
    expect(parseInbox(fixture, 0)).toEqual([]);
    expect(parseInbox(`## legacy\n${'a'.repeat(6001)}`)[0]?.text).toHaveLength(6000);
    expect(parseInbox(Array.from({ length: 22 }, (_, i) => `## entry ${i}\ntext`).join('\n'))).toHaveLength(20);
  });

  it('reads only the tail and discards a partial first line', async () => {
    await mkdir(join(runsDir, 'leader'));
    const recent = '\n## 2026-01-02 00:04 ET (Mason, terminal) PRIORITY P0\nrecent\n';
    await writeFile(inboxPath(), '## old\n' + 'x'.repeat(256 * 1024) + recent);
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [
      { at: '2026-01-02 00:04', source: 'terminal', priority: 'P0', text: 'recent' },
    ] });
  });

  it('reports unreadable paths and failed writes', async () => {
    await writeFile(join(runsDir, 'leader'), 'not a directory');
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'degraded', entries: [] });
    expect(await appendInboxEntry('hello', { runsDir })).toEqual({ ok: false, reason: 'write-failed' });
  });

  it('reports failure if the event log cannot be appended after the inbox write', async () => {
    await mkdir(join(runsDir, 'dispatch-events.log'));
    expect(await appendInboxEntry('hello', { runsDir, now: () => when })).toEqual({ ok: false, reason: 'write-failed' });
    expect(await readFile(inboxPath(), 'utf8')).toBe(formatInboxEntry('hello', 'Phantom desktop', when));
  });
});
