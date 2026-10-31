import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import { appendInboxEntry, formatInboxEntry } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const when = new Date('2026-01-02T05:04:05Z');
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'inbox-receipt-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('primary inbox receipt', () => {
  it('returns only a generic failure when the primary append fails', async () => {
    await mkdir(join(runsDir, 'leader'));
    await mkdir(inboxPath());
    const result = await appendInboxEntry('fake message', { runsDir, now: () => when });
    expect(result).toEqual({ ok: false, reason: 'write-failed' });
    await expect(readFile(join(runsDir, 'dispatch-events.log'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the normal receipt and persists exactly one entry when the event path fails', async () => {
    await mkdir(join(runsDir, 'dispatch-events.log'));
    const entry = formatInboxEntry('fake message', 'Phantom desktop', when);
    expect(await appendInboxEntry('fake message', { runsDir, now: () => when })).toEqual({
      ok: true, at: '2026-01-02 00:04', bytes: Buffer.byteLength(entry),
    });
    expect(await readFile(inboxPath(), 'utf8')).toBe(entry);
  });

  it('writes one bounded event on normal success, with a sanitized source', async () => {
    const source = 'fake source\ninjected';
    const text = 'fake message';
    const entry = formatInboxEntry(text, source, when);
    expect(await appendInboxEntry(text, { runsDir, source, now: () => when })).toEqual({
      ok: true, at: '2026-01-02 00:04', bytes: Buffer.byteLength(entry),
    });
    expect(await readFile(inboxPath(), 'utf8')).toBe(entry);
    expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8')).toBe(
      '2026-01-02 00:04:05 INBOX new entry from Phantom desktop\n',
    );
  });

  it('acknowledges a repeated channel message as duplicate after event failure', async () => {
    await mkdir(join(runsDir, 'dispatch-events.log'));
    const receive = createChannelReceiver({ runsDir, now: () => when, allowedSenderIds: new Set(['fake-sender']) });
    const message = { channel: 'email' as const, verifiedSenderId: 'fake-sender', body: 'fake message' };
    const first = await receive(message);
    const second = await receive(message);
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(second.ok && second.ack).toEqual({
      channel: 'email', dedupeKey: first.ok && first.ack.dedupeKey, status: 'duplicate',
    });
    expect(await readFile(inboxPath(), 'utf8')).toBe(formatInboxEntry(message.body, 'email', when));
  });
});
