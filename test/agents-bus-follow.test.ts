import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  followAgentBus, validAgentBusFollowRequest,
  type AgentBusFollowRecord, type AgentBusFollowRequest,
} from '../src/core/agents/bus-follow.js';
import { createAgentChannel, registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import {
  postChannelMessage, readAgentInbox, sendDirectMessage,
  type InboxPage, type UnifiedBusOptions,
} from '../src/core/agents/bus-unified.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'agents-bus-follow-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

function setup(at = 1_000): UnifiedBusOptions & { clock: { now: number } } {
  const clock = { now: at };
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock };
}

function register(options: UnifiedBusOptions, ...handles: string[]): void {
  for (const handle of handles) expect(registerAgentIdentity({ handle }, options).status).toBe('created');
}

const messages = (records: AgentBusFollowRecord[]) =>
  records.filter((row): row is Extract<AgentBusFollowRecord, { type: 'message' }> => row.type === 'message');

/** Streams with a manual deadline clock and real interval sleeps: expire() ends it at the next wake. */
function follow(request: Partial<AgentBusFollowRequest> = {}, deps: Partial<Parameters<typeof followAgentBus>[2]> = {},
  options?: UnifiedBusOptions) {
  const records: AgentBusFollowRecord[] = [];
  let now = 0;
  const pending = followAgentBus(
    { agent: 'nova', durationMs: 5000, intervalMs: 100, ...request },
    options ?? { root: join(base, 'fleet') },
    { emit: (record: AgentBusFollowRecord) => { records.push(record); }, clock: () => now, ...deps });
  return { records, pending, expire: () => { now = 1_000_000_000; } };
}

it('streams addressed mail as projected inbox rows and ends with a resume checkpoint', async () => {
  const options = setup();
  register(options, 'atlas', 'nova');
  createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['nova'] }, options);
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'hello there', id: 'dm-1' }, options);
  await postChannelMessage({ from: 'atlas', channel: 'eng', text: 'room note', id: 'ch-1' }, options);
  const { records, pending, expire } = follow({ agent: 'nova' }, {}, options);
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  const rows = messages(records);
  expect(rows.map(row => row.envelope.id).sort()).toEqual(['ch-1', 'dm-1']);
  const dm = rows.find(row => row.envelope.id === 'dm-1')!;
  expect(dm).toMatchObject({ kind: 'dm', priority: 'P2', fromAgent: 'atlas', channel: null });
  expect(dm.summary).toContain('hello there');
  const ch = rows.find(row => row.envelope.id === 'ch-1')!;
  expect(ch).toMatchObject({ kind: 'channel', channel: 'eng' });
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: result.cursor });
  expect(result.delivered).toBe(2);
});

it('applies the inbox filters to the stream', async () => {
  const options = setup();
  register(options, 'atlas', 'nova');
  createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['nova'] }, options);
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'direct', id: 'dm-1' }, options);
  await postChannelMessage({ from: 'atlas', channel: 'eng', text: 'room', id: 'ch-1' }, options);
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'urgent', id: 'dm-p0', priority: 'P0' }, options);
  const { records, pending, expire } = follow({ agent: 'nova', kind: 'dm', priority: 'P0' }, {}, options);
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['dm-p0']);
});

it('resumes after a persisted cursor without replaying shown rows', async () => {
  const options = setup();
  register(options, 'atlas', 'nova');
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'one', id: 'dm-1' }, options);
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'two', id: 'dm-2' }, options);
  const first = readAgentInbox('nova', { limit: 1 }, options);
  if (first.status !== 'ok') throw new Error('inbox read failed');
  const resume = first.nextCursor;
  const { records, pending, expire } = follow({ agent: 'nova', after: resume }, {}, options);
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['dm-2']);
});

it('streams mail appended after the stream starts', async () => {
  const options = setup();
  register(options, 'atlas', 'nova');
  const { records, pending, expire } = follow({ agent: 'nova', intervalMs: 100 }, {}, options);
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'late mail', id: 'dm-late' }, options);
  await vi.waitFor(() => expect(messages(records)).toHaveLength(1), { timeout: 20_000, interval: 200 });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records)[0]).toMatchObject({ envelope: { id: 'dm-late' }, kind: 'dm' });
});

it('reports unknown-agent for an unregistered ref and invalid for a bad request', async () => {
  const options = setup();
  const ghost = follow({ agent: 'ghost' }, {}, options);
  ghost.expire();
  expect((await ghost.pending).status).toBe('unknown-agent');
  const bad = follow({ durationMs: 0 }, {}, options);
  bad.expire();
  expect((await bad.pending).status).toBe('invalid');
  const badInterval = follow({ intervalMs: 5 }, {}, options);
  badInterval.expire();
  expect((await badInterval.pending).status).toBe('invalid');
  expect(validAgentBusFollowRequest({ agent: 'nova', durationMs: 1000 })).toBe(true);
  expect(validAgentBusFollowRequest({ agent: '', durationMs: 1000 })).toBe(false);
});

