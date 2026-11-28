import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';
import { followBusStream, type BusFollowRecord } from '../src/core/fleet/bus-follow-stream.js';
import { BUS_READ_CONTAINS_MAX } from '../src/core/agents/bus-unified.js';
import { createAgentChannel, registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { cmdFleetBusFollow } from '../src/cli/fleet-bus-follow.js';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-follow-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function post(id: string, to = 'worker-a', fields: object = {}, now?: number) {
  const envelope = { id, from: 'sender', to, priority: 'P2' as const, ttl: 600_000, body: { kind: 'note' }, ...fields };
  const options = now === undefined ? { root } : { root, now: () => now };
  return appendBusInbox(envelope, options).status;
}
function collect() {
  const records: BusFollowRecord[] = [];
  return { records, emit: (record: BusFollowRecord) => { records.push(record); } };
}
const messages = (records: BusFollowRecord[]) =>
  records.filter((row): row is Extract<BusFollowRecord, { type: 'message' }> => row.type === 'message');
/** Streams with a manual deadline clock: expire() ends it at the next wake. */
function follow(request: Partial<Parameters<typeof followBusStream>[0]> = {}, deps: Partial<Parameters<typeof followBusStream>[1]> = {}) {
  const records: BusFollowRecord[] = [];
  let now = 0;
  const pending = followBusStream({ after: 0, durationMs: 5000, intervalMs: 100, root, ...request },
    { emit: (record: BusFollowRecord) => { records.push(record); }, clock: () => now, ...deps });
  return { records, pending, expire: () => { now = 10_000; } };
}

it('streams a message appended after start and ends with a resume checkpoint (real reader)', async () => {
  let now = 0;
  const { records, emit } = collect();
  const pending = followBusStream({ after: 0, durationMs: 5000, intervalMs: 100, root },
    { emit, clock: () => now });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(post('late')).toBe('posted');
  await vi.waitFor(() => expect(messages(records)).toHaveLength(1), { timeout: 20000, interval: 200 });
  now = 6000;
  const result = await pending;
  expect(result).toMatchObject({ status: 'expired', cursor: 1, delivered: 1 });
  expect(records[0]).toMatchObject({ type: 'message', cursor: 1, envelope: { id: 'late', to: 'worker-a', priority: 'P2' } });
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 1 });
});

it('delivers only exact --to matches while checkpoints advance past filtered rows', async () => {
  post('other-1', 'worker-b'); post('mine'); post('other-2', 'worker-b');
  const { records, pending, expire } = follow({ to: 'worker-a' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['mine']);
  expect(messages(records)[0]!.cursor).toBe(2);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('streams mail addressed under every label of the --to agent identity', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b', aliases: ['wb-alias'] }, { root }).status).toBe('created');
  post('a-bare'); post('a-address', 'agent:worker-a'); post('a-alias', 'wa-alias'); post('a-id', stableAgentId('worker-a'));
  post('b-alias', 'wb-alias'); post('topic', 'fleet.deploy');
  for (const to of ['worker-a', 'agent:worker-a', 'wa-alias', stableAgentId('worker-a')]) {
    const { records, pending, expire } = follow({ to });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual(['a-bare', 'a-address', 'a-alias', 'a-id']);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 6 });
  }
});

it('streams channel posts addressed to a member identity, minus its own posts', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b' }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a', members: ['worker-b'] }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'ops', createdBy: 'worker-b' }, { root }).status).toBe('created');
  post('chan-work', 'group:eng:general');
  post('self-post', 'group:eng:alerts', { from: 'agent:worker-a' });
  post('self-post-alias', 'group:eng:alerts', { from: 'wa-alias' });
  post('other-chan', 'group:ops:general');
  post('direct');
  // Every label of the identity sees the same channel posts `bus next` claims.
  for (const to of ['worker-a', 'agent:worker-a', 'wa-alias', stableAgentId('worker-a')]) {
    const { records, pending, expire } = follow({ to });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual(['chan-work', 'direct']);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 5 });
  }
});

it('delivers only envelopes addressed to group:<channel>:* under every topic', async () => {
  post('eng-general', 'group:eng:general');
  post('eng-alerts', 'group:eng:alerts');
  post('ops-general', 'group:ops:general');
  post('direct', 'worker-a');
  post('eng-bare', 'group:eng');
  post('engx-room', 'group:engx:general');
  const { records, pending, expire } = follow({ channel: 'eng' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['eng-general', 'eng-alerts']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 6 });
});

