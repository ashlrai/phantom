import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, chmod, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { replayQueueSpool, type QueueReplayEvent, type QueueSpoolReplayOptions } from '../src/core/observability/queue-spool-replay.js';

// Synthetic adapter fixture, not an assertion about #951's unavailable schema.
function decode(value: unknown): QueueReplayEvent {
  const row = value as Record<string, string>;
  return { id: row.eventId, distinctId: row.jobId, timestamp: row.at,
    properties: { station: row.station, kind: row.kind } };
}

const fixture = new URL('./fixtures/queue-spool-replay.jsonl', import.meta.url);
const route = { endpoint: 'https://posthog.invalid/i/v0/e/', projectToken: 'fixture-project-token' };
const success = () => new Response('{"status":1}', { status: 200 });
let dir: string;
let spoolPath: string;
let options: QueueSpoolReplayOptions;
const transport = vi.fn<typeof fetch>();
const ambientFetch = vi.fn(() => { throw new Error('Tests must never use ambient fetch'); });

beforeEach(async () => {
  vi.stubGlobal('fetch', ambientFetch);
  transport.mockReset().mockImplementation(async () => success());
  dir = await mkdtemp(join(homedir(), 'queue-replay-'));
  spoolPath = join(dir, 'hops.jsonl');
  await copyFile(fixture, spoolPath);
  options = { spoolPath, route, decode, fetchImpl: transport };
});