it('fails the stream when the output rejects a record', async () => {
  const options = setup();
  register(options, 'atlas', 'nova');
  await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'one', id: 'dm-1' }, options);
  const records: AgentBusFollowRecord[] = [];
  const now = 0;
  const pending = followAgentBus({ agent: 'nova', durationMs: 5000, intervalMs: 100 }, options, {
    emit: (record: AgentBusFollowRecord) => {
      if (record.type === 'message') throw new Error('sink closed');
      records.push(record);
    },
    clock: () => now,
  });
  const result = await pending;
  expect(result.status).toBe('output-unavailable');
  expect(result.delivered).toBe(0);
});

it('cancels on abort', async () => {
  const options = setup();
  register(options, 'nova');
  const controller = new AbortController();
  const records: AgentBusFollowRecord[] = [];
  const now = 0;
  const pending = followAgentBus({ agent: 'nova', durationMs: 60_000, intervalMs: 100 }, options, {
    emit: (record: AgentBusFollowRecord) => { records.push(record); },
    signal: controller.signal,
    clock: () => now,
  });
  controller.abort();
  const result = await pending;
  expect(result.status).toBe('cancelled');
});

it('maps injected page statuses honestly: retryable pauses, unavailable and invalid fail', async () => {
  const options = setup();
  const okPage: InboxPage = { status: 'ok', agent: 'nova', messages: [], nextCursor: 0 };
  const unavailable = follow({ agent: 'nova' }, {
    read: () => ({ status: 'unavailable', reason: 'store down' }),
  }, options);
  unavailable.expire();
  expect((await unavailable.pending).status).toBe('source-unavailable');
  const invalid = follow({ agent: 'nova' }, {
    read: () => ({ status: 'invalid', reason: 'bad filter' }),
  }, options);
  invalid.expire();
  expect((await invalid.pending).status).toBe('invalid');
  // A retryable page pauses and re-reads; the next ok page lets the stream expire normally.
  let calls = 0;
  const retryable = follow({ agent: 'nova', intervalMs: 100 }, {
    read: () => (++calls === 1 ? { status: 'retryable', reason: 'contended' } : okPage),
  }, options);
  await new Promise(resolve => setTimeout(resolve, 250));
  retryable.expire();
  const result = await retryable.pending;
  expect(result.status).toBe('expired');
  expect(calls).toBeGreaterThanOrEqual(2);
});

/** Bulk-seeds a valid private store; per-row appends are too slow for >100 rows. */
function seedInbox(root: string, rows: BusInboxReceipt[]): void {
  mkdirSync(join(root, 'bus-inbox'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), JSON.stringify(rows), { mode: 0o600 });
}

it('drains a backlog across full pages inside one deadline', async () => {
  const options = setup();
  register(options, 'atlas', 'nova');
  // 105 addressed receipts: two full 100-row reads plus a tail, all inside the
  // stream's own polls — the full-page fast path must not sleep between them.
  seedInbox(options.root!, Array.from({ length: 105 }, (_, index) => {
    const envelope: BusEnvelope = { id: `dm-${index}`, from: 'agent:atlas', to: 'agent:nova',
      priority: 'P2', ttl: 3_600_000, body: { fake: 'data' } };
    return { cursor: index + 1, receivedAt: 1_000, envelope };
  }));
  const { records, pending, expire } = follow({ agent: 'nova', durationMs: 30_000 }, {}, options);
  await vi.waitFor(() => expect(messages(records)).toHaveLength(105), { timeout: 20_000, interval: 200 });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(result.delivered).toBe(105);
});

describe('agents bus follow CLI', () => {
  function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return runAgentsBusUnified(args, text => out.push(text), text => err.push(text), env)
      .then(code => ({ code, out, err }));
  }

  // The CLI reads with the real clock, so CLI-bound mail must be stamped with
  // real time too — a fixed fake `now` would expire every receipt on read.
  function cliSetup(): UnifiedBusOptions {
    return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => Date.now() };
  }

  it('requires --json and --duration-ms', async () => {
    const options = cliSetup();
    register(options, 'nova');
    const root = options.root!;
    expect((await cli(['follow', 'nova', '--duration-ms', '50', '--root', root])).code).toBe(2);
    expect((await cli(['follow', 'nova', '--json', '--root', root])).code).toBe(2);
    expect((await cli(['follow', 'nova', '--json', '--duration-ms', '0', '--root', root])).code).toBe(2);
  });

  it('emits JSONL message and checkpoint records and exits 0 on expiry', async () => {
    const options = cliSetup();
    register(options, 'atlas', 'nova');
    await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'cli mail', id: 'dm-cli' }, options);
    const { code, out } = await cli(['follow', 'nova', '--json', '--duration-ms', '300', '--interval-ms', '100',
      '--root', options.root!]);
    expect(code).toBe(0);
    const lines = out.join('\n').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const row = lines.find(record => record.type === 'message');
    expect(row).toMatchObject({ kind: 'dm', fromAgent: 'atlas', summary: expect.stringContaining('cli mail') });
    expect(row.envelope.id).toBe('dm-cli');
    expect(lines.at(-1)).toMatchObject({ type: 'checkpoint' });
  });

  it('reports unknown-agent with exit 1', async () => {
    const options = cliSetup();
    const { code } = await cli(['follow', 'ghost', '--json', '--duration-ms', '100', '--root', options.root!]);
    expect(code).toBe(1);
  });
});
