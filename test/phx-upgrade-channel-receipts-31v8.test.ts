import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const sender = 'fake-canonical-mason';
const at = new Date('2026-10-31T04:13:00Z');
const legacyInbox = '# Mason inbox\n\n## 2026-10-30 23:59 ET (Mason, desktop) PRIORITY P0\nFake legacy order.\n';
const desktop = { channel: 'desktop' as const, verifiedSenderId: sender, body: '  Fake cafe\u0301\r\nupgrade order.  ' };
const mobile = { channel: 'mobile' as const, verifiedSenderId: sender, body: 'Fake café\nupgrade order.' };
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');
const receiptPath = (): string => join(runsDir, 'channel-receipts', 'receipts.json');
const options = () => ({ runsDir, allowedSenderIds: new Set([sender]), now: () => at });

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'upgrade-channel-receipts-'));
  await mkdir(join(runsDir, 'leader'));
  await writeFile(inboxPath(), legacyInbox);
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('3.30 channel receipts on a 3.29 inbox', () => {
  it('retains the desktop order and acknowledges a normalized mobile retry after restart', async () => {
    await expect(access(receiptPath())).rejects.toMatchObject({ code: 'ENOENT' });
    const desktopAcks: ChannelAck[] = [];
    const mobileAcks: ChannelAck[] = [];
    const first = await createChannelReceiver({ ...options(), acknowledge: async (ack) => { desktopAcks.push(ack); } })(desktop);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected an accepted desktop order');
    expect(first.envelope.body).toBe(mobile.body);
    expect(first.ack).toEqual({ channel: 'desktop', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(desktopAcks).toEqual([first.ack]);

    const receipt = await readFile(receiptPath(), 'utf8');
    const hash = createHash('sha256').update(JSON.stringify([sender, mobile.body])).digest('hex');
    expect(JSON.parse(receipt)).toEqual([[hash, at.getTime(), first.ack.dedupeKey]]);
    expect(receipt).not.toContain(sender);
    expect(receipt).not.toContain(mobile.body);
    const acceptedInbox = await readFile(inboxPath(), 'utf8');
    expect(acceptedInbox.startsWith(legacyInbox)).toBe(true);

    const receiveMobile = createChannelReceiver({ ...options(), acknowledge: async (ack) => { mobileAcks.push(ack); } });
    const retry = await receiveMobile(mobile);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected a duplicate mobile order');
    expect(retry.ack).toEqual({ channel: 'mobile', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(mobileAcks).toEqual([retry.ack]);
    expect(await receiveMobile({ ...mobile, verifiedSenderId: 'fake-other-sender' })).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(mobileAcks).toEqual([retry.ack]);
    expect(await readFile(receiptPath(), 'utf8')).toBe(receipt);
    expect(await readFile(inboxPath(), 'utf8')).toBe(acceptedInbox);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [
        { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: mobile.body },
        { at: '2026-10-30 23:59', source: 'desktop', priority: 'P0', text: 'Fake legacy order.' },
      ],
    });
  });

  it('preserves acceptance and the receipt when desktop acknowledgement transport fails', async () => {
    const failedAcks: ChannelAck[] = [];
    const first = await createChannelReceiver({
      ...options(),
      acknowledge: async (ack) => { failedAcks.push(ack); throw new Error('fake transport failure'); },
    })(desktop);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected acceptance despite transport failure');
    expect(first.ack).toEqual({ channel: 'desktop', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(failedAcks).toEqual([first.ack]);
    const receipt = await readFile(receiptPath(), 'utf8');
    expect(JSON.parse(receipt)).toEqual([[expect.stringMatching(/^[a-f0-9]{64}$/), at.getTime(), first.ack.dedupeKey]]);
    const acceptedInbox = await readFile(inboxPath(), 'utf8');

    const mobileAcks: ChannelAck[] = [];
    const retry = await createChannelReceiver({ ...options(), acknowledge: async (ack) => { mobileAcks.push(ack); } })(mobile);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected duplicate after transport failure');
    expect(retry.ack).toEqual({ channel: 'mobile', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(mobileAcks).toEqual([retry.ack]);
    expect(await readFile(receiptPath(), 'utf8')).toBe(receipt);
    expect(await readFile(inboxPath(), 'utf8')).toBe(acceptedInbox);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [
        { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: mobile.body },
        { at: '2026-10-30 23:59', source: 'desktop', priority: 'P0', text: 'Fake legacy order.' },
      ],
    });
  });
});
