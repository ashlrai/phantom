import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CROSS_CHANNEL_WINDOW_MS, decideCrossChannelMerge, type RecentInboxEntry } from '../src/core/fleet/cross-channel-dedupe.js';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';

const T0 = Date.parse('2026-11-01T05:08:00.000Z');
const entry = (over: Partial<RecentInboxEntry> = {}): RecentInboxEntry => ({
  id: 'phone-abc', senderId: 'owner:fake', text: 'Ship the fix', receivedAt: T0, channels: ['phone'], ...over,
});
const env = (over: Partial<Parameters<typeof decideCrossChannelMerge>[0]> = {}) => ({
  text: 'Ship the fix', channel: 'telegram', senderId: 'owner:fake', receivedAt: T0 + 60_000, ...over,
});

describe('decideCrossChannelMerge', () => {
  it('merges the same text from another channel inside the window', () => {
    expect(decideCrossChannelMerge(env(), [entry()])).toEqual({ action: 'merge', entryId: 'phone-abc', addSource: 'telegram' });
  });
  it('appends outside the window', () => {
    expect(decideCrossChannelMerge(env({ receivedAt: T0 + CROSS_CHANNEL_WINDOW_MS }), [entry()])).toEqual({ action: 'append' });
  });
  it('never merges across senders or unproven senders', () => {
    expect(decideCrossChannelMerge(env({ senderId: 'someone:else' }), [entry()])).toEqual({ action: 'append' });
    expect(decideCrossChannelMerge(env(), [entry({ senderId: undefined })])).toEqual({ action: 'append' });
  });
  it('normalizes whitespace and case but does no fuzzy matching', () => {
    expect(decideCrossChannelMerge(env({ text: '  SHIP   the\nfix ' }), [entry()]).action).toBe('merge');
    expect(decideCrossChannelMerge(env({ text: 'Ship the fixes' }), [entry()])).toEqual({ action: 'append' });
  });
  it('leaves a same-channel repeat to the existing idempotent path', () => {
    expect(decideCrossChannelMerge(env({ channel: 'phone' }), [entry()])).toEqual({ action: 'append' });
    expect(decideCrossChannelMerge(env({ channel: 'telegram' }), [entry({ channels: ['phone', 'telegram'] })])).toEqual({ action: 'append' });
  });
});

describe('createChannelReceiver cross-channel merge', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  it('writes one entry attributed to both sources and acks each channel', async () => {
    dir = await mkdtemp(join(tmpdir(), 'xchan-dedupe-'));
    const acks: ChannelAck[] = [];
    let now = T0;
    const receive = createChannelReceiver({
      allowedSenderIds: new Set(['owner:fake']), runsDir: dir, now: () => new Date(now), publish: null,
      acknowledge: async (ack) => { acks.push(ack); },
    });
    const first = await receive({ channel: 'mobile', verifiedSenderId: 'owner:fake', body: 'Ship the fix' });
    now += 30_000;
    const second = await receive({ channel: 'telegram', verifiedSenderId: 'owner:fake', body: '  ship THE   fix ' });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(second.ok && second.ack.status).toBe('duplicate');

    const markdown = await readFile(join(dir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(markdown.match(/\[src:/g)).toHaveLength(1);
    expect(markdown).toMatch(/\[src:phone id:phone-[0-9a-f]{16}\] \[also:telegram\] Ship the fix/);
    expect(markdown).not.toContain('owner:fake');
    expect(parseInbox(markdown)).toHaveLength(1);

    expect(acks.map((a) => a.channel)).toEqual(['mobile', 'telegram']);
    expect(acks[1]!.entryId).toMatch(/^phone-/);
    expect(acks[1]!.dedupeKey).toBe(acks[0]!.dedupeKey);
  });
});
