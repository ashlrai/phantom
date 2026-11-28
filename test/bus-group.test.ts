import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAddress, groupAddressTopicOf, groupPresence, publishGroupMessage, publishGroupPresence, subscribeGroup, GROUP_PRESENCE_TTL_MS } from '../src/core/fleet/bus-group.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'group-bus-')); roots.push(root); return root; }

describe('group bus', () => {
  it('persists opaque messages and isolates room and topic subscriptions across pages', () => {
    const root = setup();
    const send = (id: string, room: string, topic: string) => publishGroupMessage({ id, room, topic, from: 'codex', ttl: 10000, body: { text: 'hello', nested: [1, null] } }, { root, now: () => 100 });
    expect(send('a', 'team', 'other').status).toBe('posted');
    expect(send('b', 'team', 'work').status).toBe('posted');
    expect(send('b', 'team', 'work').status).toBe('duplicate');
    const first = subscribeGroup('team', 'work', 0, 1, { root, now: () => 101 });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('read failed');
    expect(first.messages).toEqual([]);
    const second = subscribeGroup('team', 'work', first.nextCursor, 1, { root, now: () => 101 });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw new Error('read failed');
    expect(second.messages[0]?.envelope.body).toEqual({ kind: 'group.message', value: { text: 'hello', nested: [1, null] } });
    expect(() => groupAddress('../team', 'work')).toThrow();
  });
  it('parses the topic component of a well-formed group address only', () => {
    expect(groupAddressTopicOf('group:team:work')).toBe('work');
    expect(groupAddressTopicOf('group:a-b_c:topic-1_x')).toBe('topic-1_x');
    // Anything that is not exactly group:<room>:<topic> under the room rule
    // carries no topic: bare rooms, deeper labels, empty or malformed
    // components, non-group labels and case variants all resolve to null.
    for (const label of ['group:team', 'group:team:work:extra', 'group::work', 'group:team:',
      'group:Team:work', 'group:team:Work', 'group:team work:x', 'team:work', 'leaders',
      'agent:codex', 'group', 'group:', '']) {
      expect(groupAddressTopicOf(label)).toBeNull();
    }
  });
  it('narrows a subscription through the caller match predicate without fabricating rows', () => {
    const root = setup();
    publishGroupMessage({ id: 'm1', room: 'team', topic: 'work', from: 'codex', ttl: 10000, body: { text: 'ship it' } }, { root, now: () => 100 });
    publishGroupPresence({ id: 'p1', room: 'team', topic: 'work', member: 'devin', state: 'online' }, { root, now: () => 101 });
    publishGroupMessage({ id: 'm2', room: 'team', topic: 'work', from: 'claude', ttl: 10000, body: { text: 'looks good' } }, { root, now: () => 102 });
    // The address check applies before the predicate: a predicate that accepts
    // everything still sees only this room+topic's rows, and nextCursor keeps
    // advancing over scanned-but-filtered records.
    const all = subscribeGroup('team', 'work', 0, 100, { root, now: () => 103 }, () => true);
    expect(all.status).toBe('ok');
    if (all.status !== 'ok') throw new Error('read failed');
    expect(all.messages).toHaveLength(3);
    const messagesOnly = subscribeGroup('team', 'work', 0, 100, { root, now: () => 103 },
      row => (row.envelope.body as { kind?: string }).kind === 'group.message');
    expect(messagesOnly.status).toBe('ok');
    if (messagesOnly.status !== 'ok') throw new Error('read failed');
    expect(messagesOnly.messages.map(row => row.envelope.id)).toEqual(['m1', 'm2']);
    const none = subscribeGroup('team', 'work', 0, 100, { root, now: () => 103 }, () => false);
    expect(none.status).toBe('ok');
    if (none.status !== 'ok') throw new Error('read failed');
    expect(none.messages).toEqual([]);
    expect(none.nextCursor).toBe(all.nextCursor);
  });
  it('folds presence by cursor, isolates topics, and expires observations', () => {
    const root = setup();
    const presence = (id: string, member: string, state: 'online' | 'offline', at: number, topic = 'work') => publishGroupPresence({ id, room: 'team', topic, member, state }, { root, now: () => at });
    expect(presence('1', 'devin', 'online', 100).status).toBe('posted');
    expect(presence('2', 'codex', 'online', 101).status).toBe('posted');
    expect(presence('3', 'devin', 'offline', 102).status).toBe('posted');
    expect(presence('4', 'claude', 'online', 103, 'other').status).toBe('posted');
    expect(groupPresence('team', 'work', { root, now: () => 104 })).toEqual({ status: 'ok', asOf: new Date(104).toISOString(), members: [{ member: 'codex', state: 'online', receivedAt: 101 }] });
    expect(groupPresence('team', 'work', { root, now: () => 104 + GROUP_PRESENCE_TTL_MS })).toEqual({ status: 'ok', asOf: new Date(104 + GROUP_PRESENCE_TTL_MS).toISOString(), members: [] });
  });
  it('freezes the read clock across the presence fold and stamps asOf', () => {
    const root = setup();
    // A clock that advances on every read would let an early page's TTL
    // verdict differ from a later page's; the fold must evaluate every page
    // against one frozen now and report it as asOf.
    let tick = 100;
    const now = () => (tick += GROUP_PRESENCE_TTL_MS + 1000);
    expect(publishGroupPresence({ id: 'p1', room: 'team', topic: 'work', member: 'devin', state: 'online' }, { root, now: () => 100 }).status).toBe('posted');
    const folded = groupPresence('team', 'work', { root, now });
    expect(folded.status).toBe('ok');
    if (folded.status !== 'ok') throw new Error('presence read failed');
    // The frozen read is one TTL past the observation, so the member list is
    // honestly empty — and asOf names that same frozen instant, proving the
    // fold stamped one clock rather than each page's own.
    expect(folded.members).toEqual([]);
    expect(folded.asOf).toBe(new Date(100 + GROUP_PRESENCE_TTL_MS + 1000).toISOString());
  });
});

