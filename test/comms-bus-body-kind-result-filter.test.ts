import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { WORK_RESULT_OUTCOMES } from '../src/core/agents/bus-v2-schema.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup(now = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-kind-result-filter-')); roots.push(dir);
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

it('keeps only bodies carrying the exact --body-kind discriminator', async () => {
  const { options } = setup();
  post(options, 'note', { kind: 'note', text: 'hello' });
  post(options, 'context', { kind: 'context', text: 'refs', thread: 't-1' });
  post(options, 'post', { kind: 'work.post', jobId: 'RQ-1', title: 'do it' });
  post(options, 'handoff', { kind: 'worker-handoff', taskId: 'fleet-9', prompt: 'go' });
  post(options, 'proto', { protocol: { version: 1, kind: 'task' }, text: 'roll' });
  post(options, 'typed', { type: 'fleet.graph-observe.v1', detail: 'x' });
  post(options, 'kindless', { text: 'no discriminator' });
  post(options, 'kindless-outcome', { outcome: 'failed', text: 'stray field' });

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['note']);
  expect(await read(options, ['--body-kind', 'context'])).toEqual(['context']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['post']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['handoff']);
  // A bus-transport v1 protocol.kind is a discriminator too.
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['proto']);
  // The type/schema a kindless notice keys on.
  expect(await read(options, ['--body-kind', 'fleet.graph-observe.v1'])).toEqual(['typed']);
  // Exact and case-sensitive: a near-miss and an unknown value are honest empty pages.
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'nosuchkind'])).toEqual([]);
});

it('keeps only work.result bodies reporting the exact --result outcome', async () => {
  const { options } = setup();
  post(options, 'res-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'res-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' });
  post(options, 'res-none', { kind: 'work.result', jobId: 'RQ-2' });
  // A work.release body's released/completed outcome is a different vocabulary.
  post(options, 'release', { kind: 'work.release', claimKey: 'queue:RQ-1', outcome: 'completed' });
  // A stray outcome on another kind and a kindless body's outcome never match.
  post(options, 'note', { kind: 'note', text: 'done', outcome: 'failed' });
  post(options, 'kindless', { outcome: 'failed', text: 'no kind' });

  expect(await read(options, ['--result', 'failed'])).toEqual(['res-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['res-complete']);
  // Every WORK_RESULT_OUTCOMES code is a valid filter; the ones no receipt
  // reports answer an honest empty page.
  for (const outcome of WORK_RESULT_OUTCOMES) {
    const ids = await read(options, ['--result', outcome]);
    expect(ids).toEqual(outcome === 'failed' ? ['res-failed'] : outcome === 'complete' ? ['res-complete'] : []);
  }
});

it('composes --body-kind and --result with the other read filters', async () => {
  const { options } = setup();
  post(options, 'a', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'b', { kind: 'work.result', jobId: 'RQ-2', outcome: 'failed' });
  post(options, 'c', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' });
  post(options, 'd', { kind: 'note', text: 'failed but not a result', outcome: 'failed' }, { priority: 'P0' });

  expect(await read(options, ['--result', 'failed', '--job', 'RQ-1'])).toEqual(['a']);
  expect(await read(options, ['--result', 'complete', '--body-kind', 'work.result'])).toEqual(['c']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'note', '--priority', 'P0'])).toEqual(['d']);
});

it('rejects invalid --body-kind and --result before reading the store', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.fn();
  for (const args of [
    ['--result', 'bogus'], ['--result', 'P0'], ['--result', 'COMPLETE'],
    ['--result', 'completed'], ['--result', 'released'], ['--result', ''],
    ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)], ['--body-kind', ''],
  ]) {
    expect(await cmdCommsBus(['read', ...args], options, { list: list as never })).toBe(2);
    expect(await cmdCommsBus(['watch', ...args, '--max-pages', '1'], options, { list: list as never })).toBe(2);
  }
  expect(list).not.toHaveBeenCalled();
  expect(log.mock.calls.every(call => call[0] === '{"status":"invalid"}')).toBe(true);
});

it('applies the filters on watch pages', async () => {
  const { options } = setup();
  post(options, 'res-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'note', { kind: 'note', text: 'unrelated' });
  const pages: Array<{ messages: Array<{ envelope: { id: string } }> }> = [];
  expect(await cmdCommsBus(['watch', '--result', 'failed', '--max-pages', '1', '--interval-ms', '100'], options, {
    emit: json => pages.push(JSON.parse(json)),
  })).toBe(0);
  expect(pages).toHaveLength(1);
  expect(pages[0]!.messages.map(row => row.envelope.id)).toEqual(['res-failed']);
});

it('binds --body-kind and --result into the checkpoint filter identity', async () => {
  const { dir, options } = setup();
  const checkpoint = join(dir, 'checkpoint.json');
  post(options, 'res-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'note', { kind: 'note', text: 'unrelated' });
  const emitted: string[] = [];
  const deps = { emit: (json: string) => { emitted.push(json); } };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options, deps)).toBe(0);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8')).scanCursor).toBe(2);
  expect(emitted.at(-1)).toContain('res-failed');
  expect(emitted.at(-1)).not.toContain('unrelated');

  // A checkpoint saved under one outcome refuses to resume under another or none.
  for (const args of [[], ['--result', 'complete'], ['--body-kind', 'note']]) {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, ...args], options, deps)).toBe(1);
    expect(String(error.mock.calls.at(-1))).toContain('filter mismatch');
  }
  // The same filters resume cleanly.
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options, deps)).toBe(0);
});
