import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let root: string;
let now: number;
const post = (id: string, ref: string, overrides: Partial<BusEnvelope> = {}, at = now) => {
  const envelope: BusEnvelope = {
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: ref,
    sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
    external: false, body: { kind: 'work' }, ...overrides,
  };
  expect(appendBusInbox(envelope, { root, now: () => at }).status).toBe('posted');
};
const read = (id: string) => readReplyState(id, { root, now });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-slack-identity-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('Slack reply thread identity', { timeout: 60_000 }, () => {
  it.each([
    ['slack:TFAKE:CFAKE:000123.4500', 'TFAKE/CFAKE/123.45'],
    ['TFAKE/CFAKE/000000.000', 'slack:TFAKE:CFAKE:0.0'],
    ['TFAKE/CFAKE/9007199254740993.100', 'TFAKE/CFAKE/09007199254740993.1'],
  ])('retains the first claim across equivalent references and clock rollback', (first, repeat) => {
    post('fake-first', first);
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
    post('fake-repeat', repeat, {}, now - 1000);
    const original = read('fake-first');
    expect(original).toMatchObject({ id: 'fake-first', owner: 'fake-owner', claim: expect.stringContaining('bus-claim:fake-first') });
    expect(read('fake-repeat')).toMatchObject({ id: 'fake-first', duplicateOf: 'fake-first', state: original.state,
      owner: original.owner, claim: original.claim, evidence: original.evidence });
  });

  it.each([
    ['different time', 'TFAKE/CFAKE/9007199254740992.1', {}],
    ['different fraction', 'TFAKE/CFAKE/9007199254740993.2', {}],
    ['different team', 'TOTHER/CFAKE/9007199254740993.1', {}],
    ['different channel', 'TFAKE/COTHER/9007199254740993.1', {}],
    ['different sender', 'TFAKE/CFAKE/9007199254740993.1', { from: 'fake-other' }],
    ['different recipient', 'TFAKE/CFAKE/9007199254740993.1', { to: 'fake-other' }],
    ['different transport', 'TFAKE/CFAKE/9007199254740993.1', { channel: 'imessage' as const }],
    ['malformed', 'slack:TFAKE:CFAKE:9007199254740993.1000x', {}],
    ['blank', ' ', {}],
  ])('keeps %s independent', (_label, ref, overrides) => {
    post('fake-first', 'slack:TFAKE:CFAKE:9007199254740993.100');
    post('fake-other', ref, overrides);
    expect(read('fake-other')).toMatchObject({ id: 'fake-other', duplicateOf: null, owner: null, claim: null });
  });

  it('keeps exact opaque references grouped, but not blank references or non-Slack variants', () => {
    post('fake-opaque', 'opaque-thread');
    post('fake-opaque-repeat', 'opaque-thread', {}, now - 1000);
    post('fake-blank', ' ');
    post('fake-blank-repeat', ' ');
    post('fake-other-transport', 'slack:TFAKE:CFAKE:01.10', { channel: 'imessage' });
    post('fake-other-variant', 'TFAKE/CFAKE/1.1', { channel: 'imessage' });
    expect(read('fake-opaque-repeat')).toMatchObject({ id: 'fake-opaque', duplicateOf: 'fake-opaque' });
    expect(read('fake-blank-repeat')).toMatchObject({ id: 'fake-blank-repeat', duplicateOf: null });
    expect(read('fake-other-variant')).toMatchObject({ id: 'fake-other-variant', duplicateOf: null });
  });
});
