import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { createChannelReceiver, type ChannelAck, type ChannelMessage } from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let root: string;
let home: string;
let runsDir: string;
let time: number;
const sender = 'fake-desktop-adapter-mason';
const orderBody = 'Fake order: ship the restart handoff.';
const order: ChannelMessage = { channel: 'desktop', verifiedSenderId: sender, body: orderBody };
const receiptPath = (): string => join(runsDir, 'channel-receipts', 'receipts.json');
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');
const eventsPath = (): string => join(runsDir, 'dispatch-events.log');
const bodyHash = (id: string, body: string): string =>
  createHash('sha256').update(JSON.stringify([id, body])).digest('hex');

// Each call is a fresh channel adapter boot: new in-memory receipts, the same
// persisted runsDir store, and its own acknowledgement transport recording.
const receiverFor = (acks: ChannelAck[], allowedSenderIds: ReadonlySet<string> = new Set([sender])) =>
  createChannelReceiver({
    runsDir,
    allowedSenderIds,
    now: () => new Date(time),
    acknowledge: async (ack) => { acks.push(ack); },
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'channelrestart31aj1-'));
  home = join(root, 'home');
  runsDir = join(root, 'runs');
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.stubEnv('USERPROFILE', home);
  await mkdir(home, { recursive: true });
  time = Date.parse('2026-10-31T04:13:00.000Z');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('day-one 3.30.0 channel restart contract (31aj1)', () => {
  it('deduplicates a same-channel retry after restart, still acknowledges it, and accepts a new order', async () => {
    const firstAcks: ChannelAck[] = [];
    const first = await receiverFor(firstAcks)(order);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('verified desktop order was refused');
    expect(first.envelope).toEqual({
      channel: 'desktop',
      verifiedSenderId: sender,
      receivedAt: '2026-10-31T04:13:00.000Z',
      body: orderBody,
      dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.ack).toEqual({ channel: 'desktop', status: 'accepted', dedupeKey: first.envelope.dedupeKey });
    expect(firstAcks).toEqual([first.ack]);

    const entry = { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: orderBody };
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [entry] });
    const receipt = await readFile(receiptPath(), 'utf8');
    expect(JSON.parse(receipt)).toEqual([[bodyHash(sender, orderBody), time, first.ack.dedupeKey]]);
    expect(receipt).not.toContain(sender);
    expect(receipt).not.toContain(orderBody);
    if (process.platform !== 'win32') {
      expect((await stat(receiptPath())).mode & 0o777).toBe(0o600);
    }

    time += 60_000;
    const retryAcks: ChannelAck[] = [];
    const restarted = receiverFor(retryAcks);
    const retry = await restarted(order);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('same-channel retry after restart was not acknowledged');
    expect(retry.envelope.receivedAt).toBe('2026-10-31T04:14:00.000Z');
    expect(retry.ack).toEqual({ channel: 'desktop', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(retryAcks).toEqual([retry.ack]);
    expect(retryAcks[0]).not.toBe(retry.ack);

    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [entry] });
    expect((await readFile(inboxPath(), 'utf8')).match(/^## /gm)).toHaveLength(1);
    expect(await readFile(receiptPath(), 'utf8')).toBe(receipt);
    expect(await readFile(eventsPath(), 'utf8')).toBe('2026-10-31 04:13:00 INBOX new entry from desktop\n');

    time += 60_000;
    const followUpBody = 'Fake order: attach the bridge notes.';
    const followUp = await restarted({ ...order, body: followUpBody });
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) throw new Error('new desktop order was refused');
    expect(followUp.ack).toEqual({
      channel: 'desktop', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(followUp.ack.dedupeKey).not.toBe(first.ack.dedupeKey);
    expect(retryAcks).toEqual([retry.ack, followUp.ack]);

    const entries = [
      { at: '2026-10-31 00:15', source: 'desktop', priority: 'P0', text: followUpBody },
      entry,
    ];
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries });
    expect(JSON.parse(await readFile(receiptPath(), 'utf8'))).toEqual([
      [bodyHash(sender, orderBody), Date.parse('2026-10-31T04:13:00.000Z'), first.ack.dedupeKey],
      [bodyHash(sender, followUpBody), time, followUp.ack.dedupeKey],
    ]);
    expect(await readFile(eventsPath(), 'utf8')).toBe(
      '2026-10-31 04:13:00 INBOX new entry from desktop\n2026-10-31 04:15:00 INBOX new entry from desktop\n',
    );

    const secondRestartAcks: ChannelAck[] = [];
    const replay = await receiverFor(secondRestartAcks)(order);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('replay after a second restart was not acknowledged');
    expect(replay.ack).toEqual({ channel: 'desktop', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(secondRestartAcks).toEqual([replay.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await createCommsInboxCommand({ runsDir })(['read', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      sourceState: 'healthy',
      entries: [...entries].reverse(),
    });

    await expect(readdir(home)).resolves.toEqual([]);
  });

  it('deduplicates a same-channel retry whose transport re-encoded the body after restart', async () => {
    const encoded = '  Fake order: pin the restarted channel.\r\nThen resume.  ';
    const normalized = 'Fake order: pin the restarted channel.\nThen resume.';
    const firstAcks: ChannelAck[] = [];
    const first = await receiverFor(firstAcks)({ ...order, body: encoded });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('verified desktop order was refused');
    expect(first.envelope.body).toBe(normalized);

    time += 60_000;
    const retryAcks: ChannelAck[] = [];
    const retry = await receiverFor(retryAcks)({ ...order, body: normalized });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('re-encoded same-channel retry was not acknowledged');
    expect(retry.ack).toEqual({ channel: 'desktop', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(retry.envelope.body).toBe(normalized);
    expect(retryAcks).toEqual([retry.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: normalized }],
    });
    expect(await readFile(eventsPath(), 'utf8')).toBe('2026-10-31 04:13:00 INBOX new entry from desktop\n');
  });

  it('keys dedupe to the verified identity, not the body, after restart', async () => {
    const firstAcks: ChannelAck[] = [];
    const first = await receiverFor(firstAcks)(order);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('verified desktop order was refused');
    const receipt = await readFile(receiptPath(), 'utf8');

    const restartAcks: ChannelAck[] = [];
    const restarted = receiverFor(restartAcks, new Set([sender, 'fake-intruder']));
    expect(await restarted({ ...order, verifiedSenderId: 'fake-unlisted' }))
      .toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(restartAcks).toEqual([]);
    expect(await readFile(receiptPath(), 'utf8')).toBe(receipt);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: orderBody }],
    });

    time += 60_000;
    const intruder = await restarted({ ...order, verifiedSenderId: 'fake-intruder' });
    expect(intruder.ok).toBe(true);
    if (!intruder.ok) throw new Error('distinct verified identity was treated as a duplicate');
    expect(intruder.ack).toEqual({ channel: 'desktop', status: 'accepted', dedupeKey: intruder.envelope.dedupeKey });
    expect(intruder.ack.dedupeKey).not.toBe(first.ack.dedupeKey);
    expect(restartAcks).toEqual([intruder.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [
        { at: '2026-10-31 00:14', source: 'desktop', priority: 'P0', text: orderBody },
        { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: orderBody },
      ],
    });
  });
});
