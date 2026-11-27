import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAddress, groupAddressTopicOf, groupPresence, publishGroupMessage, publishGroupPresence, subscribeGroup, GROUP_PRESENCE_TTL_MS } from '../src/core/fleet/bus-group.js';
import type { BusJsonValue, BusPriority } from '../src/core/fleet/bus-envelope.js';

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
  it('folds presence by cursor, isolates topics, and expires observations', () => {
    const root = setup();
    const presence = (id: string, member: string, state: 'online' | 'offline', at: number, topic = 'work') => publishGroupPresence({ id, room: 'team', topic, member, state }, { root, now: () => at });
    expect(presence('1', 'devin', 'online', 100).status).toBe('posted');
    expect(presence('2', 'codex', 'online', 101).status).toBe('posted');
    expect(presence('3', 'devin', 'offline', 102).status).toBe('posted');
    expect(presence('4', 'claude', 'online', 103, 'other').status).toBe('posted');
    expect(groupPresence('team', 'work', { root, now: () => 104 })).toEqual({ status: 'ok', members: [{ member: 'codex', state: 'online', receivedAt: 101 }] });
    expect(groupPresence('team', 'work', { root, now: () => 104 + GROUP_PRESENCE_TTL_MS })).toEqual({ status: 'ok', members: [] });
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

it('filters group reads with the shared bus-read filters', async () => {
  const { cmdCommsBus } = await import('../src/cli/comms-bus.js');
  const { appendBusInbox } = await import('../src/core/fleet/bus-inbox.js');
  const root = setup();
  const output: string[] = [];
  const deps = { emit: (value: string) => { output.push(value); } };
  const send = (id: string, from: string, body: BusJsonValue, at: number, priority?: BusPriority, topic = 'work') =>
    publishGroupMessage({ room: 'team', topic, id, from, ttl: 100000, body, priority }, { root, now: () => at });
  expect(send('m1', 'codex', { text: 'alpha deploy' }, 100, 'P1').status).toBe('posted');
  expect(send('m2', 'claude', { text: 'beta review' }, 200).status).toBe('posted');
  expect(send('m3', 'codex', { text: 'gamma deploy' }, 300, 'P0').status).toBe('posted');
  // A different room topic never enters this subscription.
  expect(send('m4', 'codex', { text: 'delta deploy' }, 350, undefined, 'other').status).toBe('posted');
  // Retained rows any local writer can leave on the group label: a protocol
  // body (topic-less — a protocol topic must equal the envelope's to, which a
  // group address never is) and a v2 note carrying the thread/job/inReplyTo
  // conventions a channel post uses.
  expect(appendBusInbox({ id: 'p1', from: 'codex', to: 'group:team:work', priority: 'P3', ttl: 100000,
    body: { protocol: { version: 1, kind: 'status' } } }, { root, now: () => 400 }).status).toBe('posted');
  expect(appendBusInbox({ id: 'n1', from: 'claude', to: 'group:team:work', priority: 'P3', ttl: 100000,
    body: { kind: 'note', thread: 'job:J1', inReplyTo: 'm2', text: 'note on J1' } }, { root, now: () => 500 }).status).toBe('posted');

  const read = async (filterArgs: string[] = []) => {
    output.length = 0;
    const code = await cmdCommsBus(['group', 'read', 'team', 'work', '0', ...filterArgs], { root, now: () => 1000 }, deps);
    const page = output.length === 0 ? undefined : JSON.parse(output[0]!) as { status: string; messages?: { cursor: number; envelope: { id: string } }[]; nextCursor?: number };
    return { code, ids: page?.messages?.map(row => row.envelope.id) ?? [], nextCursor: page?.nextCursor };
  };

  const all = await read();
  expect(all.code).toBe(0);
  expect(all.ids).toEqual(['m1', 'm2', 'm3', 'p1', 'n1']);
  expect(all.nextCursor).toBeGreaterThan(0);
  expect((await read(['--from', 'codex'])).ids).toEqual(['m1', 'm3', 'p1']);
  expect((await read(['--from=claude'])).ids).toEqual(['m2', 'n1']);
  expect((await read(['--exclude-from', 'codex'])).ids).toEqual(['m2', 'n1']);
  expect((await read(['--id', 'm2'])).ids).toEqual(['m2']);
  expect((await read(['--priority', 'P0'])).ids).toEqual(['m3']);
  expect((await read(['--priority', 'P3'])).ids).toEqual(['p1', 'n1']);
  expect((await read(['--contains', 'alpha'])).ids).toEqual(['m1']);
  expect((await read(['--since', '150'])).ids).toEqual(['m2', 'm3', 'p1', 'n1']);
  expect((await read(['--before', '250'])).ids).toEqual(['m1', 'm2']);
  expect((await read(['--since', '150', '--before', '250'])).ids).toEqual(['m2']);
  expect((await read(['--kind', 'status'])).ids).toEqual(['p1']);
  // A protocol topic must equal the envelope's to, which a group address never
  // is, so the protocol --topic dimension honestly matches nothing here.
  expect((await read(['--topic', 'fleet.*'])).ids).toEqual([]);
  expect((await read(['--thread', 'job:J1'])).ids).toEqual(['n1']);
  expect((await read(['--job', 'J1'])).ids).toEqual(['n1']);
  expect((await read(['--in-reply-to', 'm2'])).ids).toEqual(['n1']);

  // The address dimensions the positional room/topic already pin, unknown
  // flags and malformed values are usage errors, never silent matches.
  for (const bad of [
    ['--to', 'agent:codex'], ['--channel', 'eng'], ['--group-topic', 'work'],
    ['--priority', 'P9'], ['--kind', 'bogus'], ['--topic', 'Bad Topic'],
    ['--from'], ['--unknown', 'x'], ['--id', 'm1', '--id', 'm2'], ['--since', 'soon'],
  ]) {
    expect((await read(bad)).code).toBe(2);
  }
});
