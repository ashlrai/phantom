import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { projectFleetEdges, parseFleetEdgesQuery, readFleetEdges } from '../src/core/fleet/fleet-edges.js';
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
  it('narrows the projection to one group room or one room topic', () => {
    const post = (id: string, from: string, to: string) =>
      ({ id, from, to, priority: 'P2' as const, ttl: 9_000_000, body: { text: 'hi' } });
    const opsGeneral = post('og', 'a', 'group:ops:general');
    const opsAlerts = post('oa', 'b', 'group:ops:alerts');
    const engGeneral = post('eg', 'c', 'group:eng:general');
    const dm = post('dm', 'd', 'e');
    const rows = [opsGeneral, opsAlerts, engGeneral, dm].map((envelope, cursor) => ({ cursor, receivedAt: 1000 + cursor, envelope }));
    const edge = (from: string, to: string, messages = 1) =>
      ({ from: { address: from, provider: null }, to: { address: to, provider: null }, messages, messagesLastHour: messages, lastAt: 1000 + rows.findIndex(row => row.envelope.id !== undefined && row.envelope.from === from && row.envelope.to === to) });
    // --channel keeps the room's traffic under every topic, agent mail excluded.
    // Edges sort newest-first, so the alerts link (lastAt 1001) leads.
    expect(projectFleetEdges(rows, 2000, undefined, undefined, { channel: 'ops' })).toEqual([
      edge('b', 'group:ops:alerts'), edge('a', 'group:ops:general'),
    ]);
    // --topic keeps one topic across every room.
    expect(projectFleetEdges(rows, 2000, undefined, undefined, { topic: 'general' })).toEqual([
      edge('c', 'group:eng:general'), edge('a', 'group:ops:general'),
    ]);
    // The two compose into one room AND one topic.
    expect(projectFleetEdges(rows, 2000, undefined, undefined, { channel: 'ops', topic: 'alerts' })).toEqual([
      edge('b', 'group:ops:alerts'),
    ]);
    // A bare group:<room> label and an agent address never match; the room
    // prefix rule keeps deeper labels under group:<room>:* like every other
    // bus read's --channel, while --topic still requires the well-formed parse.
    const odd = [post('bare', 'a', 'group:ops'), post('deep', 'a', 'group:ops:general:extra'),
      post('agent', 'a', 'agent:b')].map((envelope, cursor) => ({ cursor, receivedAt: 5000 + cursor, envelope }));
    expect(projectFleetEdges(odd, 6000, undefined, undefined, { topic: 'general' })).toEqual([]);
    expect(projectFleetEdges(odd, 6000, undefined, undefined, { channel: 'ops' })).toEqual([
      { from: { address: 'a', provider: null }, to: { address: 'group:ops:general:extra', provider: null },
        messages: 1, messagesLastHour: 1, lastAt: 5001 },
    ]);
    // A room filter that matches nothing is an honest empty list, not an error.
    expect(projectFleetEdges(rows, 2000, undefined, undefined, { channel: 'missing' })).toEqual([]);
    // A presence heartbeat inside the room still drops out under agentToAgent.
    const beat = { id: 'beat', from: 'a', to: 'group:ops:general', priority: 'P3' as const, ttl: 300_000,
      body: { kind: 'group.presence', state: 'online' } };
    const withBeat = [...rows, { cursor: 9, receivedAt: 5000, envelope: beat }];
    expect(projectFleetEdges(withBeat, 6000, undefined, undefined, { channel: 'ops' })).toEqual([
      edge('b', 'group:ops:alerts'), edge('a', 'group:ops:general'),
    ]);
  });
  it('narrows the receipt set by the shared slice filters before aggregating', () => {
    const receipt = (cursor: number, receivedAt: number, envelope: BusInboxReceipt['envelope']): BusInboxReceipt =>
      ({ cursor, receivedAt, envelope });
    const rows = [
      // a->b: P1 ask naming job RQ-9, received now.
      receipt(0, 9_000_000, { id: 'm1', from: 'a', to: 'b', priority: 'P1', ttl: 9_000_000, channel: 'bus',
        body: { kind: 'note', thread: 'job:RQ-9', text: 'please deploy the fix?' } }),
      // a->b: P2 status about something else, received now.
      receipt(1, 9_500_000, { id: 'm2', from: 'a', to: 'b', priority: 'P2', ttl: 9_000_000, channel: 'bus',
        body: { kind: 'note', text: 'ship has sailed' } }),
      // c->d: P0 handoff, received hours ago — outside the last-hour count.
      receipt(2, 100, { id: 'm3', from: 'c', to: 'd', priority: 'P0', ttl: 9_000_000, channel: 'handoff',
        body: { kind: 'note', text: 'taking over the lane' } }),
    ];
    const now = 10_000_000;
    const edge = (from: string, to: string, messages: number, messagesLastHour: number, lastAt: number) =>
      ({ from: { address: from, provider: null }, to: { address: to, provider: null },
        messages, messagesLastHour, lastAt });
    // kind keeps only the receipts classify files under it — the same vocabulary phm messages --kind reports.
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { kind: 'ask' })).toEqual([edge('a', 'b', 1, 1, 9_000_000)]);
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { kind: 'handoff' })).toEqual([edge('c', 'd', 1, 0, 100)]);
    // priority keeps only the exact band; job keeps only bodies citing the job; contains keeps only summary matches.
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { priority: 'P0' })).toEqual([edge('c', 'd', 1, 0, 100)]);
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { job: 'RQ-9' })).toEqual([edge('a', 'b', 1, 1, 9_000_000)]);
    // contains matches case-insensitively over the scrubbed summary — the projection
    // normalizes the needle itself, so a direct caller needs no pre-lowercasing.
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { contains: 'DEPLOY' })).toEqual([edge('a', 'b', 1, 1, 9_000_000)]);
    // since/before compose into the [since, before) receipt-time window the other bus reads apply —
    // m1 and m2 share the a->b link, so the filtered set aggregates into one edge of two messages.
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { since: 1_000 }))
      .toEqual([edge('a', 'b', 2, 2, 9_500_000)]);
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { since: 1_000, before: 9_200_000 }))
      .toEqual([edge('a', 'b', 1, 1, 9_000_000)]);
    expect(projectFleetEdges(rows, now, undefined, undefined, undefined, { before: 9_200_000 }))
      .toEqual([edge('a', 'b', 1, 1, 9_000_000), edge('c', 'd', 1, 0, 100)]);
    // The slice composes with the address, room and window bounds, never replacing them.
    expect(projectFleetEdges(rows, now, undefined, { from: value => value === 'c' }, undefined, { kind: 'status' }))
      .toEqual([]);
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
  it('filters agents edges through the same flags phm fleet edges takes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-edges-agents-'));
    const now = Date.now();
    const post = (id: string, from: string, to: string, at: number) => appendBusInbox(
      { id, from, to, priority: 'P2', ttl: 9_000_000, body: { text: 'private body' },
        channel: 'bus', channel_ref: id, sender: { agent_id: from, vendor: 'openai', human: false, team: true }, external: false },
      { root, now: () => at });
    const run = async (args: string[]) => {
      const out: string[] = [];
      const code = await runAgentsCli(['edges', '--root', root, '--json', ...args],
        line => out.push(line), () => {});
      return { code, json: out[0] === undefined ? null : JSON.parse(out[0]) };
    };
    try {
      expect(post('fresh', 'a', 'b', now).status).toBe('posted');
      expect(post('stale', 'c', 'd', now - 7_200_000).status).toBe('posted');
      // --root now reaches the same store phm fleet edges --root reads.
      expect((await run([])).json.edges).toHaveLength(2);
      // --from narrows to one sender's links; the = form parses identically.
      const fromA = await run(['--from', 'a']);
      expect(fromA.code).toBe(0);
      expect(fromA.json.edges).toEqual([
        { from: { address: 'a', provider: 'openai' }, to: { address: 'b', provider: null },
          messages: 1, messagesLastHour: 1, lastAt: now },
      ]);
      expect((await run(['--from=a'])).json.edges).toEqual(fromA.json.edges);
      // --window-minutes drops the stale edge; an unknown flag or a malformed
      // value is a usage error, never a silently empty read.
      expect((await run(['--window-minutes', '60'])).json.edges).toHaveLength(1);
      expect((await run(['--bogus'])).code).toBe(2);
      expect((await run(['--window-minutes', '0'])).code).toBe(2);
      expect((await run(['--from'])).code).toBe(2);
      expect(JSON.stringify(fromA.json)).not.toContain('private body');
    } finally { rmSync(root, { recursive: true, force: true }); }
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
  describe('parseFleetEdgesQuery', () => {
    it('passes the unfiltered read through as empty options', () => {
      expect(parseFleetEdgesQuery({})).toEqual({ ok: true, options: {} });
    });
    it('parses every filter with the same rules the flags and MCP arguments apply', () => {
      expect(parseFleetEdgesQuery({ windowMinutes: '60', from: 'atlas', to: 'agent:bob',
        channel: 'ops', topic: 'general' })).toEqual({ ok: true, options: {
        windowMinutes: 60, from: 'atlas', to: 'agent:bob', channel: 'ops', topic: 'general' } });
      expect(parseFleetEdgesQuery({ windowMinutes: '1' })).toEqual({ ok: true, options: { windowMinutes: 1 } });
      expect(parseFleetEdgesQuery({ windowMinutes: '1440' })).toEqual({ ok: true, options: { windowMinutes: 1440 } });
    });
    it('parses the shared row-slice filters with the same rules the bus reads apply', () => {
      const now = 10_000_000;
      expect(parseFleetEdgesQuery({ since: '2h', before: '15m', priority: 'P1',
        kind: 'HANDOFF', job: 'RQ-1', contains: 'Deploy  Fix' }, now)).toEqual({ ok: true, options: {
        since: now - 7_200_000, before: now - 900_000, priority: 'P1',
        kind: 'handoff', job: 'RQ-1', contains: 'deploy fix' } });
      expect(parseFleetEdgesQuery({ since: '1700000000000', before: '2026-06-01T00:00:00.000Z' }, now))
        .toEqual({ ok: true, options: { since: 1_700_000_000_000, before: Date.parse('2026-06-01T00:00:00.000Z') } });
    });
    it('rejects malformed values before the store is touched', () => {
      for (const input of [
        { windowMinutes: '' }, { windowMinutes: '0' }, { windowMinutes: '1441' },
        { windowMinutes: '1.5' }, { windowMinutes: 'abc' }, { windowMinutes: '-5' },
        { windowMinutes: 'x'.repeat(40) }, { windowMinutes: '9'.repeat(40) },
        { from: '' }, { from: 'has space' }, { from: 'x'.repeat(129) },
        { to: 'bad label' }, { to: 'x'.repeat(129) },
        { channel: '' }, { channel: 'Bad Room' }, { channel: 'UPPER' }, { channel: 'x'.repeat(33) },
        { topic: 'has space' }, { topic: 'UPPER' }, { topic: 'x'.repeat(33) },
        { since: '' }, { since: 'bogus' }, { since: '-5' }, { since: '0x10' }, { since: '9'.repeat(40) },
        { before: 'soon' }, { before: '1.5h' },
        { priority: '' }, { priority: 'P4' }, { priority: 'p1' }, { priority: 'high' },
        { kind: '' }, { kind: 'unknown' }, { kind: 'asks' },
        { job: '' }, { job: 'has space' }, { job: 'x'.repeat(129) },
        { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) },
      ]) {
        expect(parseFleetEdgesQuery(input).ok, JSON.stringify(input)).toBe(false);
      }
    });
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
      return { code, out: log.mock.calls.slice(index).map((call: unknown[]) => String(call[0])) };
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

    it('passes --channel and --topic through to the same projection', async () => {
      const now = Date.now();
      const room = (id: string, from: string, to: string) => appendBusInbox(
        { id, from, to, priority: 'P2', ttl: 9_000_000, body: { text: 'private body' } },
        { root, now: () => now });
      expect(room('og', 'a', 'group:ops:general').status).toBe('posted');
      expect(room('oa', 'b', 'group:ops:alerts').status).toBe('posted');
      expect(room('eg', 'c', 'group:eng:general').status).toBe('posted');
      expect(room('dm', 'd', 'e').status).toBe('posted');
      const ops = await run(['--root', root, '--channel', 'ops', '--json']);
      expect(ops.code).toBe(0);
      // The room's traffic under every topic; agent mail never reaches the page.
      // Tied lastAt sorts by sender address, so a's link leads.
      expect(JSON.parse(ops.out[0]!).edges).toEqual([
        { from: { address: 'a', provider: null }, to: { address: 'group:ops:general', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
        { from: { address: 'b', provider: null }, to: { address: 'group:ops:alerts', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
      ]);
      const general = await run(['--root', root, '--topic', 'general', '--json']);
      expect(JSON.parse(general.out[0]!).edges).toEqual([
        { from: { address: 'a', provider: null }, to: { address: 'group:ops:general', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
        { from: { address: 'c', provider: null }, to: { address: 'group:eng:general', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
      ]);
      // The two compose into one room AND one topic.
      const both = await run(['--root', root, '--channel', 'ops', '--topic', 'alerts', '--json']);
      expect(JSON.parse(both.out[0]!).edges).toEqual([
        { from: { address: 'b', provider: null }, to: { address: 'group:ops:alerts', provider: null }, messages: 1, messagesLastHour: 1, lastAt: now },
      ]);
      // A room nothing carries is an honest empty list.
      const none = await run(['--root', root, '--channel', 'missing', '--json']);
      expect(JSON.parse(none.out[0]!).edges).toEqual([]);
      expect(JSON.stringify(ops.out)).not.toContain('private body');
    });

    it('passes the shared slice flags through to the same projection', async () => {
      const now = Date.now();
      const post = (id: string, from: string, to: string, priority: string, body: unknown, at = now) => appendBusInbox(
        { id, from, to, priority, ttl: 9_000_000, body,
          channel: 'bus', channel_ref: id, sender: { agent_id: from, vendor: 'openai', human: false, team: true }, external: false },
        { root, now: () => at });
      expect(post('m1', 'a', 'b', 'P1', { kind: 'note', thread: 'job:RQ-9', text: 'please deploy the fix?' }).status).toBe('posted');
      expect(post('m2', 'a', 'b', 'P2', { kind: 'note', text: 'ship has sailed' }).status).toBe('posted');
      expect(post('m3', 'c', 'd', 'P0', { kind: 'note', text: 'taking over the lane' }, now - 7_200_000).status).toBe('posted');
      // b and d never send, so their provider stays unknown — the same inference bound every filter keeps.
      const edge = (from: string, to: string, messages: number, lastAt: number) =>
        ({ from: { address: from, provider: 'openai' }, to: { address: to, provider: null },
          messages, messagesLastHour: lastAt > now - 3_600_000 ? messages : 0, lastAt });
      // --kind keeps only the receipts classify files under it.
      const ask = await run(['--root', root, '--kind', 'ask', '--json']);
      expect(ask.code).toBe(0);
      expect(JSON.parse(ask.out[0]!).edges).toEqual([edge('a', 'b', 1, now)]);
      // --priority keeps only the exact band.
      const p0 = await run(['--root', root, '--priority', 'P0', '--json']);
      expect(JSON.parse(p0.out[0]!).edges).toEqual([edge('c', 'd', 1, now - 7_200_000)]);
      // --job keeps only bodies citing the job; --contains keeps only summary matches.
      const job = await run(['--root', root, '--job', 'RQ-9', '--json']);
      expect(JSON.parse(job.out[0]!).edges).toEqual([edge('a', 'b', 1, now)]);
      const needle = await run(['--root', root, '--contains', 'DEPLOY', '--json']);
      expect(JSON.parse(needle.out[0]!).edges).toEqual([edge('a', 'b', 1, now)]);
      // --since/--before compose into the [since, before) receipt-time window.
      const since = await run(['--root', root, '--since', '1h', '--json']);
      expect(JSON.parse(since.out[0]!).edges).toEqual([edge('a', 'b', 2, now)]);
      const before = await run(['--root', root, '--before', '1h', '--json']);
      expect(JSON.parse(before.out[0]!).edges).toEqual([edge('c', 'd', 1, now - 7_200_000)]);
      // The filters compose conjunctively.
      const both = await run(['--root', root, '--kind', 'ask', '--priority', 'P2', '--json']);
      expect(JSON.parse(both.out[0]!).edges).toEqual([]);
      // `--flag=value` keeps a needle that itself starts with `--` expressible.
      const dashed = await run(['--root', root, '--contains=--deploy', '--json']);
      expect(dashed.code).toBe(0);
      expect(JSON.parse(dashed.out[0]!).edges).toEqual([]);
      expect(JSON.stringify(since.out)).not.toContain('private body');
    });

    it('rejects malformed flags before touching the store', async () => {
      for (const bad of [['--help', '--json'], ['--window-minutes'], ['--window-minutes', '--json'],
        ['--window-minutes', '0'], ['--window-minutes', '1441'], ['--window-minutes', '1.5'],
        ['--window-minutes', 'abc'], ['--window-minutes', '60', '--window-minutes', '30'],
        ['--from'], ['--from', '--json'], ['--from', 'has space'], ['--from', ''],
        ['--from', 'a', '--from', 'b'], ['--to'], ['--to', '--json'], ['--to', 'a b'],
        ['--channel'], ['--channel', '--json'], ['--channel', 'Bad Room'], ['--channel', ''],
        ['--channel', 'a', '--channel', 'b'], ['--topic'], ['--topic', '--json'],
        ['--topic', 'has space'], ['--topic', 'x'.repeat(33)], ['--topic', 'a', '--topic', 'b'],
        ['--since'], ['--since', '--json'], ['--since', 'bogus'], ['--since', ''],
        ['--since', '1h', '--since', '2h'], ['--before', 'soon'], ['--before', '1.5h'],
        ['--priority'], ['--priority', '--json'], ['--priority', 'P4'], ['--priority', 'p1'],
        ['--priority', 'P1', '--priority', 'P2'],
        ['--kind'], ['--kind', '--json'], ['--kind', 'unknown'], ['--kind', ''],
        ['--kind', 'ask', '--kind', 'reply'],
        ['--job'], ['--job', '--json'], ['--job', 'has space'], ['--job', ''],
        ['--job', 'a', '--job', 'b'],
        ['--contains'], ['--contains', ''], ['--contains', 'x'.repeat(513)],
        ['--contains', 'a', '--contains', 'b'],
        ['--root'], ['--root', 'relative'], ['--root', root, '--root', root], ['--json', '--json'],
        ['--unknown'], ['edges']]) {
        expect((await run(bad)).code).toBe(2);
      }
      expect(await cmdFleetEdges(['--help'])).toBe(0);
    });
  });
});
