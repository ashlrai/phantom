import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

// Simulate legacy empty references: today's envelope validator rejects them on both write and read.
vi.mock('../src/core/fleet/bus-envelope.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/bus-envelope.js')>();
  return { ...actual, validateBusEnvelope: (input: unknown) => {
    if (input && typeof input === 'object' && 'channel_ref' in input && input.channel_ref === '') {
      const checked = actual.validateBusEnvelope({ ...input, channel_ref: 'fake-placeholder' });
      if (checked.ok) return { ...checked, value: { ...checked.value, channel_ref: '' },
        json: JSON.stringify(input) };
    }
    return actual.validateBusEnvelope(input);
  } };
});

let root: string;
let now: number;
const post = (id: string, ref?: string) => {
  const envelope: BusEnvelope = {
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    ...(ref === undefined ? {} : { channel: 'slack' as const, channel_ref: ref,
      sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true }, external: false }),
    body: { kind: 'work' },
  };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  now += 1_000;
};
const read = (id: string) => readReplyState(id, { root, now });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-empty-thread-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('reply-state without a usable thread', { timeout: 60_000 }, () => {
  it.each([['empty', ''], ['whitespace', '   '], ['missing', undefined]])(
    'keeps %s references independent and their evidence separate', (_label, ref) => {
      post('fake-first', ref);
      expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
      post('fake-second', ref);
      expect(read('fake-first')).toMatchObject({ id: 'fake-first', duplicateOf: null, state: 'RUNNING', owner: 'fake-owner',
        claim: expect.stringContaining('bus-claim:fake-first') });
      expect(read('fake-second')).toMatchObject({ id: 'fake-second', duplicateOf: null, state: 'RECEIVED', owner: null, claim: null,
        evidence: { running: null, blocked: null, verified: null } });
    },
  );

  it('still groups an exact nonblank reference by arrival cursor', () => {
    post('fake-first', ' fake-thread ');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
    post('fake-repeat', ' fake-thread ');
    post('fake-distinct', 'fake-thread');
    expect(read('fake-repeat')).toMatchObject({ id: 'fake-first', duplicateOf: 'fake-first', owner: 'fake-owner' });
    expect(read('fake-distinct')).toMatchObject({ id: 'fake-distinct', duplicateOf: null, owner: null });
  });
});