it('exposes group publishing and cursor reads through the comms CLI', async () => {
  const { cmdCommsBus } = await import('../src/cli/comms-bus.js');
  const root = setup();
  const output: string[] = [];
  const deps = { emit: (value: string) => { output.push(value); } };
  expect(await cmdCommsBus(['group', 'publish', 'team', 'work', 'msg', 'claude', '1000', '{"text":"hi"}'], { root, now: () => 100 }, deps)).toBe(0);
  expect(await cmdCommsBus(['group', 'read', 'team', 'work', '0'], { root, now: () => 101 }, deps)).toBe(0);
  expect(JSON.parse(output[1]!).messages[0].envelope.body.value).toEqual({ text: 'hi' });
  expect(await cmdCommsBus(['group', 'publish', 'team', 'work', 'bad', 'claude', '1000', '{'], { root }, deps)).toBe(2);
});

it('applies the shared bus page filters to comms bus group read', async () => {
  const { cmdCommsBus } = await import('../src/cli/comms-bus.js');
  const root = setup();
  const output: string[] = [];
  const deps = { emit: (value: string) => { output.push(value); } };
  const at = { root, now: () => 100 };
  expect(await cmdCommsBus(['group', 'publish', 'team', 'work', 'm1', 'codex', '1000', '{"text":"ship it"}'], at, deps)).toBe(0);
  expect(await cmdCommsBus(['group', 'heartbeat', 'team', 'work', 'p1', 'devin', 'online'], at, deps)).toBe(0);
  expect(await cmdCommsBus(['group', 'publish', 'team', 'work', 'm2', 'claude', '1000', '{"text":"looks good"}'], at, deps)).toBe(0);
  // --body-kind keeps only group.message payloads, dropping the presence heartbeat.
  expect(await cmdCommsBus(['group', 'read', 'team', 'work', '0', '--body-kind', 'group.message'], { root, now: () => 101 }, deps)).toBe(0);
  const page = JSON.parse(output.at(-1)!);
  expect(page.status).toBe('ok');
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['m1', 'm2']);
  // --from narrows to one sender's posts; the heartbeat's member label is its sender.
  expect(await cmdCommsBus(['group', 'read', 'team', 'work', '0', '--from', 'codex'], { root, now: () => 101 }, deps)).toBe(0);
  expect(JSON.parse(output.at(-1)!).messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['m1']);
  // --contains matches the scrubbed one-line summary of the room payload.
  expect(await cmdCommsBus(['group', 'read', 'team', 'work', '0', '--contains', 'looks'], { root, now: () => 101 }, deps)).toBe(0);
  expect(JSON.parse(output.at(-1)!).messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['m2']);
  // An invalid filter is an argument error, never a widened page.
  expect(await cmdCommsBus(['group', 'read', 'team', 'work', '0', '--priority', 'P9'], { root, now: () => 101 }, deps)).toBe(2);
  expect(await cmdCommsBus(['group', 'read', 'team', 'work', '0', '--to', 'x'], { root, now: () => 101 }, deps)).toBe(2);
});

it('runs the documented group commands through the CLI', async () => {
  const { cmdCommsBus } = await import('../src/cli/comms-bus.js');
  const doc = readFileSync(join(__dirname, '../docs/GROUP-CHAT.md'), 'utf8');
  const commands = [...doc.matchAll(/^phm comms bus group (.+)$/gm)].map((match) => match[1]!);
  expect(commands).toHaveLength(4);
  const root = setup();
  const output: string[] = [];
  for (const command of commands) {
    const args = [...command.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2]!);
    expect(await cmdCommsBus(['group', ...args], { root, now: () => 100 }, { emit: (value) => { output.push(value); } })).toBe(0);
  }
  expect(JSON.parse(output[1]!).messages[0].envelope.body.value).toEqual({ text: 'Ready for review' });
  expect(JSON.parse(output[3]!).members[0].member).toBe('codex');
});
