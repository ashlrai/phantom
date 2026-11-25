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

function setup(now = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-kind-result-filter-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only envelopes whose body carries that exact kind discriminator', async () => {
  const { options } = setup();
  post(options, 'k-note', { kind: 'note', text: 'a note' });
  post(options, 'k-work', { kind: 'work.result', jobId: 'RQ-K-1', claimKey: 'repo:o/n', queueId: 'q', receiptId: 'r', outcome: 'failed' });
  post(options, 'k-proto', {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'artifact:run-9/plan.md' },
    text: 'roll the canary',
  }, { to: 'fleet.deploy' });
  post(options, 'k-type', { type: 'forum.mention', text: 'you were mentioned' });
  post(options, 'k-schema', { schema: 'guardian-drain.v1', text: 'drain' });
  post(options, 'k-kindless', { text: 'no discriminator here' });
  post(options, 'k-upper', { kind: 'NOTE', text: 'uppercase kind' });

  // The v2 kind field, the protocol.kind fallback and the type/schema
  // discriminators all match their own spelling exactly.
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['k-note']);
  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['k-work']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['k-proto']);
  expect(await read(options, ['--body-kind', 'forum.mention'])).toEqual(['k-type']);
  expect(await read(options, ['--body-kind', 'guardian-drain.v1'])).toEqual(['k-schema']);
  // Exact and case-sensitive: a kindless body never matches, and an
  // unrecognized but printable value is an honest empty page.
  expect(await read(options, ['--body-kind', 'NOTE'])).toEqual(['k-upper']);
  expect(await read(options, ['--body-kind', 'bogus'])).toEqual([]);
  expect(await read(options, [])).toEqual(['k-note', 'k-work', 'k-proto', 'k-type', 'k-schema', 'k-kindless', 'k-upper']);
});

it('keeps only work.result bodies whose own outcome strictly equals the code', async () => {
  const { options } = setup();
  const result = (outcome: string) =>
    ({ kind: 'work.result', jobId: 'RQ-R-1', claimKey: 'repo:o/n', queueId: 'q', receiptId: 'r', outcome });
  post(options, 'r-complete', result('complete'));
  post(options, 'r-failed', result('failed'));
  post(options, 'r-reserved', result('reserved'));
  post(options, 'r-admitted', result('admitted'));
  // A work.result carrying no outcome, one carrying an outcome outside the
  // vocabulary, a work.release body's own released/completed outcome (a
  // different vocabulary) and a non-result body never match.
  post(options, 'r-nooutcome', { kind: 'work.result', jobId: 'RQ-R-1', claimKey: 'repo:o/n' });
  post(options, 'r-bogus', result('bogus'));
  post(options, 'r-rel', { kind: 'work.release', claimKey: 'repo:o/n', token: 't', outcome: 'released' });
  post(options, 'r-note', { kind: 'note', text: 'plain note', outcome: 'failed' });

  expect(await read(options, ['--result', 'complete'])).toEqual(['r-complete']);
  expect(await read(options, ['--result', 'failed'])).toEqual(['r-failed']);
  expect(await read(options, ['--result', 'reserved'])).toEqual(['r-reserved']);
  expect(await read(options, ['--result', 'admitted'])).toEqual(['r-admitted']);
});

it('composes --body-kind and --result with the other read filters', async () => {
  const { options } = setup();
  const result = (outcome: string, jobId = 'RQ-C-1') =>
    ({ kind: 'work.result', jobId, claimKey: 'repo:o/n', queueId: 'q', receiptId: 'r', outcome });
  post(options, 'x-fail', result('failed'), { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-complete', result('complete'), { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-other-job', result('failed', 'RQ-C-2'), { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-from', result('failed'), { from: 'agent:atlas', priority: 'P0' });
  post(options, 'x-miss-priority', result('failed'), { from: 'agent:orion', priority: 'P3' });
  post(options, 'x-note', { kind: 'note', text: 'alpha target' }, { from: 'agent:orion', priority: 'P0' });

  expect(await read(options, ['--result', 'failed', '--from', 'agent:orion'])).toEqual(['x-fail', 'x-other-job', 'x-miss-priority']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual(['x-fail', 'x-other-job', 'x-miss-from']);
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-C-1', '--from', 'agent:orion'])).toEqual(['x-fail', 'x-miss-priority']);
  expect(await read(options, ['--body-kind', 'work.result', '--result', 'failed'])).toEqual(['x-fail', 'x-other-job', 'x-miss-from', 'x-miss-priority']);
  expect(await read(options, ['--body-kind', 'note', '--contains', 'alpha'])).toEqual(['x-note']);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'w-fail', { kind: 'work.result', jobId: 'RQ-W-1', claimKey: 'repo:o/n', queueId: 'q', receiptId: 'r', outcome: 'failed' });
  post(options, 'w-complete', { kind: 'work.result', jobId: 'RQ-W-1', claimKey: 'repo:o/n', queueId: 'q', receiptId: 'r', outcome: 'complete' });
  post(options, 'w-note', { kind: 'note', text: 'watch me' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-fail']);

  vi.restoreAllMocks();
  const log2 = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'note', '--max-pages', '1'], options)).toBe(0);
  const page2 = JSON.parse(String(log2.mock.calls.at(-1)?.[0]));
  expect(page2.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-note']);
});

it('rejects invalid or duplicate --body-kind/--result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [
      ['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', ''],
      ['--body-kind', 'x'.repeat(129)], ['--body-kind', 'note', '--body-kind', 'task'],
      ['--body-kind', '--to'], ['--body-kind=-inline'],
      ['--result'], ['--result', 'bogus'], ['--result', 'released'], ['--result', 'FAILED'],
      ['--result', ''], ['--result', 'failed', '--result', 'complete'], ['--result', '--to'],
      ['--result=-inline'],
    ]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'unused', '--result', 'failed'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind and --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'k-a', { kind: 'note', text: 'alpha one' });
  post(options, 'k-b', { kind: 'work.result', jobId: 'RQ-K-2', claimKey: 'repo:o/n', queueId: 'q', receiptId: 'r', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'note', '--result', 'failed'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'note', result: 'failed' }));

  // A different filter value or a dropped filter is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'failed'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'note'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --body-kind and --result in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls.at(-1)?.[0]);
  expect(help).toContain('--body-kind <kind>');
  expect(help).toContain('--result <reserved|admitted|complete|failed>');
});
