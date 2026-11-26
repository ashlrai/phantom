import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdChannelsReplyState } from '../src/cli/channels-reply-state.js';
import * as replyState from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

let home: string, previousHome: string | undefined, now: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reply-running-proof-'));
  chmodSync(home, 0o700);
  previousHome = process.env['ASHLR_HOME'];
  process.env['ASHLR_HOME'] = home;
  now = Date.parse('2026-11-14T12:30:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = previousHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it('prints recorded live lease proof separately from as-of and preserves JSON', async () => {
  const root = join(home, 'fleet');
  const envelope: BusEnvelope = { id: 'fake-work', from: 'fake-peer', to: 'fake-lane', priority: 'P2',
    ttl: 1_000_000_000, body: { kind: 'work' } };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-work', owner: 'fake-owner', leaseMs: 60_000, root }).status).toBe('acquired');
  now += 1_000;
  const state = replyState.readReplyState('fake-work', { root, now });
  expect(state.state).toBe('RUNNING');
  expect(state.evidence.running).not.toBeNull();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdChannelsReplyState(['fake-work'])).toBe(0);
  const text = String(log.mock.lastCall?.[0]);
  expect(text).toContain('owner fake-owner, claim');
  expect(text).toContain(`Evidence as of: ${state.asOf}`);
  expect(text).toContain(`Running evidence:\nSource: ${state.evidence.running?.source}\nRecorded at: ${state.evidence.running?.at}`);
  log.mockClear();
  expect(await cmdChannelsReplyState(['fake-work', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual(state);
  now += 120_000;
  expect(replyState.readReplyState('fake-work', { root, now }).state).toBe('ASSIGNED');
  log.mockClear();
  await cmdChannelsReplyState(['fake-work']);
  expect(String(log.mock.lastCall?.[0])).not.toContain('Running evidence:');
  log.mockClear();
  await cmdChannelsReplyState(['fake-missing']);
  expect(String(log.mock.lastCall?.[0])).not.toContain('Running evidence:');
});

it('does not add running proof to blocked or verified replies', async () => {
  const root = join(home, 'fleet');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [id, body, expected] of [
    ['fake-blocked', { blocked: { dependency: 'fake-dependency' } }, 'BLOCKED'],
    ['fake-verified', { verified: { pr: 7, head: 'fake-head' } }, 'VERIFIED'],
  ] as const) {
    expect(appendBusInbox({ id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 1_000_000,
      body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    expect(postBusReply(id, `${id}-reply`, body, { root, now: () => now }).outcome).toBe('posted');
    expect(replyState.readReplyState(id, { root, now }).state).toBe(expected);
    log.mockClear();
    await cmdChannelsReplyState([id]);
    expect(String(log.mock.lastCall?.[0])).not.toContain('Running evidence:');
  }
});

it('normalizes control characters in both running proof fields', async () => {
  const state = replyState.readReplyState('fake-missing', { root: join(home, 'fleet'), now });
  vi.spyOn(replyState, 'readReplyState').mockReturnValue({ ...state, state: 'RUNNING',
    evidence: { ...state.evidence, running: { source: 'fake\nsource\u001b[2J', at: 'fake\r\ntime\u2028end' } } });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdChannelsReplyState(['fake-missing']);
  expect(String(log.mock.lastCall?.[0])).toContain(`Evidence as of: ${state.asOf}`);
  expect(String(log.mock.lastCall?.[0])).toContain('Running evidence:\nSource: fake source [2J\nRecorded at: fake time end');
});
