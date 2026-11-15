/** BLOCKED from the durable bus store: a reply body `{"blocked":{"dependency"}}`
 * naming the request surfaces as evidence.blocker. Real temp store, fake data. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

let root: string, now: number;
const ID = 'RQ-PHX-FAKE-317';
const iso = (ms: number) => new Date(ms).toISOString();
const collect = () => collectBusWorkItemEvidence(ID, { root, now });
const classify = () => classifyWorkItem(collect().evidence, iso(now));
const reply = (rid: string, body: unknown, to = ID) => {
  now += 1_000;
  expect(postBusReply(to, rid, body, { root, now: () => now }).outcome).toBe('posted');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-item-blocked-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  expect(appendBusInbox({ id: ID, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
    body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('blocked bus replies', { timeout: 60_000 }, () => {
  it('BLOCKED with source and asOf from the reply', () => {
    reply('fake-blocked-1', { blocked: { dependency: ' fake-dependency-review ' } });
    const { evidence } = collect();
    expect(evidence.blocker).toEqual({ dependency: 'fake-dependency-review', source: 'bus-reply:fake-blocked-1', at: iso(now) });
    expect(classify()).toEqual({ state: 'BLOCKED', asOf: iso(now), source: 'bus-reply:fake-blocked-1', missing: [] });
  });

  it('a later verified reply outranks blocked', () => {
    reply('fake-blocked-1', { blocked: { dependency: 'fake-dependency-review' } });
    reply('fake-verified-1', { verified: { pr: 1, head: 'abc1234' } });
    expect(classify().state).toBe('VERIFIED');
  });

  it('the newer blocked reply wins, and a plain reply does not clear it', () => {
    reply('fake-blocked-1', { blocked: { dependency: 'fake-dep-old' } });
    reply('fake-blocked-2', { blocked: { dependency: 'fake-dep-new' } });
    reply('fake-plain', { text: 'still working' });
    expect(collect().evidence.blocker).toMatchObject({ dependency: 'fake-dep-new', source: 'bus-reply:fake-blocked-2' });
  });

  it.each([
    ['unknown', { blocked: { dependency: 'unknown' } }],
    ['UNKNOWN case', { blocked: { dependency: ' Unknown ' } }],
    ['empty', { blocked: { dependency: '' } }],
    ['blank', { blocked: { dependency: '   ' } }],
    ['non-object', { blocked: 'fake-dependency' }],
    ['array', { blocked: ['fake-dependency'] }],
    ['non-string dependency', { blocked: { dependency: 5 } }],
    ['201 chars', { blocked: { dependency: 'x'.repeat(201) } }],
  ])('%s yields no blocker', (_n, body) => {
    reply('fake-bad', body);
    expect(collect().evidence.blocker).toBeUndefined();
    expect(classify().state).toBe('RECEIVED');
  });

  it('accepts a 200-char dependency', () => {
    reply('fake-max', { blocked: { dependency: 'x'.repeat(200) } });
    expect(classify().state).toBe('BLOCKED');
  });

  it('a blocked reply naming a different id does not affect this id', () => {
    expect(appendBusInbox({ id: 'RQ-PHX-FAKE-OTHER', from: 'fake-requester', to: 'fake-lane', priority: 'P1',
      ttl: 10_000_000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    reply('fake-other', { blocked: { dependency: 'fake-dependency-review' } }, 'RQ-PHX-FAKE-OTHER');
    expect(collect().evidence.blocker).toBeUndefined();
    expect(classify().state).toBe('RECEIVED');
  });
});