afterEach(async () => {
  expect(ambientFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('queue spool replay', () => {
  it('replays the fixture exactly once per id, persists receipts and leaves the spool byte-identical', async () => {
    const before = await readFile(spoolPath);
    expect(await replayQueueSpool(options)).toEqual({ status: 'complete', sent: 3, skipped: 1, deferred: 0 });
    expect(transport).toHaveBeenCalledTimes(3);
    const bodies = transport.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies.map(body => body.properties.kind)).toEqual(['arrival', 'start', 'complete']);
    expect(bodies[0]).toMatchObject({ event: 'queue.v1', distinct_id: 'job-001',
      timestamp: '2026-10-26T10:00:00.000Z', api_key: route.projectToken,
      properties: { station: 'READY', kind: 'arrival', $process_person_profile: false } });
    expect(bodies[0].uuid).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(new Set(bodies.map(body => body.uuid)).size).toBe(3);
    expect(JSON.stringify(bodies)).not.toContain('fixture content must stay local');
    const ledger = await readFile(`${spoolPath}.replayed.jsonl`, 'utf8');
    expect(ledger).not.toContain(route.projectToken);
    expect(ledger.trim().split('\n')).toHaveLength(4);
    transport.mockClear();
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 0, skipped: 4 });
    expect(transport).not.toHaveBeenCalled();
    expect(await readFile(spoolPath)).toEqual(before);
  });

  it('does no I/O or capture before explicit route opt-in', async () => {
    expect(await replayQueueSpool({ ...options, spoolPath: '/missing/spool', route: undefined }))
      .toMatchObject({ status: 'disabled', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
    await expect(readFile(`${spoolPath}.replayed.jsonl`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an absent or empty spool as complete', async () => {
    expect(await replayQueueSpool({ ...options, spoolPath: join(dir, 'missing') })).toMatchObject({ status: 'complete' });
    await writeFile(spoolPath, '');
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([401, 404, 429, 500, 503])('checkpoints only acknowledged captures when HTTP %s interrupts replay', async status => {
    transport.mockResolvedValueOnce(success()).mockResolvedValueOnce(new Response('', { status }));
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'route-unavailable', sent: 1 });
    const firstAttempt = transport.mock.calls[1][1]!.body;
    transport.mockClear();
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 2, skipped: 2 });
    expect(transport.mock.calls[0][1]!.body).toBe(firstAttempt);
  });

  it.each(['{"status":0}', '{"status":1,"quota_limited":["events"]}', '{}', 'invalid json'])(
    'retains unacknowledged events after a misleading 200 response (%s)', async reply => {
      transport.mockResolvedValueOnce(new Response(reply));
      expect(await replayQueueSpool(options)).toMatchObject({ status: 'route-unavailable', sent: 0 });
      expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 3 });
    });

  it('uses the same remote dedup tuple after a lost response, without leaking errors', async () => {
    transport.mockRejectedValueOnce(new Error(route.projectToken));
    const result = await replayQueueSpool(options);
    expect(result).toMatchObject({ status: 'route-unavailable', sent: 0 });
    expect(JSON.stringify(result)).not.toContain(route.projectToken);
    const firstAttempt = transport.mock.calls[0][1]!.body;
    transport.mockClear();
    await replayQueueSpool(options);
    expect(transport.mock.calls[0][1]!.body).toBe(firstAttempt);
  });

  it('aborts a stalled capture and retains it for retry', async () => {
    transport.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    expect(await replayQueueSpool({ ...options, timeoutMs: 10 })).toMatchObject({ status: 'route-unavailable', sent: 0 });
    expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 3 });
  });

  it('keeps the timeout active while reading the acknowledgment body', async () => {
    transport.mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(new Error('body stalled')), { once: true });
      },
    })));
    expect(await replayQueueSpool({ ...options, timeoutMs: 10 })).toMatchObject({ status: 'route-unavailable', sent: 0 });
    expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 3 });
  });

  it('defers an incomplete tail and captures concurrently appended rows on the next call', async () => {
    const row = { eventId: 'hop-004', jobId: 'job-001', at: '2026-10-26T10:00:03.000Z', station: 'DONE', kind: 'arrival' };
    await appendFile(spoolPath, JSON.stringify(row).slice(0, -1));
    transport.mockImplementationOnce(async () => { await appendFile(spoolPath, '}\n'); return success(); });
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'partial', sent: 3, deferred: 1 });
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 1, deferred: 0 });
  });

  it('bounds each invocation and resumes remaining unique events', async () => {
    expect(await replayQueueSpool({ ...options, maxEvents: 1 })).toMatchObject({ status: 'partial', sent: 1 });
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 2, skipped: 2 });
  });

  it.each(['{\n', '{}\n', 'null\n'])('validates every complete row before sending any (%s)', async line => {
    await appendFile(spoolPath, line);
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'invalid-spool', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects conflicting event ids before any capture', async () => {
    const rows = (await readFile(spoolPath, 'utf8')).trim().split('\n');
    await appendFile(spoolPath, rows[0].replace('READY', 'DONE') + '\n');
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'invalid-spool', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses changed acknowledged events and corrupt receipts', async () => {
    await replayQueueSpool(options);
    transport.mockClear();
    const content = await readFile(spoolPath, 'utf8');
    await writeFile(spoolPath, content.replaceAll('READY', 'DONE'));
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'invalid-checkpoint', sent: 0 });
    await writeFile(spoolPath, content);
    await appendFile(`${spoolPath}.replayed.jsonl`, '{}\n');
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'invalid-checkpoint', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('recovers a torn last receipt after capture, using the identical remote event on retry', async () => {
    transport.mockImplementationOnce(async () => {
      // Simulate capture accepted remotely, then interruption during receipt writing.
      await appendFile(`${spoolPath}.replayed.jsonl`, '{"id":"unfinished');
      throw new Error('capture response lost');
    });
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'route-unavailable', sent: 0 });
    const body = transport.mock.calls[0][1]!.body;
    transport.mockClear();
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 3 });
    expect(transport.mock.calls[0][1]!.body).toBe(body);
    const ledger = await readFile(`${spoolPath}.replayed.jsonl`, 'utf8');
    expect(ledger).not.toContain('unfinished');
    expect(ledger.trim().split('\n')).toHaveLength(4);
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 0 });
  });

  it('recovers an interrupted initial header but refuses unrelated checkpoint bytes', async () => {
    transport.mockResolvedValueOnce(new Response('', { status: 503 }));
    await replayQueueSpool(options);
    const header = await readFile(`${spoolPath}.replayed.jsonl`, 'utf8');
    await writeFile(`${spoolPath}.replayed.jsonl`, header.slice(0, -5));
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 3 });
    await writeFile(`${spoolPath}.replayed.jsonl`, 'unrelated-checkpoint');
    transport.mockClear();
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'invalid-checkpoint', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds acknowledgment bodies without advancing the checkpoint', async () => {
    let canceled = false;
    transport.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(4_097))); },
      cancel() { canceled = true; },
    })));
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'route-unavailable', sent: 0 });
    expect(canceled).toBe(true);
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 3 });
  });

  it('preserves UUID event ids for deduplication with live capture', async () => {
    const uuid = 'f837507c-cb67-4059-9b58-449760ffb08d';
    await writeFile(spoolPath, JSON.stringify({ eventId: uuid, jobId: 'job-1', at: '2026-10-26T10:00:00Z', station: 'READY', kind: 'start' }) + '\n');
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'complete', sent: 1 });
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string).uuid).toBe(uuid);
  });

  it.each([
    { id: '' }, { distinctId: '' }, { timestamp: 'invalid' }, { properties: { nested: { private: 'excluded' } } },
    { properties: { nan: NaN } }, { properties: { infinity: Infinity } }, { properties: [] },
  ])('rejects invalid decoded events before capture %#', async override => {
    expect(await replayQueueSpool({ ...options, decode: row => ({ ...decode(row), ...override }) as QueueReplayEvent }))
      .toMatchObject({ status: 'invalid-spool', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a checkpoint with broad POSIX permissions', async () => {
    await replayQueueSpool(options);
    transport.mockClear();
    await chmod(`${spoolPath}.replayed.jsonl`, 0o666);
    if (process.platform !== 'win32') {
      expect(await replayQueueSpool(options)).toMatchObject({ status: 'storage-unavailable', sent: 0 });
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('refuses reusing receipts against another destination', async () => {
    await replayQueueSpool(options);
    transport.mockClear();
    expect(await replayQueueSpool({ ...options, route: { ...route, projectToken: 'other-fixture-token' } }))
      .toMatchObject({ status: 'invalid-checkpoint', sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('serializes concurrent replay calls with the existing local store lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    transport.mockImplementationOnce(async () => { entered(); await gate; return success(); });
    const first = replayQueueSpool(options);
    await started;
    try { expect(await replayQueueSpool(options)).toMatchObject({ status: 'busy', sent: 0 }); }
    finally { release(); }
    expect(await first).toMatchObject({ status: 'complete', sent: 3 });
  });

  it('refuses a symlink checkpoint without changing the target', async () => {
    const target = join(dir, 'unrelated');
    await writeFile(target, 'preserve me');
    await symlink(target, `${spoolPath}.replayed.jsonl`);
    expect(await replayQueueSpool(options)).toMatchObject({ status: 'storage-unavailable', sent: 0 });
    expect(await readFile(target, 'utf8')).toBe('preserve me');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['http://posthog.invalid/capture', ['https://user', 'password@posthog.invalid/capture'].join(':'),
    'https://posthog.invalid/capture?token=example', 'garbage'])('refuses unsafe route %s', async endpoint => {
      expect(await replayQueueSpool({ ...options, route: { ...route, endpoint } })).toMatchObject({ status: 'invalid-route' });
      expect(transport).not.toHaveBeenCalled();
    });
});
