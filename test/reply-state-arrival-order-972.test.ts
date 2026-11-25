import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let root: string;
let now: number;
const post = (id: string, channel: 'slack' | 'imessage', receivedAt: number) => {
  const envelope: BusEnvelope = {
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel, channel_ref: 'fake-thread',
    sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
    external: false, body: { kind: 'work' },
  };
  expect(appendBusInbox(envelope, { root, now: () => receivedAt }).status).toBe('posted');
};
const claim = (id: string, owner: string) =>
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs: 600_000, root }).status).toBe('acquired');
const read = (id: string) => readReplyState(id, { root, now });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-arrival-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('reply-state durable arrival order', { timeout: 60_000 }, () => {
  it.each([['rollback', -1000], ['equal', 0], ['increasing', 1000]])(
    'keeps the first request and its claim with %s timestamps', (_case, offset) => {
      post('fake-original', 'slack', now);
      claim('fake-original', 'fake-original-owner');
      post('fake-later', 'slack', now + offset);
      now += 2_000;
      claim('fake-later', 'fake-later-owner');
      const expected = { id: 'fake-original', state: 'RUNNING', owner: 'fake-original-owner',
        claim: expect.stringContaining('bus-claim:fake-original') };
      expect(read('fake-original')).toMatchObject({ ...expected, duplicateOf: null });
      expect(read('fake-later')).toMatchObject({ ...expected, duplicateOf: 'fake-original' });
    },
  );

  it('keeps the same reference in another channel independent after rollback', () => {
    post('fake-original', 'slack', now);
    claim('fake-original', 'fake-original-owner');
    post('fake-other', 'imessage', now - 1000);
    claim('fake-other', 'fake-other-owner');
    expect(read('fake-other')).toMatchObject({ id: 'fake-other', duplicateOf: null,
      owner: 'fake-other-owner', claim: expect.stringContaining('bus-claim:fake-other') });
    expect(read('fake-original')).toMatchObject({ id: 'fake-original', owner: 'fake-original-owner' });
  });
});
