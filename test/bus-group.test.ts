import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAddress, groupPresence, publishGroupMessage, publishGroupPresence, subscribeGroup, GROUP_PRESENCE_TTL_MS } from '../src/core/fleet/bus-group.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readGroupTopic } from '../src/core/fleet/bus-group-read.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';

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

describe('group read filters', () => {
  /** Seed one room page: a wrapped message, a heartbeat and four raw v2 bodies. */
  function seed(root: string) {
    const to = groupAddress('team', 'work');
    const post = (id: string, from: string, body: unknown, at: number, priority: 'P0' | 'P1' | 'P2' | 'P3' = 'P2') =>
      appendBusInbox({ id, from, to, priority, ttl: 60000, body }, { root, now: () => at });
    expect(publishGroupMessage({ id: 'm1', room: 'team', topic: 'work', from: 'claude', ttl: 60000, body: { text: 'deploy finished' } }, { root, now: () => 1000 }).status).toBe('posted');
    expect(publishGroupPresence({ id: 'p1', room: 'team', topic: 'work', member: 'codex', state: 'online' }, { root, now: () => 1000 }).status).toBe('posted');
    expect(post('n1', 'devin', { kind: 'note', thread: 'job:J-1', text: 'note about the deploy job' }, 2000).status).toBe('posted');
    expect(post('n2', 'devin', { kind: 'note', thread: 'other', text: 'unrelated chatter' }, 3000).status).toBe('posted');
    expect(post('r1', 'codex', { kind: 'work.result', jobId: 'J-1', outcome: 'complete' }, 4000, 'P1').status).toBe('posted');
    expect(post('q1', 'claude', { kind: 'note', text: 'ping', inReplyTo: 'm1' }, 5000).status).toBe('posted');
    // Traffic for a sibling topic never enters this page.
    expect(publishGroupMessage({ id: 'x1', room: 'team', topic: 'other', from: 'claude', ttl: 60000, body: { text: 'elsewhere' } }, { root, now: () => 1000 }).status).toBe('posted');
  }
  const ids = (page: { status: string; messages?: { envelope: { id: string } }[] }) =>
    page.status === 'ok' ? page.messages!.map(row => row.envelope.id) : [];
  const read = (root: string, input: Parameters<typeof readGroupTopic>[4], now = 6000) =>
    readGroupTopic('team', 'work', 0, 100, input, { root, now: () => now });

  it('passes the raw page through untouched when no filter is supplied', () => {
    const root = setup();
    seed(root);
    const page = read(root, {});
    expect(page.status).toBe('ok');
    expect(ids(page)).toEqual(['m1', 'p1', 'n1', 'n2', 'r1', 'q1']);
  });

  it('narrows by body kind so presence heartbeats and messages separate', () => {
    const root = setup();
    seed(root);
    expect(ids(read(root, { bodyKind: 'group.message' }))).toEqual(['m1']);
    expect(ids(read(root, { bodyKind: 'group.presence' }))).toEqual(['p1']);
    expect(ids(read(root, { bodyKind: 'note' }))).toEqual(['n1', 'n2', 'q1']);
    expect(ids(read(root, { bodyKind: 'work.result' }))).toEqual(['r1']);
    expect(ids(read(root, { bodyKind: 'note', result: 'complete' }))).toEqual([]);
  });

  it('applies the shared citation, sender, band, window and text rules', () => {
    const root = setup();
    seed(root);
    expect(ids(read(root, { id: 'm1' }))).toEqual(['m1']);
    expect(ids(read(root, { id: 'M1' }))).toEqual([]);
    expect(ids(read(root, { inReplyTo: 'm1' }))).toEqual(['q1']);
    expect(ids(read(root, { from: 'claude' }))).toEqual(['m1', 'q1']);
    expect(ids(read(root, { excludeFrom: 'claude' }))).toEqual(['p1', 'n1', 'n2', 'r1']);
    expect(ids(read(root, { from: 'devin', excludeFrom: 'devin' }))).toEqual([]);
    expect(ids(read(root, { from: 'nobody' }))).toEqual([]);
    expect(ids(read(root, { priority: 'P1' }))).toEqual(['r1']);
    expect(ids(read(root, { priority: 'P0' }))).toEqual([]);
    expect(ids(read(root, { thread: 'job:J-1' }))).toEqual(['n1']);
    expect(ids(read(root, { thread: 'other' }))).toEqual(['n2']);
    expect(ids(read(root, { job: 'J-1' }))).toEqual(['n1', 'r1']);
    expect(ids(read(root, { result: 'complete' }))).toEqual(['r1']);
    expect(ids(read(root, { result: 'failed' }))).toEqual([]);
    expect(ids(read(root, { contains: 'deploy finished' }))).toEqual(['m1']);
    expect(ids(read(root, { contains: 'UNRELATED' }))).toEqual(['n2']);
    expect(ids(read(root, { contains: 'no such text' }))).toEqual([]);
  });

  it('composes the [since, before) window on receivedAt with the relative grammar', () => {
    const root = setup();
    seed(root);
    expect(ids(read(root, { since: '2000' }))).toEqual(['n1', 'n2', 'r1', 'q1']);
    expect(ids(read(root, { before: '3000' }))).toEqual(['m1', 'p1', 'n1']);
    expect(ids(read(root, { since: '2000', before: '4000' }))).toEqual(['n1', 'n2']);
    expect(ids(read(root, { since: '1s' }))).toEqual(['q1']);
    expect(ids(read(root, { since: '2000', before: '2000' }))).toEqual([]);
  });

  it('resolves sender refs through the identity registry and keeps exact matching when unknown', () => {
    const root = setup();
    seed(root);
    expect(registerAgentIdentity({ handle: 'devin', aliases: ['dvn'] }, { root }).status).toBe('created');
    // The alias resolves to devin's identity, so it matches every label of it.
    expect(ids(read(root, { from: 'dvn' }))).toEqual(['n1', 'n2']);
    expect(ids(read(root, { excludeFrom: 'dvn' }))).toEqual(['m1', 'p1', 'r1', 'q1']);
    // An unresolvable ref keeps exact-label matching: no row was sent by 'ghost'.
    expect(ids(read(root, { from: 'ghost' }))).toEqual([]);
  });

  it('reports invalid for bad filter values and keeps the cursor advancing past filtered pages', () => {
    const root = setup();
    seed(root);
    for (const input of [
      { priority: 'P9' }, { result: 'done' }, { since: 'soon' }, { before: '-1' },
      { id: '' }, { thread: 'has space' }, { contains: '   ' }, { job: 'x'.repeat(129) },
    ]) {
      expect(read(root, input).status).toBe('invalid');
    }
    // A filtered page still advances nextCursor over every scanned row.
    const page = read(root, { bodyKind: 'group.presence' });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('read failed');
    expect(page.messages.map(row => row.envelope.id)).toEqual(['p1']);
    expect(page.nextCursor).toBeGreaterThan(0);
    const rest = readGroupTopic('team', 'work', page.nextCursor, 100, {}, { root, now: () => 6000 });
    expect(rest.status).toBe('ok');
  });
});

