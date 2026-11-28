import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup(now = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-body-kind-result-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'worker-a', priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

async function invalid(options: BusInboxOptions, args: string[]): Promise<void> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(2);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
}

function seed(options: BusInboxOptions) {
  post(options, 'note-1', { kind: 'note', text: 'a note' });
  post(options, 'ctx-1', { kind: 'context', text: 'some context' });
  post(options, 'result-failed', { kind: 'work.result', outcome: 'failed', jobId: 'RQ-9', text: 'build failed' });
  post(options, 'result-complete', { kind: 'work.result', outcome: 'complete', jobId: 'RQ-9', text: 'build passed' });
  post(options, 'result-no-outcome', { kind: 'work.result', jobId: 'RQ-9', text: 'no outcome field' });
  post(options, 'release-1', { kind: 'work.release', outcome: 'released', claimKey: 'repo:x', token: 't' });
  post(options, 'status-1', { kind: 'work.status', jobId: 'RQ-9', status: 'done' });
  post(options, 'task-1', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, text: 'typed task' }, { to: 'fleet.deploy' });
  post(options, 'outcome-only', { outcome: 'failed', text: 'kindless outcome field' });
  post(options, 'plain-1', { text: 'no discriminator at all' });
}

it('keeps only envelopes whose body carries the exact --body-kind discriminator', async () => {
  const { options } = setup();
  seed(options);

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['note-1']);
  expect(await read(options, ['--body-kind', 'context'])).toEqual(['ctx-1']);
  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['result-failed', 'result-complete', 'result-no-outcome']);
  expect(await read(options, ['--body-kind', 'work.release'])).toEqual(['release-1']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['status-1']);
  // A protocol-v1 body falls back to protocol.kind; a kindless body never matches.
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['task-1']);
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'missing'])).toEqual([]);
});

it('keeps only work.result bodies whose own outcome equals --result', async () => {
  const { options } = setup();
  seed(options);

  expect(await read(options, ['--result', 'failed'])).toEqual(['result-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['result-complete']);
  // The match scopes to kind 'work.result': a work.release body's own
  // released/completed outcome, a kindless outcome field and a work.result
  // carrying no outcome all name no provable result outcome.
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('composes --body-kind and --result with the other read filters', async () => {
  const { options } = setup();
  seed(options);

  expect(await read(options, ['--body-kind', 'work.result', '--result', 'failed'])).toEqual(['result-failed']);
  // A note carries no outcome, so the conjunctive pair is an honest empty list.
  expect(await read(options, ['--body-kind', 'note', '--result', 'failed'])).toEqual([]);
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-9'])).toEqual(['result-failed']);
  expect(await read(options, ['--result', 'failed', '--from', 'agent:atlas'])).toEqual(['result-failed']);
  expect(await read(options, ['--result', 'failed', '--to', 'worker-a'])).toEqual(['result-failed']);
});

it('rejects invalid --body-kind and --result values with exit 2 before reading', async () => {
  const { options } = setup();
  seed(options);

  for (const kind of ['has space', '', 'x'.repeat(129), 'line\nbreak']) {
    await invalid(options, ['--body-kind', kind]);
  }
  for (const result of ['maybe', '', 'FAILED', 'Complete', 'released', 'x'.repeat(129)]) {
    await invalid(options, ['--result', result]);
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--result', 'maybe', '--max-pages', '1'], options)).toBe(2);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
});

it('watch applies the same --body-kind and --result filters', async () => {
  const { options } = setup();
  seed(options);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  expect(await cmdCommsBus(['watch', '--after', '0', '--body-kind', 'work.result', '--result', 'failed',
    '--max-pages', '1', '--interval-ms', '100'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.status).toBe('ok');
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['result-failed']);
});

it('binds --body-kind and --result into the checkpoint filter identity', async () => {
  const { dir, options } = setup();
  seed(options);
  const checkpoint = join(dir, 'checkpoint.json');
  const lines: string[] = [];

  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options,
    { emit: (json: string) => { lines.push(json); } })).toBe(0);
  const state = JSON.parse(lines.at(-1)!);
  expect(state.status).toBe('ok');
  const stored = JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };
  expect(JSON.parse(stored.filters)).toEqual({ result: 'failed' });
});
