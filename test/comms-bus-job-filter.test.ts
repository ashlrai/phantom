import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import * as inbox from '../src/core/fleet/bus-inbox.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bus-job-filter-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => 100 } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 60_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only envelopes naming the job across every citation shape', async () => {
  const { options } = setup();
  const rows: Array<[string, unknown]> = [
    ['jb-post', { kind: 'work.post', jobId: 'RQ-JOB-A', title: 't', repo: 'o/n', claimKeys: [] }],
    // A different job's citation never matches.
    ['jb-other-job', { kind: 'work.status', jobId: 'RQ-JOB-B', status: 'running' }],
    ['jb-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    ['jb-result', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'complete' }],
    ['jb-wake', { kind: 'wake', target: 'agent:nova', reason: 'r', jobId: 'RQ-JOB-A' }],
    // A wake citing no job names nothing.
    ['jb-wake-bare', { kind: 'wake', target: 'agent:nova', reason: 'no job cited' }],
    ['jb-handoff', { kind: 'worker-handoff', taskId: 'RQ-JOB-A', prompt: 'take it' }],
    ['jb-note', { kind: 'note', text: 'hi', thread: 'job:RQ-JOB-A' }],
    ['jb-context', { kind: 'context', text: 'ctx', thread: 'job:RQ-JOB-A' }],
    // A bare <id> thread is a different conversation bucket, not job:<id>.
    ['jb-bare-thread', { kind: 'note', text: 'x', thread: 'RQ-JOB-A' }],
    // work.claim jobId is an operation parameter, not a citation.
    ['jb-claim', { kind: 'work.claim', op: 'acquire', claimKey: 'repo:o/n', owner: 'a', leaseMs: 1000, jobId: 'RQ-JOB-A' }],
    // A handoff-shaped body handoff-receive would refuse cites no job.
    ['jb-handoff-bad', { kind: 'worker-handoff', taskId: 'RQ-JOB-A' }],
    ['jb-plain', { text: 'no kind' }],
    ['jb-string', 'just text'],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--job', 'RQ-JOB-A'])).toEqual(
    ['jb-post', 'jb-status', 'jb-result', 'jb-wake', 'jb-handoff', 'jb-note', 'jb-context']);
  // A job nothing names reads empty, and the unfiltered page still sees all.
  expect(await read(options, ['--job', 'RQ-ABSENT'])).toEqual([]);
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('composes --job with the address, priority and thread filters', async () => {
  const { options } = setup();
  post(options, 'jc-a1', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' });
  post(options, 'jc-a2', { kind: 'note', text: 'n', thread: 'job:RQ-JOB-A' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'jc-b1', { kind: 'work.status', jobId: 'RQ-JOB-B', status: 'running' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'jc-a3', { kind: 'note', text: 'other thread', thread: 'other' });

  expect(await read(options, ['--job', 'RQ-JOB-A', '--from', 'agent:orion'])).toEqual(['jc-a2']);
  expect(await read(options, ['--job', 'RQ-JOB-A', '--priority', 'P0'])).toEqual(['jc-a2']);
  expect(await read(options, ['--job', 'RQ-JOB-A', '--to', 'leaders'])).toEqual(['jc-a1', 'jc-a2']);
  expect(await read(options, ['--job', 'RQ-JOB-A', '--thread', 'job:RQ-JOB-A'])).toEqual(['jc-a2']);
  expect(await read(options, ['--job', 'RQ-JOB-A', '--kind', 'task'])).toEqual([]);
});

it('applies --job to watch pages', async () => {
  const { options } = setup();
  post(options, 'jw-a', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'queued' });
  post(options, 'jw-b', { kind: 'work.status', jobId: 'RQ-JOB-B', status: 'queued' });
  post(options, 'jw-note', { kind: 'note', text: 'n', thread: 'job:RQ-JOB-A' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--job', 'RQ-JOB-A', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['jw-a', 'jw-note']);
});

it('rejects invalid or duplicate --job values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--job'], ['--job', 'has space'], ['--job', 'x'.repeat(129)],
      ['--job', 'RQ-A', '--job', 'RQ-B'], ['--job=-inline'], ['--job', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--job', 'RQ-A'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --job into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'jc-a', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'queued' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--job', 'RQ-JOB-A'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ job: 'RQ-JOB-A' }));

  // A different job or a dropped --job is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--job', 'RQ-JOB-B'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --job in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--job <id>');
});
