import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAddress, groupPresence, publishGroupMessage, publishGroupPresence, subscribeGroup, GROUP_PRESENCE_TTL_MS } from '../src/core/fleet/bus-group.js';

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
