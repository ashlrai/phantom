import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { projectFleetEdges, readFleetEdges } from '../src/core/fleet/fleet-edges.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { cmdFleetEdges } from '../src/cli/fleet-edges.js';

describe('fleet edges', () => {
  it('counts only messages in the trailing hour', () => {
    const envelope = { id: 'one', from: 'a', to: 'b', priority: 'P2' as const, ttl: 9_000_000, body: {} };
    const rows = [0, 1, 3_600_000, 3_600_001].map((receivedAt, cursor) => ({ cursor, receivedAt, envelope }));
    expect(projectFleetEdges(rows, 3_600_000)[0]).toMatchObject({ messages: 4, messagesLastHour: 2 });
  });
  it('never counts a presence heartbeat as agent-to-agent traffic', () => {
    const presence = { id: 'beat', from: 'a', to: 'group:release:general', priority: 'P3' as const, ttl: 300_000,
      body: { kind: 'group.presence', state: 'online' } };
    const note = { id: 'note', from: 'a', to: 'b', priority: 'P2' as const, ttl: 9_000_000, body: { text: 'hi' } };
    const rows = [presence, note].map((envelope, cursor) => ({ cursor, receivedAt: 1000 + cursor, envelope }));
    expect(projectFleetEdges(rows, 2000)).toEqual([
      { from: { address: 'a', provider: null }, to: { address: 'b', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1001 },
    ]);
  });
  it('never counts a dead-letter notice as agent-to-agent traffic', () => {
    const letter = { id: 'dl-1', from: 'bus-router', to: 'bus.dead-letter', priority: 'P2' as const, ttl: 604_800_000,
      body: { protocol: { version: 1, kind: 'status' }, correlation_id: 'c-1',
        payload: { deadLetter: { id: 'lost', from: 'a', to: 'b', kind: 'note', reason: 'exhausted', deadLetteredAt: 1, attempts: [] },
          payloadDropped: false, envelope: null } } };
    const note = { id: 'note', from: 'a', to: 'b', priority: 'P2' as const, ttl: 9_000_000, body: { text: 'hi' } };
    const rows = [letter, note].map((envelope, cursor) => ({ cursor, receivedAt: 1000 + cursor, envelope }));
    expect(projectFleetEdges(rows, 2000)).toEqual([
      { from: { address: 'a', provider: null }, to: { address: 'b', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1001 },
    ]);
  });
  it('windows the projection to the trailing minutes the org map applies', () => {
    const envelope = { id: 'one', from: 'a', to: 'b', priority: 'P2' as const, ttl: 9_000_000, body: {} };
    const rows = [0, 1, 3_600_000, 3_600_001].map((receivedAt, cursor) => ({ cursor, receivedAt, envelope }));
    // windowMinutes 60 keeps only rows inside the last hour — the same bound messagesLastHour counts.
    expect(projectFleetEdges(rows, 3_700_000, 60)).toEqual([
      { from: { address: 'a', provider: null }, to: { address: 'b', provider: null }, messages: 2, messagesLastHour: 2, lastAt: 3_600_001 },
    ]);
    // A one-minute window drops every receipt older than the cutoff.
    expect(projectFleetEdges(rows, 3_700_000, 1)).toEqual([]);
    for (const bad of [0, -5, 1.5, 1441]) {
      expect(() => projectFleetEdges(rows, 3_700_000, bad)).toThrow('Minutes must be 1..1440');
    }
  });
  it('narrows the projection to receipts matching the address filter', () => {
    const note = { id: 'n', from: 'a', to: 'b', priority: 'P2' as const, ttl: 9_000_000, body: { text: 'hi' } };
    const reply = { id: 'r', from: 'b', to: 'a', priority: 'P2' as const, ttl: 9_000_000, body: { text: 'yo' } };
    const other = { id: 'o', from: 'c', to: 'd', priority: 'P2' as const, ttl: 9_000_000, body: { text: 'x' } };
    const rows = [note, reply, other].map((envelope, cursor) => ({ cursor, receivedAt: 1000 + cursor, envelope }));
    const fromA = projectFleetEdges(rows, 2000, undefined, { from: value => value === 'a' });
    expect(fromA).toEqual([
      { from: { address: 'a', provider: null }, to: { address: 'b', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1000 },
    ]);
    const toA = projectFleetEdges(rows, 2000, undefined, { to: value => value === 'a' });
    expect(toA).toEqual([
      { from: { address: 'b', provider: null }, to: { address: 'a', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1001 },
    ]);
    // Both filters compose: only the a->b note satisfies from=a and to=b.
    const pair = projectFleetEdges(rows, 2000, undefined, { from: value => value === 'a', to: value => value === 'b' });
    expect(pair).toEqual(fromA);
    // A filter that matches nothing is an honest empty list, not an error.
    expect(projectFleetEdges(rows, 2000, undefined, { from: () => false })).toEqual([]);
  });
  it('reads --from/--to through the same identity-label rule the bus reads apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-edges-filter-'));
    const options = { root, now: () => 1000 };
    const post = (id: string, from: string, to: string) => appendBusInbox(
      { id, from, to, priority: 'P2', ttl: 5000, body: { text: 'private body' },
        channel: 'bus', channel_ref: id, sender: { agent_id: from, vendor: 'openai', human: false, team: true }, external: false }, options);
    try {
      // No registry: the ref keeps exact-label matching only.
      expect(post('one', 'atlas', 'bob').status).toBe('posted');
      expect(post('two', 'agent:atlas', 'bob').status).toBe('posted');
      expect(post('three', 'carol', 'bob').status).toBe('posted');
      expect(readFleetEdges({ ...options, from: 'atlas' }).edges).toEqual([
        { from: { address: 'atlas', provider: 'openai' }, to: { address: 'bob', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1000 },
      ]);
      // Registering atlas binds agent:atlas and the alias to one identity, so
      // the same --from ref now matches every label that identity answers to.
      expect(registerAgentIdentity({ handle: 'atlas', aliases: ['legacy-atlas'] }, options).status).toBe('created');
      const widened = readFleetEdges({ ...options, from: 'legacy-atlas' });
      expect(widened.edges).toEqual([
        { from: { address: 'agent:atlas', provider: 'openai' }, to: { address: 'bob', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1000 },
        { from: { address: 'atlas', provider: 'openai' }, to: { address: 'bob', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1000 },
      ]);
      // --to narrows the recipient side under the same rule.
      expect(readFleetEdges({ ...options, to: 'bob' }).edges).toHaveLength(3);
      expect(readFleetEdges({ ...options, to: 'atlas' }).edges).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('exposes the projection through agents edges', async () => {
    const out: string[] = [];
    expect(await runAgentsCli(['edges', '--json'], line => out.push(line))).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'fleet.edges.v1' });
  });
  it('projects live receipts, preserves unknown providers, and omits bodies', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-edges-'));
    const options = { root, now: () => 1000 };
    try {
      expect(readFleetEdges(options)).toMatchObject({ source: 'missing', edges: null });
      const post = (id: string, from: string, to: string, vendor: string) => appendBusInbox({ id, from, to, priority: 'P2', ttl: 5000, body: { text: 'private body' }, channel: 'bus', channel_ref: id, sender: { agent_id: from, vendor, human: false, team: true }, external: false }, options);
      expect(post('one', 'a', 'b', 'openai').status).toBe('posted');
      expect(post('two', 'b', 'c', 'anthropic').status).toBe('posted');
      expect(post('three', 'a', 'b', 'openai').status).toBe('posted');
      const result = readFleetEdges(options);
      expect(result.edges).toEqual([
        { from: { address: 'a', provider: 'openai' }, to: { address: 'b', provider: 'anthropic' }, messages: 2, messagesLastHour: 2, lastAt: 1000 },
        { from: { address: 'b', provider: 'anthropic' }, to: { address: 'c', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1000 },
      ]);
      expect(JSON.stringify(result)).not.toContain('private body');
      expect(readFleetEdges({ root, now: () => 7000 }).edges).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  describe('phm fleet edges flags', () => {
    let root: string, log: ReturnType<typeof vi.spyOn>;
    const post = (id: string, from: string, to: string, at: number) => appendBusInbox(
      { id, from, to, priority: 'P2', ttl: 9_000_000, body: { text: 'private body' },
        channel: 'bus', channel_ref: id, sender: { agent_id: from, vendor: 'openai', human: false, team: true }, external: false },
      { root, now: () => at });
    const run = async (args: string[]) => {
      const index = log.mock.calls.length;
      const code = await cmdFleetEdges(args);
      return { code, out: log.mock.calls.slice(index).map(call => String(call[0])) };
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'fleet-edges-cli-'));
      log = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

    it('passes --window-minutes and --root through to the same projection', async () => {
      const now = Date.now();
      expect(post('stale', 'a', 'b', now - 7_200_000).status).toBe('posted');
      expect(post('fresh', 'c', 'd', now).status).toBe('posted');
      // A 60-minute window keeps only the fresh edge; 1440 keeps both.
      const hour = await run(['--window-minutes', '60', '--root', root, '--json']);
      expect(hour.code).toBe(0);
      expect(JSON.parse(hour.out[0]!)).toMatchObject({ schema: 'fleet.edges.v1', source: 'available',
        edges: [{ from: { address: 'c' }, to: { address: 'd' }, messages: 1 }] });
      const day = await run(['--root', root, '--window-minutes', '1440', '--json']);
      expect(JSON.parse(day.out[0]!).edges).toHaveLength(2);
      // Without the window the whole retained store answers, like before.
      const all = await run(['--root', root, '--json']);
      expect(JSON.parse(all.out[0]!).edges).toHaveLength(2);
      expect(JSON.stringify(all.out)).not.toContain('private body');
    });

    it('passes --from and --to through to the same projection', async () => {
      const now = Date.now();
      expect(post('ab', 'a', 'b', now).status).toBe('posted');
      expect(post('ba', 'b', 'a', now).status).toBe('posted');
      expect(post('cd', 'c', 'd', now).status).toBe('posted');
      const fromA = await run(['--root', root, '--from', 'a', '--json']);
      expect(fromA.code).toBe(0);
      // Provider evidence is inferred inside the filtered traffic only — the
      // same bound --window-minutes applies — so b's vendor stays unknown here.
      expect(JSON.parse(fromA.out[0]!).edges).toEqual([
        { from: { address: 'a', provider: 'openai' }, to: { address: 'b', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
      ]);
      const toA = await run(['--root', root, '--to', 'a', '--json']);
      expect(JSON.parse(toA.out[0]!).edges).toEqual([
        { from: { address: 'b', provider: 'openai' }, to: { address: 'a', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
      ]);
      // Both refs compose into one filtered read.
      const pair = await run(['--root', root, '--from', 'a', '--to', 'b', '--json']);
      expect(JSON.parse(pair.out[0]!).edges).toHaveLength(1);
      const none = await run(['--root', root, '--from', 'nobody', '--json']);
      expect(JSON.parse(none.out[0]!).edges).toEqual([]);
    });

    it('rejects malformed flags before touching the store', async () => {
      for (const bad of [['--help', '--json'], ['--window-minutes'], ['--window-minutes', '--json'],
        ['--window-minutes', '0'], ['--window-minutes', '1441'], ['--window-minutes', '1.5'],
        ['--window-minutes', 'abc'], ['--window-minutes', '60', '--window-minutes', '30'],
        ['--from'], ['--from', '--json'], ['--from', 'has space'], ['--from', ''],
        ['--from', 'a', '--from', 'b'], ['--to'], ['--to', '--json'], ['--to', 'a b'],
        ['--root'], ['--root', 'relative'], ['--root', root, '--root', root], ['--json', '--json'],
        ['--unknown'], ['edges']]) {
        expect((await run(bad)).code).toBe(2);
      }
      expect(await cmdFleetEdges(['--help'])).toBe(0);
    });
  });
});
