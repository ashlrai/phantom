import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('persists a normalized desktop order for the CLI and deduplicates its mobile replay after restart', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'fake-channel-roundtrip-'));
  roots.push(runsDir);
  const sender = 'fake-canonical-operator';
  const options = {
    runsDir,
    allowedSenderIds: new Set([sender]),
    now: () => new Date('2026-10-31T04:13:00Z'),
  };
  const desktopAcks: ChannelAck[] = [];
  const mobileAcks: ChannelAck[] = [];
  const normalized = 'Prepare café notes.\nShare the next steps.';
  const desktopEntry = { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: normalized };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = createCommsInboxCommand({ runsDir });
  const readInbox = async () => {
    expect(await read(['read', '--json'])).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as unknown;
  };

  const first = await createChannelReceiver({
    ...options, acknowledge: async ack => { desktopAcks.push(ack); },
  })({ channel: 'desktop', verifiedSenderId: sender, body: '  Prepare cafe\u0301 notes.\r\nShare the next steps.  ' });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('desktop submission was not accepted');
  expect(first.ack).toEqual({ channel: 'desktop', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(desktopAcks).toEqual([first.ack]);
  expect(await readInbox()).toEqual({ sourceState: 'healthy', entries: [desktopEntry] });

  const receiveMobile = createChannelReceiver({
    ...options, acknowledge: async ack => { mobileAcks.push(ack); },
  });
  const replay = await receiveMobile({ channel: 'mobile', verifiedSenderId: sender, body: normalized });
  expect(replay.ok).toBe(true);
  if (!replay.ok) throw new Error('mobile replay was not acknowledged');
  expect(replay.ack).toEqual({ channel: 'mobile', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
  expect(mobileAcks).toEqual([replay.ack]);
  expect(await readInbox()).toEqual({ sourceState: 'healthy', entries: [desktopEntry] });

  const next = await receiveMobile({ channel: 'mobile', verifiedSenderId: sender, body: 'Review the next milestone.' });
  expect(next.ok).toBe(true);
  if (!next.ok) throw new Error('distinct mobile instruction was not accepted');
  expect(next.ack).toEqual({ channel: 'mobile', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(next.ack.dedupeKey).not.toBe(first.ack.dedupeKey);
  expect(mobileAcks).toEqual([replay.ack, next.ack]);
  expect(await readInbox()).toEqual({
    sourceState: 'healthy',
    entries: [
      { at: '2026-10-31 00:13', source: 'mobile', priority: 'P0', text: 'Review the next milestone.' },
      desktopEntry,
    ],
  });
});
