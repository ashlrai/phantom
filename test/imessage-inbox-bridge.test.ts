/**
 * RQ-IMSG-BRIDGE-1: iMessage intake channel.
 *
 * Modules under test: integrations/imessage.ts (allowlist, read-only argv, ROWID
 * cursor) and comms/imessage-inbox-bridge.ts (receipt, dedupe, ack record).
 *
 * Hermetic: node:child_process is mocked, HOME and runsDir are tmp dirs, and
 * the handles are placeholders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let calls: { file: string; args: string[] }[] = [];
let stdoutFor: (args: string[]) => string = () => '';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      calls.push({ file, args });
      cb(null, stdoutFor(args), '');
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

import { imessageAllowlist, pollInboundSince, readCursor, readOnlyUri, writeCursor } from '../src/core/integrations/imessage.js';
import { imessageChannelMessage, ingestIMessages, senderIdFor } from '../src/core/comms/imessage-inbox-bridge.js';
import { QueueStore } from '../src/core/queue/store.js';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = '<MASON_HANDLE>';
const OTHER = '<OTHER_HANDLE>';
const APPLE_OFFSET_MS = 978_307_200_000;

function cfg(comms: Record<string, unknown> = {}): AshlrConfig {
  return { comms: { enabled: true, imessageHandle: MASON, ...comms } } as unknown as AshlrConfig;
}

const row = (rowid: number, text: string, handle = MASON) =>
  ({ rowid, date: (Date.now() - APPLE_OFFSET_MS) * 1_000_000, handle, text });

let home = '';
let runsDir = '';
let previousHome: string | undefined;
let platform: PropertyDescriptor;

const sqliteCalls = () => calls.filter((c) => c.file === 'sqlite3');
const inbox = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');

beforeEach(() => {
  calls = [];
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-runs-'));
  process.env['HOME'] = home;
  mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  stdoutFor = () => '[]';
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

describe('imessageAllowlist', () => {
  it('uses imessageAllow when set', () => {
    expect(imessageAllowlist(cfg({ imessageAllow: [MASON, OTHER, ' ', 5] }))).toEqual([MASON, OTHER]);
  });
  it('falls back to [imessageHandle] when imessageAllow is unset or empty', () => {
    expect(imessageAllowlist(cfg())).toEqual([MASON]);
    expect(imessageAllowlist(cfg({ imessageAllow: [] }))).toEqual([MASON]);
  });
  it('is empty when nothing is configured (never a built-in handle)', () => {
    expect(imessageAllowlist({ comms: { enabled: true } } as AshlrConfig)).toEqual([]);
  });
});

describe('pollInboundSince', () => {
  it('opens chat.db read-only via execFile argv, with the allowlist and cursor in the SQL', async () => {
    await pollInboundSince(41, cfg({ imessageAllow: [MASON, OTHER] }));
    const [call] = sqliteCalls();
    expect(call!.args[0]).toBe('-readonly');
    const uri = call!.args.find((a) => a.startsWith('file:'))!;
    expect(uri).toMatch(/\?mode=ro$/);
    expect(uri).toBe(readOnlyUri(join(home, 'Library', 'Messages', 'chat.db')));
    const sql = call!.args[call!.args.length - 1]!;
    expect(sql).toContain('m.ROWID > 41');
    expect(sql).toContain("lower(h.id) IN ('<mason_handle>','<other_handle>')");
    expect(sql).toContain('is_from_me = 0');
  });

  it('drops rows from non-allowlisted handles even if the database returned them', async () => {
    stdoutFor = () => JSON.stringify([row(5, 'mine'), row(6, 'not yours', OTHER), row(7, 'again mine', MASON.toUpperCase())]);
    const polled = await pollInboundSince(4, cfg());
    expect(polled.ok && polled.messages.map((m) => m.rowid)).toEqual([5, 7]);
  });

  it('keeps newlines and pipes in text inside one record', async () => {
    stdoutFor = () => JSON.stringify([row(9, 'a|b\nc|d')]);
    const polled = await pollInboundSince(8, cfg());
    expect(polled.ok && polled.messages).toHaveLength(1);
  });

  it('is disabled without comms.enabled and unsupported off darwin', async () => {
    expect(await pollInboundSince(0, cfg({ enabled: false }))).toEqual({ ok: false, state: 'disabled' });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(await pollInboundSince(0, cfg())).toEqual({ ok: false, state: 'unsupported' });
    expect(sqliteCalls()).toHaveLength(0);
  });
});

describe('cursor file', () => {
  it('persists the ROWID with mode 0600 and rejects garbage', () => {
    writeCursor(12, runsDir);
    const file = join(runsDir, 'imessage', 'cursor.json');
    expect(readCursor(runsDir)).toBe(12);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, '{"rowid":-3}');
    expect(readCursor(runsDir)).toBeNull();
    expect(() => writeCursor(1.5, runsDir)).toThrow();
  });
});

describe('ingestIMessages', () => {
  it('first run baselines to the newest ROWID and ingests no history', async () => {
    stdoutFor = (args) => (args.some((a) => /MAX\(ROWID\)/.test(a)) ? '120\n' : JSON.stringify([row(1, 'old history')]));
    const result = await ingestIMessages(cfg(), { runsDir });
    expect(result).toMatchObject({ ok: true, state: 'baselined', cursor: 120, accepted: 0 });
    expect(readCursor(runsDir)).toBe(120);
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
    expect(sqliteCalls().every((c) => c.args[0] === '-readonly')).toBe(true);
  });

  it('receipts allowlisted messages as channel imessage and advances the ROWID cursor', async () => {
    writeCursor(10, runsDir);
    stdoutFor = () => JSON.stringify([row(11, 'focus the fleet on billing'), row(14, 'also check the queue')]);
    const result = await ingestIMessages(cfg(), { runsDir });
    expect(result).toMatchObject({ ok: true, state: 'ingested', scanned: 2, accepted: 2, duplicate: 0, refused: 0, cursor: 14 });
    expect(readCursor(runsDir)).toBe(14);

    const text = inbox();
    expect(text.match(/\[src:imessage id:/g)).toHaveLength(2);
    expect(text).toContain('focus the fleet on billing');
    expect(text).not.toContain(MASON);

    // Commands reach the chief-of-staff queue through the shared receiver.
    const jobs = (await new QueueStore(join(runsDir, 'queue'), 250).read()).jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.scope).sort()).toEqual(['also check the queue', 'focus the fleet on billing']);
    expect(jobs[0]!.acceptance).toContain(senderIdFor(MASON));
    expect(jobs[0]!.acceptance).not.toContain(MASON);
  });

  it('records the shared ack text and never sends it', async () => {
    writeCursor(0, runsDir);
    stdoutFor = () => JSON.stringify([row(3, 'hello fleet')]);
    await ingestIMessages(cfg(), { runsDir });
    const lines = readFileSync(join(runsDir, 'imessage', 'acks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rowid: 3, status: 'accepted', delivery: 'recorded-not-sent' });
    expect(lines[0].text).toBe(formatChannelAck({ channel: 'imessage', dedupeKey: lines[0].receipt, status: 'accepted' }));
    expect(JSON.stringify(lines[0])).not.toContain('hello fleet');
    expect(calls.filter((c) => c.file === 'osascript')).toHaveLength(0);
  });

  it('a repeat of the same words is a duplicate, not a second entry', async () => {
    writeCursor(0, runsDir);
    stdoutFor = () => JSON.stringify([row(1, 'same words twice'), row(2, 'same words twice')]);
    const result = await ingestIMessages(cfg(), { runsDir });
    expect(result).toMatchObject({ accepted: 1, duplicate: 1, cursor: 2 });
    expect(inbox().match(/\[src:imessage id:/g)).toHaveLength(1);
  });

  it('refuses secret-shaped text without storing it, and still moves the cursor past it', async () => {
    writeCursor(0, runsDir);
    stdoutFor = () => JSON.stringify([row(1, 'password=plainly-fake-example'), row(2, 'a normal note')]);
    const result = await ingestIMessages(cfg(), { runsDir });
    expect(result).toMatchObject({ accepted: 1, refused: 1, cursor: 2 });
    expect(inbox()).not.toContain('plainly-fake-example');
  });

  it('does nothing when disabled or without an allowlist', async () => {
    expect(await ingestIMessages(cfg({ enabled: false }), { runsDir })).toMatchObject({ ok: false, state: 'disabled' });
    expect(await ingestIMessages({ comms: { enabled: true } } as AshlrConfig, { runsDir })).toMatchObject({ state: 'disabled' });
    expect(sqliteCalls()).toHaveLength(0);
  });

  it('reports a blocked chat.db and leaves the cursor alone', async () => {
    writeCursor(7, runsDir);
    const result = await ingestIMessages(cfg(), { runsDir, poll: async () => ({ ok: false, state: 'blocked_full_disk_access' }) });
    expect(result).toMatchObject({ ok: false, state: 'blocked_full_disk_access', cursor: 7 });
    expect(readCursor(runsDir)).toBe(7);
  });
});

describe('imessageChannelMessage', () => {
  it('maps to channel imessage with a hashed sender and the ROWID as thread', () => {
    const m = imessageChannelMessage({ rowid: 5, text: 'hi', ts: 1, handle: MASON })!;
    expect(m).toEqual({ channel: 'imessage', verifiedSenderId: senderIdFor(MASON), body: 'hi', threadId: '5' });
    expect(m.verifiedSenderId).not.toContain(MASON);
    expect(senderIdFor(MASON.toUpperCase())).toBe(senderIdFor(MASON));
  });
  it('rejects a non-positive ROWID or empty handle', () => {
    expect(imessageChannelMessage({ rowid: 0, text: 'hi', ts: 1, handle: MASON })).toBeNull();
    expect(imessageChannelMessage({ rowid: 3, text: 'hi', ts: 1, handle: ' ' })).toBeNull();
  });
});