it('filters group reads through the comms CLI and refuses bad flags', async () => {
  const { cmdCommsBus } = await import('../src/cli/comms-bus.js');
  const root = setup();
  const to = groupAddress('eng', 'build');
  expect(appendBusInbox({ id: 'a1', from: 'codex', to, priority: 'P2', ttl: 60000, body: { kind: 'note', text: 'first' } }, { root, now: () => 100 }).status).toBe('posted');
  expect(publishGroupPresence({ id: 'a2', room: 'eng', topic: 'build', member: 'codex', state: 'online' }, { root, now: () => 100 }).status).toBe('posted');
  const output: string[] = [];
  const deps = { emit: (value: string) => { output.push(value); } };
  const opts = { root, now: () => 200 };
  // Unfiltered: both rows. --body-kind group.message keeps only real posts.
  expect(await cmdCommsBus(['group', 'read', 'eng', 'build', '0'], opts, deps)).toBe(0);
  expect(await cmdCommsBus(['group', 'read', 'eng', 'build', '0', '--body-kind', 'group.message'], opts, deps)).toBe(0);
  const unfiltered = JSON.parse(output[0]!).messages.map((row: { envelope: { id: string } }) => row.envelope.id);
  const filtered = JSON.parse(output[1]!).messages.map((row: { envelope: { id: string } }) => row.envelope.id);
  expect(unfiltered).toEqual(['a1', 'a2']);
  expect(filtered).toEqual([]);
  // --body-kind note matches the v2 body kind, and --contains narrows text.
  expect(await cmdCommsBus(['group', 'read', 'eng', 'build', '0', '--body-kind=note', '--contains=first'], opts, deps)).toBe(0);
  expect(JSON.parse(output[2]!).messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['a1']);
  // Unknown flags, stray positionals, missing values and bad values all exit 2.
  for (const args of [
    ['group', 'read', 'eng', 'build', '0', '--bogus', 'x'],
    ['group', 'read', 'eng', 'build', '0', 'stray'],
    ['group', 'read', 'eng', 'build', '0', '--since'],
    ['group', 'read', 'eng', 'build', '0', '--id', 'a1', '--id', 'a2'],
    ['group', 'read', 'eng', 'build', '0', '--priority', 'P9'],
    ['group', 'read', 'eng', 'build', '0', '--result', 'done'],
  ]) {
    expect(await cmdCommsBus(args, opts, deps)).toBe(2);
  }
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