it('composes --channel with --to matching', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a' }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a', members: ['worker-a'] }, { root }).status).toBe('created');
  post('eng-1', 'group:eng:general');
  post('eng-self', 'group:eng:alerts', { from: 'agent:worker-a' });
  post('ops-1', 'group:ops:general');
  post('direct', 'worker-a');
  const { records, pending, expire } = follow({ to: 'worker-a', channel: 'eng' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  // --to worker-a sees its member room minus its own posts; --channel eng
  // then keeps only that room's traffic — the self-post and the DM drop out.
  expect(messages(records).map(row => row.envelope.id)).toEqual(['eng-1']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('rejects an invalid --channel before touching the store', async () => {
  const list = vi.fn(listBusInboxAfter);
  for (const channel of ['Eng', 'has space', 'x'.repeat(33), '-lead', 'group:eng', 'eng:general']) {
    const { records, pending } = follow({ channel }, { list });
    const result = await pending;
    expect(result.status).toBe('invalid');
    expect(messages(records)).toEqual([]);
  }
  expect(list).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('keeps channel posts out of the stream when the identity registry is unreadable', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a' }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a' }, { root }).status).toBe('created');
  post('chan-work', 'group:eng:general');
  post('direct');
  writeFileSync(join(root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const { records, pending, expire } = follow({ to: 'worker-a' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['direct']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 2 });
});

it('keeps exact-label matching when the identity registry is unreadable', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('exact', 'agent:worker-a'); post('alias-work', 'wa-alias');
  writeFileSync(join(root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const { records, pending, expire } = follow({ to: 'agent:worker-a' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['exact']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 2 });
});

it('delivers only envelopes citing --job while checkpoints advance past the rest', async () => {
  const job = 'RQ-TEST-JOB-1';
  post('plain');
  post('other-job', 'worker-a', { body: { kind: 'work.post', jobId: 'RQ-OTHER-JOB', title: 'x' } });
  post('work-post', 'worker-a', { body: { kind: 'work.post', jobId: job, title: 'x' } });
  post('wake', 'worker-a', { body: { kind: 'wake', target: 'worker-a', reason: 'go', jobId: job } });
  post('thread-note', 'worker-a', { body: { kind: 'note', thread: `job:${job}` } });
  post('bare-thread', 'worker-a', { body: { kind: 'note', thread: job } });
  post('handoff', 'worker-a', { body: { kind: 'worker-handoff', taskId: job, prompt: 'run it' } });
  // work.claim/release carry jobId as an operation parameter, never a citation.
  post('claim-op', 'worker-a', { body: { kind: 'work.claim', op: 'acquire', jobId: job } });
  const { records, pending, expire } = follow({ job });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['work-post', 'wake', 'thread-note', 'handoff']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 8 });
});

it('applies --job on top of --to matching', async () => {
  const job = 'RQ-TEST-JOB-2';
  post('mine-job', 'worker-a', { body: { kind: 'work.post', jobId: job, title: 'x' } });
  post('mine-other', 'worker-a');
  post('theirs-job', 'worker-b', { body: { kind: 'work.post', jobId: job, title: 'x' } });
  const { records, pending, expire } = follow({ to: 'worker-a', job });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['mine-job']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('resumes from an emitted checkpoint without redelivering messages', async () => {
  post('first');
  const before = follow();
  before.expire();
  await before.pending;
  const cursor = (before.records.at(-1) as Extract<BusFollowRecord, { type: 'checkpoint' }>).cursor;
  expect(cursor).toBe(1);
  post('second');
  const after = follow({ after: cursor });
  after.expire();
  const result = await after.pending;
  expect(result.status).toBe('expired');
  expect(messages(after.records).map(row => row.envelope.id)).toEqual(['second']);
  expect(result.cursor).toBe(2);
});

it('advances checkpoints over expired retained rows (sparse cursors)', async () => {
  post('stale-1', 'worker-a', { ttl: 5_000 }, 0);
  post('fresh');
  post('stale-2', 'worker-a', { ttl: 5_000 }, 0);
  const { records, pending, expire } = follow();
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => [row.cursor, row.envelope.id])).toEqual([[2, 'fresh']]);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('never emits a checkpoint ahead of records accepted by the output stream', async () => {
  post('one'); post('two');
  const calls: string[] = [];
  let now = 0, release: (() => void) | undefined;
  const pending = followBusStream({ after: 0, durationMs: 1500, intervalMs: 100, root }, {
    clock: () => now,
    emit: (record: BusFollowRecord) => new Promise<void>(resolve => {
      calls.push(record.type);
      if (calls.length === 1) release = () => resolve(); else resolve();
    }),
  });
  await vi.waitFor(() => expect(calls).toEqual(['message']), { timeout: 20000 });
  // While the first message's acceptance is pending no further record may be offered.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(calls).toEqual(['message']);
  release!();
  await vi.waitFor(() => expect(calls).toEqual(['message', 'message', 'checkpoint']), { timeout: 20000 });
  now = 2000;
  await vi.waitFor(() => expect(calls).toEqual(['message', 'message', 'checkpoint', 'checkpoint']), { timeout: 20000 });
  expect((await pending).status).toBe('expired');
});

it('cancels promptly on an injected signal and removes signal listeners', async () => {
  const controller = new AbortController();
  const emitted: string[] = [];
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  const started = performance.now();
  const pending = cmdFleetBusFollow(
    ['--after', '0', '--duration-ms', '30000', '--interval-ms', '60000', '--root', root, '--json'],
    { signal: controller.signal, emit: (json: string) => { emitted.push(json); } });
  setTimeout(() => controller.abort(), 30);
  expect(await pending).toBe(0);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(emitted).toEqual([]);
  expect(process.listenerCount('SIGINT')).toBe(sigint);
  expect(process.listenerCount('SIGTERM')).toBe(sigterm);
});

it('fails closed on unavailable, malformed or beyond-store pages without advancing a checkpoint', async () => {
  post('retained');
  const { records, emit } = collect();
  const envelope = { id: 'x', from: 'a', to: 'b', priority: 'P2' as const, ttl: 1_000, body: null };
  const malformed: BusInboxPage = { status: 'ok', messages: [{ cursor: 5, receivedAt: 0, envelope }], nextCursor: 2 };
  const request = { after: 0, durationMs: 250, intervalMs: 100, root };
  expect(await followBusStream(request, { emit, list: () => ({ status: 'unavailable' }) }))
    .toMatchObject({ status: 'source-unavailable', cursor: 0, delivered: 0 });
  expect(await followBusStream(request, { emit, list: () => malformed }))
    .toMatchObject({ status: 'source-unavailable', cursor: 0, delivered: 0 });
  // The real reader refuses a resume cursor beyond the store's high-water mark.
  expect(await followBusStream({ ...request, after: 99 }, { emit }))
    .toMatchObject({ status: 'source-unavailable', cursor: 99, delivered: 0 });
  expect(records).toEqual([]);
});

it('retries retryable reads within the deadline and still expires cleanly', async () => {
  post('ok');
  let calls = 0;
  const { records, emit } = collect();
  const list: typeof listBusInboxAfter = (after, limit, options) =>
    ++calls === 1 ? { status: 'retryable' } : listBusInboxAfter(after, limit, options);
  const result = await followBusStream({ after: 0, durationMs: 400, intervalMs: 100, root }, { emit, list });
  expect(result.status).toBe('expired');
  expect(calls).toBeGreaterThan(1);
  expect(messages(records).map(row => row.envelope.id)).toEqual(['ok']);
});

it('bus-follow rejects invalid arguments before touching the store', async () => {
  const emitted: string[] = [], list = vi.fn(listBusInboxAfter);
  const emit = (json: string) => { emitted.push(json); };
  const good = ['--after', '0', '--duration-ms', '300', '--root', root, '--json'];
  for (const args of [[], good.slice(0, -1), [...good, '--json'], [...good, '--after', '1'], [...good, '--bogus'], [...good, 'extra'],
    ['--duration-ms', '300', '--root', root, '--json'], ['--after', '0', '--root', root, '--json'], ['--after'],
    ['--after', '-1', ...good.slice(2)], ['--after', '1e2', ...good.slice(2)],
    ['--after', '0', '--duration-ms', '0', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '3600001', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--interval-ms', '99', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--interval-ms', '60001', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--to', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--channel', 'Eng', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--channel', 'has space', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--channel', 'x'.repeat(33), '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--channel=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--channel', 'eng', '--channel', 'ops', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--job', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--job=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--job', 'RQ-1', '--job', 'RQ-2', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--from', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--exclude-from', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--to', 'worker-a', '--with', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--with', 'worker-b', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--to', 'worker-a', '--with', 'worker-b', '--with', 'worker-c', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--exclude-from=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--exclude-from', 'worker-a', '--exclude-from', 'worker-b', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--priority', 'P9', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--thread', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--body-kind', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--body-kind=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--body-kind', 'note', '--body-kind', 'task', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--result', 'bogus', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--result', 'FAILED', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--result=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--result', 'failed', '--result', 'complete', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--since', 'not-a-time', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--since', '-5', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--before', 'not-a-time', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--before', '-5', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--before', '9999999999999999', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--before', '15m', '--before', '2h', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--contains', '', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--contains=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--contains', '   ', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--contains', 'x'.repeat(BUS_READ_CONTAINS_MAX + 1), '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--contains', 'alpha', '--contains', 'beta', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--contains', '--json', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--root', 'relative', '--json'],
    ['--after', '0', '--duration-ms', '100', '--root', root, '--to', '--json']]) {
    expect(await cmdFleetBusFollow(args, { emit, list })).toBe(2);
    expect(JSON.parse(emitted.at(-1)!)).toEqual({ status: 'invalid' });
  }
  expect(list).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('emits scrubbed JSONL through the CLI and expires with a final checkpoint', async () => {
  post('secret-body', 'worker-a', { body: { token: 'fake-token-value', text: 'sk-' + 'FAKE0000000000000000' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(rows[0]).toMatchObject({ type: 'message', cursor: 1, envelope: { id: 'secret-body' } });
  expect(emitted.join()).not.toContain('fake-token-value');
  expect(emitted.join()).not.toContain('FAKE0000000000000000');
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 1 });
});

it('filters the CLI stream by --job', async () => {
  post('noise');
  post('hit', 'worker-a', { body: { kind: 'work.post', jobId: 'RQ-CLI-JOB', title: 't' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--job', 'RQ-CLI-JOB', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['hit']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 2 });
});

it('filters the CLI stream by --channel', async () => {
  post('eng-1', 'group:eng:general');
  post('noise', 'worker-a');
  post('eng-2', 'group:eng:alerts');
  post('ops-1', 'group:ops:general');
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--channel', 'eng', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['eng-1', 'eng-2']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('filters the CLI stream by --before', async () => {
  const edge = Date.now() - 60_000;
  post('old', 'worker-a', {}, edge - 60_000);
  post('edge', 'worker-a', {}, edge);
  post('new');
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--before', String(edge), '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['old']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only envelopes from --from senders under every registered spelling', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('noise');
  post('bare', 'worker-a', { from: 'worker-a' });
  post('address', 'worker-a', { from: 'agent:worker-a' });
  post('alias', 'worker-a', { from: 'wa-alias' });
  post('id', 'worker-a', { from: stableAgentId('worker-a') });
  post('other', 'worker-a', { from: 'worker-b' });
  for (const from of ['worker-a', 'agent:worker-a', 'wa-alias', stableAgentId('worker-a')]) {
    const { records, pending, expire } = follow({ from });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual(['bare', 'address', 'alias', 'id']);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 6 });
  }
});

it('keeps exact-label --from matching for a case-variant agent ref', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('bare', 'worker-a', { from: 'worker-a' });
  post('address', 'worker-a', { from: 'agent:worker-a' });
  post('alias', 'worker-a', { from: 'wa-alias' });
  post('stamped', 'worker-a', { from: 'Worker-A' });
  // 'Worker-A' names no registered label exactly, so it matches only the
  // literal 'Worker-A' stamp — never the identity's other spellings.
  for (const [from, ids] of [['Worker-A', ['stamped']], ['WA-ALIAS', []], ['agent:Worker-A', []]] as const) {
    const { records, pending, expire } = follow({ from });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual(ids);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
  }
});

it('keeps exact-label --from matching when the identity registry is unreadable', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('exact', 'worker-a', { from: 'agent:worker-a' });
  post('alias', 'worker-a', { from: 'wa-alias' });
  post('bare', 'worker-a', { from: 'worker-a' });
  writeFileSync(join(root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const { records, pending, expire } = follow({ from: 'agent:worker-a' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['exact']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('drops envelopes sent under every registered spelling of --exclude-from', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('noise');
  post('bare', 'worker-a', { from: 'worker-a' });
  post('address', 'worker-a', { from: 'agent:worker-a' });
  post('alias', 'worker-a', { from: 'wa-alias' });
  post('id', 'worker-a', { from: stableAgentId('worker-a') });
  post('other', 'worker-a', { from: 'worker-b' });
  for (const excludeFrom of ['worker-a', 'agent:worker-a', 'wa-alias', stableAgentId('worker-a')]) {
    const { records, pending, expire } = follow({ excludeFrom });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual(['noise', 'other']);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 6 });
  }
});

it('keeps exact-label --exclude-from matching when the identity registry is unreadable', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('exact', 'worker-a', { from: 'agent:worker-a' });
  post('alias', 'worker-a', { from: 'wa-alias' });
  post('bare', 'worker-a', { from: 'worker-a' });
  post('other', 'worker-a', { from: 'worker-b' });
  writeFileSync(join(root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const { records, pending, expire } = follow({ excludeFrom: 'agent:worker-a' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['alias', 'bare', 'other']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('composes --exclude-from with --to', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a' }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b' }, { root }).status).toBe('created');
  post('kept', 'worker-a', { from: 'agent:worker-a' });
  post('dropped-sender', 'worker-a', { from: 'agent:worker-b' });
  post('dropped-recipient', 'worker-b', { from: 'agent:worker-b' });
  const { records, pending, expire } = follow({ to: 'worker-a', excludeFrom: 'agent:worker-b' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['kept']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only the --to/--with pairwise exchange while checkpoints advance', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b', aliases: ['wb-alias'] }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-c' }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a', members: ['worker-b'] }, { root }).status).toBe('created');
  post('b-direct', 'worker-a', { from: 'agent:worker-b' });
  post('b-address', 'agent:worker-a', { from: 'wb-alias' });
  post('c-direct', 'worker-a', { from: 'agent:worker-c' });
  // A member-channel post the peer sent still streams under --to worker-a,
  // but --with keeps only the identity-addressed exchange, so it drops out.
  post('b-channel', 'group:eng:general', { from: 'agent:worker-b' });
  post('b-bare', 'worker-a', { from: 'worker-b' });
  post('b-reverse', 'worker-b', { from: 'agent:worker-a' });
  const { records, pending, expire } = follow({ to: 'worker-a', with: 'worker-b' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['b-direct', 'b-address', 'b-bare']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 6 });
});

it('rejects --with without --to as an invalid request', async () => {
  const list = vi.fn(listBusInboxAfter);
  for (const request of [{ with: 'worker-b' }, { with: 'worker-b', from: 'worker-a' }]) {
    const { pending } = follow(request, { list });
    const result = await pending;
    expect(result.status).toBe('invalid');
  }
  expect(list).not.toHaveBeenCalled();
});

it('keeps exact-label --with matching when the peer resolves to no identity', async () => {
  post('hit', 'worker-a', { from: 'worker-b' });
  post('miss-sender', 'worker-a', { from: 'agent:worker-b' });
  post('miss-recipient', 'worker-b', { from: 'worker-b' });
  post('noise', 'worker-c', { from: 'worker-b' });
  const { records, pending, expire } = follow({ to: 'worker-a', with: 'worker-b' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['hit']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('filters the CLI stream by --with', async () => {
  expect(registerAgentIdentity({ handle: 'worker-a' }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b' }, { root }).status).toBe('created');
  post('peer-dm', 'worker-a', { from: 'agent:worker-b' });
  post('noise', 'worker-a');
  post('peer-other', 'worker-b', { from: 'agent:worker-b' });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--to', 'worker-a', '--with', 'worker-b', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['peer-dm']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('filters the CLI stream by --exclude-from', async () => {
  post('noise');
  post('drop', 'worker-a', { from: 'agent:worker-a' });
  post('keep', 'worker-a', { from: 'worker-b' });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--exclude-from', 'agent:worker-a', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['noise', 'keep']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only envelopes at --priority while checkpoints advance past the rest', async () => {
  post('p2-default');
  post('p0', 'worker-a', { priority: 'P0' });
  post('p1', 'worker-a', { priority: 'P1' });
  post('p0-two', 'worker-a', { priority: 'P0' });
  const { records, pending, expire } = follow({ priority: 'P0' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['p0', 'p0-two']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('delivers only note/context envelopes carrying --thread', async () => {
  post('t1-note', 'worker-a', { body: { kind: 'note', thread: 't-1' } });
  post('t1-context', 'worker-a', { body: { kind: 'context', thread: 't-1' } });
  post('t2-note', 'worker-a', { body: { kind: 'note', thread: 't-2' } });
  post('no-thread', 'worker-a', { body: { kind: 'note' } });
  post('work-body', 'worker-a', { body: { kind: 'work.post', jobId: 'RQ-X', title: 'x' } });
  const { records, pending, expire } = follow({ thread: 't-1' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['t1-note', 't1-context']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 5 });
});

it('delivers only envelopes received at or after --since', async () => {
  post('old', 'worker-a', {}, Date.now() - 120_000);
  post('boundary', 'worker-a', {}, Date.now() - 30_000);
  post('new');
  const { records, pending, expire } = follow({ since: Date.now() - 60_000 });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['boundary', 'new']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only envelopes received strictly before --before', async () => {
  const edge = Date.now() - 60_000;
  post('old', 'worker-a', {}, edge - 60_000);
  post('edge', 'worker-a', {}, edge);
  post('new');
  const { records, pending, expire } = follow({ before: edge });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['old']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('keeps only envelopes inside the [since, before) window', async () => {
  const base = Date.now();
  post('w-old', 'worker-a', {}, base - 300_000);
  post('w-lo', 'worker-a', {}, base - 200_000);
  post('w-hi', 'worker-a', {}, base - 100_000);
  post('w-new', 'worker-a', {}, base);
  const { records, pending, expire } = follow({ since: base - 200_000, before: base - 100_000 });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  // since is inclusive and before exclusive: w-lo sits on the lower bound,
  // w-hi on the upper, and only w-lo streams.
  expect(messages(records).map(row => row.envelope.id)).toEqual(['w-lo']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('applies --from, --priority, --thread and --since together', async () => {
  post('hit', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-9' } });
  post('wrong-sender', 'worker-a', { from: 'worker-b', priority: 'P0', body: { kind: 'note', thread: 't-9' } });
  post('wrong-priority', 'worker-a', { from: 'agent:worker-a', priority: 'P2', body: { kind: 'note', thread: 't-9' } });
  post('wrong-thread', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-8' } });
  post('old-hit', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-9' } }, Date.now() - 120_000);
  const { records, pending, expire } = follow({ from: 'agent:worker-a', priority: 'P0', thread: 't-9', since: Date.now() - 60_000 });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['hit']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 5 });
});

it('filters the CLI stream by --from, --priority, --thread and --since', async () => {
  post('noise');
  post('hit', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-cli' } });
  post('old-hit', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-cli' } }, Date.now() - 120_000);
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--from', 'agent:worker-a', '--priority', 'P0', '--thread', 't-cli', '--since', String(Date.now() - 60_000),
    '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['hit']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only envelopes whose summary carries --contains while checkpoints advance', async () => {
  post('alpha-note', 'worker-a', { body: { kind: 'note', text: 'Review the   ALPHA\nrollout' } });
  post('beta-note', 'worker-a', { body: { kind: 'note', text: 'unrelated beta chatter' } });
  post('alpha-status', 'worker-a', { body: { kind: 'work.status', jobId: 'RQ-S', status: 'running', detail: 'alpha gate holds' } });
  post('alpha-reply', 'worker-a', { body: { inReplyTo: 'alpha-note', text: 'Alpha ack' } });
  post('alpha-secret', 'worker-a', { body: { kind: 'note', text: 'alpha key sk-' + 'FAKE0000000000000000' } });
  post('alpha-proto', 'fleet.deploy', { body: {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'artifact:run-9/plan.md' },
    correlation_id: 'corr-1', payload: { text: 'alpha-payload' } } });
  for (const [needle, expected] of [
    ['ALPHA', ['alpha-note', 'alpha-status', 'alpha-reply', 'alpha-secret']],
    ['the alpha rollout', ['alpha-note']],
    ['fleet.deploy', ['alpha-proto']],
    ['artifact:run-9/plan.md', ['alpha-proto']],
    // The protocol payload and the scrubbed secret value stay unfindable.
    ['alpha-payload', []],
    ['sk-' + 'fake0000000000000000', []],
    ['corr-1', []],
  ] as const) {
    const { records, pending, expire } = follow({ contains: needle });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual([...expected]);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 6 });
  }
});

it('composes --contains with the other bus-follow filters', async () => {
  post('hit', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-c', text: 'alpha rollout' } });
  post('wrong-text', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-c', text: 'beta rollout' } });
  post('wrong-priority', 'worker-a', { from: 'agent:worker-a', priority: 'P2', body: { kind: 'note', thread: 't-c', text: 'alpha rollout' } });
  const { records, pending, expire } = follow({ from: 'agent:worker-a', priority: 'P0', thread: 't-c', contains: 'alpha' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['hit']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('filters the CLI stream by --contains', async () => {
  post('noise', 'worker-a', { body: { kind: 'note', text: 'nothing relevant' } });
  post('hit', 'worker-a', { body: { kind: 'note', text: 'deploy the ALPHA build' } });
  post('hit-two', 'worker-a', { body: { kind: 'work.status', jobId: 'RQ-C', status: 'done', detail: 'alpha shipped' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--contains=alpha', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['hit', 'hit-two']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only the envelope carrying --id while checkpoints advance past the rest', async () => {
  post('first'); post('wanted'); post('last');
  const { records, pending, expire } = follow({ id: 'wanted' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['wanted']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only object bodies whose own inReplyTo matches --in-reply-to', async () => {
  post('request');
  post('reply-one', 'worker-a', { body: { inReplyTo: 'request', text: 'ack' } });
  post('reply-two', 'worker-a', { body: { inReplyTo: 'request', text: 'ack2' } });
  post('other-parent', 'worker-a', { body: { inReplyTo: 'other', text: 'ack' } });
  post('non-string', 'worker-a', { body: { inReplyTo: 42, text: 'ack' } });
  post('string-body', 'worker-a', { body: 'request' });
  post('array-body', 'worker-a', { body: ['request'] });
  post('proto-reply', 'fleet.deploy', { body: {
    protocol: { version: 1, kind: 'result', topic: 'fleet.deploy' }, inReplyTo: 'request' } });
  const { records, pending, expire } = follow({ inReplyTo: 'request' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['reply-one', 'reply-two', 'proto-reply']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 8 });
});

it('delivers only protocol-v1 bodies of --kind while v2 and plain bodies never match', async () => {
  post('plain', 'worker-a', { body: { kind: 'note' } });
  post('v2-work', 'worker-a', { body: { kind: 'work.post', jobId: 'RQ-K', title: 'x' } });
  post('task', 'worker-a', { body: { protocol: { version: 1, kind: 'task' } } });
  post('result', 'worker-a', { body: { protocol: { version: 1, kind: 'result' } } });
  post('task-two', 'fleet.deploy', { body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } } });
  const { records, pending, expire } = follow({ kind: 'task' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['task', 'task-two']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 5 });
});

it('delivers only protocol bodies whose topic matches --topic exactly or by namespace', async () => {
  post('deploy', 'fleet.deploy', { body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } } });
  post('deploy-canary', 'fleet.deploy.canary', { body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy.canary' } } });
  post('repo-topic', 'repo.phantom', { body: { protocol: { version: 1, kind: 'task', topic: 'repo.phantom' } } });
  post('no-topic', 'worker-a', { body: { protocol: { version: 1, kind: 'task' } } });
  post('plain');
  for (const [topic, expected] of [
    ['fleet.deploy', ['deploy']],
    ['fleet.*', ['deploy', 'deploy-canary']],
    ['fleet.deploy.*', ['deploy-canary']],
    ['repo.*', ['repo-topic']],
    ['human.*', []],
  ] as const) {
    const { records, pending, expire } = follow({ topic });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual([...expected]);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 5 });
  }
});

it('delivers only envelopes whose body carries the --body-kind discriminator', async () => {
  post('note-one', 'worker-a', { body: { kind: 'note' } });
  post('note-two', 'worker-a', { body: { kind: 'note', thread: 't' } });
  post('work-post', 'worker-a', { body: { kind: 'work.post', jobId: 'RQ-BK', title: 'x' } });
  post('handoff', 'worker-a', { body: { kind: 'worker-handoff', taskId: 'RQ-BK', prompt: 'run' } });
  post('proto-task', 'fleet.deploy', { body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } } });
  post('typed', 'worker-a', { body: { type: 'incident.notice', text: 'x' } });
  post('schemad', 'worker-a', { body: { schema: 'fleet.thing' } });
  post('kindless', 'worker-a', { body: { inReplyTo: 'req', text: 'ack' } });
  post('string-body', 'worker-a', { body: 'plain text' });
  post('kind-wins', 'worker-a', { body: { kind: 'context', protocol: { version: 1, kind: 'task' } } });
  for (const [bodyKind, expected] of [
    ['note', ['note-one', 'note-two']],
    ['work.post', ['work-post']],
    ['worker-handoff', ['handoff']],
    // A protocol-v1 body with no top-level kind still discriminates on protocol.kind.
    ['task', ['proto-task']],
    ['incident.notice', ['typed']],
    ['fleet.thing', ['schemad']],
    // The v2 kind field wins over protocol.kind; the match stays case-sensitive.
    ['context', ['kind-wins']],
    ['Note', []],
    ['bogus', []],
  ] as const) {
    const { records, pending, expire } = follow({ bodyKind });
    expire();
    const result = await pending;
    expect(result.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual([...expected]);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 10 });
  }
});

it('composes --body-kind with the other bus-follow filters', async () => {
  post('hit', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-bk', text: 'alpha' } });
  post('wrong-kind', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'context', thread: 't-bk', text: 'alpha' } });
  post('wrong-text', 'worker-a', { from: 'agent:worker-a', priority: 'P0', body: { kind: 'note', thread: 't-bk', text: 'beta' } });
  const { records, pending, expire } = follow({ from: 'agent:worker-a', priority: 'P0', thread: 't-bk', contains: 'alpha', bodyKind: 'note' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['hit']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('delivers only work.result envelopes whose own outcome matches --result', async () => {
  const result = (id: string, outcome: string) =>
    post(id, 'worker-a', { body: { kind: 'work.result', jobId: 'RQ-R', claimKey: 'queue:q1', queueId: 'q1', receiptId: `rc-${id}`, outcome } });
  result('res-reserved', 'reserved');
  result('res-admitted', 'admitted');
  result('res-complete', 'complete');
  result('res-failed', 'failed');
  // A work.result whose outcome is absent or outside the vocabulary reports
  // no provable outcome and never matches a valid filter value.
  post('res-no-outcome', 'worker-a', { body: { kind: 'work.result', jobId: 'RQ-R' } });
  result('res-bogus', 'bogus');
  // work.release carries its own released/completed outcome — a different
  // vocabulary the kind-scoped match never reads.
  post('release-done', 'worker-a', { body: { kind: 'work.release', claimKey: 'queue:q1', token: 't', outcome: 'completed' } });
  post('release-rel', 'worker-a', { body: { kind: 'work.release', claimKey: 'queue:q1', token: 't', outcome: 'released' } });
  post('status', 'worker-a', { body: { kind: 'work.status', jobId: 'RQ-R', status: 'running' } });
  post('note', 'worker-a', { body: { kind: 'note', text: 'x' } });
  // A protocol-v1 result kind is not a v2 work.result body.
  post('proto-result', 'fleet.deploy', { body: { protocol: { version: 1, kind: 'result', topic: 'fleet.deploy' } } });
  post('kindless', 'worker-a', { body: { inReplyTo: 'req', text: 'ack' } });
  for (const [outcome, expected] of [
    ['reserved', ['res-reserved']],
    ['admitted', ['res-admitted']],
    ['complete', ['res-complete']],
    ['failed', ['res-failed']],
  ] as const) {
    const { records, pending, expire } = follow({ result: outcome });
    expire();
    const stream = await pending;
    expect(stream.status).toBe('expired');
    expect(messages(records).map(row => row.envelope.id)).toEqual([...expected]);
    expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 12 });
  }
});

it('composes --result with the other bus-follow filters', async () => {
  const result = (id: string, outcome: string, jobId = 'RQ-R2') =>
    post(id, 'worker-a', { body: { kind: 'work.result', jobId, outcome } });
  result('hit', 'failed');
  result('wrong-outcome', 'complete');
  result('other-job', 'failed', 'RQ-OTHER');
  post('hit-note', 'worker-a', { body: { kind: 'note', thread: 'job:RQ-R2', text: 'x' } });
  const { records, pending, expire } = follow({ result: 'failed', job: 'RQ-R2' });
  expire();
  const stream = await pending;
  expect(stream.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['hit']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('filters the CLI stream by --result', async () => {
  post('noise');
  post('hit', 'worker-a', { body: { kind: 'work.result', jobId: 'RQ-R-CLI', outcome: 'failed' } });
  post('miss', 'worker-a', { body: { kind: 'work.result', jobId: 'RQ-R-CLI', outcome: 'complete' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--result', 'failed', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['hit']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('composes --id, --in-reply-to, --kind and --topic with the other filters', async () => {
  post('noise', 'worker-a', { body: { kind: 'note' } });
  post('hit', 'fleet.deploy', { body: {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, inReplyTo: 'req-9' } });
  post('wrong-kind', 'fleet.deploy', { body: {
    protocol: { version: 1, kind: 'result', topic: 'fleet.deploy' }, inReplyTo: 'req-9' } });
  post('wrong-reply', 'fleet.deploy', { body: {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, inReplyTo: 'req-8' } });
  post('wrong-topic', 'repo.phantom', { body: {
    protocol: { version: 1, kind: 'task', topic: 'repo.phantom' }, inReplyTo: 'req-9' } });
  const { records, pending, expire } = follow({ id: 'hit', inReplyTo: 'req-9', kind: 'task', topic: 'fleet.*' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['hit']);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 5 });
});

it('rejects invalid --id, --in-reply-to, --kind and --topic before touching the store', async () => {
  const emitted: string[] = [], list = vi.fn(listBusInboxAfter);
  const emit = (json: string) => { emitted.push(json); };
  for (const args of [
    ['--after', '0', '--duration-ms', '100', '--id', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--id=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--id', 'x', '--id', 'y', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--in-reply-to', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--in-reply-to=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--kind', 'bogus', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--kind=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--kind', 'task', '--kind', 'result', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--topic', 'bad topic', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--topic', 'deploy', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--topic', 'fleet.*.*', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--topic=', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--topic', 'fleet.*', '--topic', 'repo.*', '--root', root, '--json'],
  ]) {
    expect(await cmdFleetBusFollow(args, { emit, list })).toBe(2);
    expect(JSON.parse(emitted.at(-1)!)).toEqual({ status: 'invalid' });
  }
  expect(list).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('filters the CLI stream by --kind and --topic', async () => {
  post('noise');
  post('hit', 'fleet.deploy', { body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } } });
  post('other-kind', 'fleet.deploy', { body: { protocol: { version: 1, kind: 'result', topic: 'fleet.deploy' } } });
  post('other-topic', 'repo.phantom', { body: { protocol: { version: 1, kind: 'task', topic: 'repo.phantom' } } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--kind', 'task', '--topic', 'fleet.*', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['hit']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 4 });
});

it('filters the CLI stream by --body-kind', async () => {
  post('noise');
  post('hit', 'worker-a', { body: { kind: 'work.status', jobId: 'RQ-BK-CLI', status: 'running' } });
  post('miss', 'worker-a', { body: { kind: 'note', text: 'x' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--body-kind', 'work.status', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['hit']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('filters the CLI stream by --id and --in-reply-to', async () => {
  post('request');
  post('reply', 'worker-a', { body: { inReplyTo: 'request', text: 'ack' } });
  post('unrelated', 'worker-a', { body: { inReplyTo: 'other', text: 'ack' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100',
    '--in-reply-to', 'request', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(messages(rows).map(row => row.envelope.id)).toEqual(['reply']);
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('owns its help and dispatches through the fleet verb convention', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBusFollow(['--help'])).toBe(0);
  expect(out).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet bus-follow'));
  expect(resolveFleetSubcommand('bus-follow')).toEqual({ module: './fleet-bus-follow.js', exportName: 'cmdFleetBusFollow' });
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: unknown) => {
    lines.push(String(chunk));
    if (typeof callback === 'function') (callback as (error?: Error | null) => void)();
    return true;
  }) as typeof process.stdout.write);
  post('via-dispatch');
  expect(await cmdFleet(['bus-follow', '--after', '0', '--duration-ms', '250', '--interval-ms', '100', '--root', root, '--json'])).toBe(0);
  const rows = lines.map(line => JSON.parse(line) as BusFollowRecord);
  expect(rows[0]).toMatchObject({ type: 'message', cursor: 1, envelope: { id: 'via-dispatch' } });
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 1 });
});
