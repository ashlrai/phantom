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

it('keeps only envelopes whose body carries the exact kind discriminator', async () => {
  const { options } = setup();
  post(options, 'k-note', { kind: 'note', text: 'hi', thread: 't-1' });
  post(options, 'k-result', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' });
  post(options, 'k-proto', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } }, { to: 'fleet.deploy' });
  post(options, 'k-typed', { type: 'handoff', text: 'typed' });
  post(options, 'k-kindless', { text: 'no discriminator' });

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['k-note']);
  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['k-result']);
  // The discriminator covers the protocol-v1 protocol.kind fallback too.
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['k-proto']);
  expect(await read(options, ['--body-kind', 'handoff'])).toEqual(['k-typed']);
  // A body carrying no discriminator never matches, and the match is exact
  // and case-sensitive like every other own-field bus filter.
  expect(await read(options, ['--body-kind', 'text'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'missing'])).toEqual([]);
});

it('keeps --body-kind distinct from --kind, the protocol-v1 kind only', async () => {
  const { options } = setup();
  post(options, 'd-note', { kind: 'note', text: 'hi' });
  post(options, 'd-proto', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } }, { to: 'fleet.deploy' });
  post(options, 'd-status', { kind: 'work.status', jobId: 'RQ-2', status: 'running' });

  // --kind narrows only protocol-v1 bodies; --body-kind reads every
  // discriminator, so the v2 kinds it cannot see still match --body-kind.
  expect(await read(options, ['--kind', 'task'])).toEqual(['d-proto']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['d-proto']);
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['d-note']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['d-status']);
  // A protocol kind no body carries is an honest empty page, and the v2
  // kinds --kind cannot name never leak into its match.
  expect(await read(options, ['--kind', 'review'])).toEqual([]);
  // The two filters compose conjunctively.
  expect(await read(options, ['--kind', 'task', '--body-kind', 'task'])).toEqual(['d-proto']);
  expect(await read(options, ['--kind', 'task', '--body-kind', 'note'])).toEqual([]);
});

it('keeps only work.result bodies reporting the requested outcome', async () => {
  const { options } = setup();
  post(options, 'r-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' });
  post(options, 'r-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'r-reserved', { kind: 'work.result', jobId: 'RQ-2', outcome: 'reserved' });
  // A work.release outcome is a different vocabulary: even spelled 'failed',
  // its kind is not work.result and it never matches --result.
  post(options, 'r-release', { kind: 'work.release', claimKey: 'queue:RQ-1', outcome: 'failed' });
  post(options, 'r-no-outcome', { kind: 'work.result', jobId: 'RQ-3' });
  post(options, 'r-kindless', { outcome: 'failed', text: 'no kind' });
  post(options, 'r-note', { kind: 'note', text: 'done', outcome: 'failed' });

  expect(await read(options, ['--result', 'complete'])).toEqual(['r-complete']);
  expect(await read(options, ['--result', 'failed'])).toEqual(['r-failed']);
  expect(await read(options, ['--result', 'reserved'])).toEqual(['r-reserved']);
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('composes --body-kind and --result with the other read filters', async () => {
  const { options } = setup();
  post(options, 'x-hit', { kind: 'work.result', jobId: 'RQ-9', outcome: 'failed' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-outcome', { kind: 'work.result', jobId: 'RQ-9', outcome: 'complete' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-kind', { kind: 'work.status', jobId: 'RQ-9', status: 'running' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-job', { kind: 'work.result', jobId: 'RQ-8', outcome: 'failed' }, { from: 'agent:orion', priority: 'P0' });

  // --job cites the same jobId on every feed body; --result keeps only the
  // work.result receipt reporting the outcome, never the work.status sibling.
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-9'])).toEqual(['x-hit']);
  expect(await read(options, ['--body-kind', 'work.result', '--result', 'failed', '--job', 'RQ-9', '--from', 'agent:orion', '--priority', 'P0'])).toEqual(['x-hit']);
  expect(await read(options, ['--body-kind', 'work.result', '--contains', 'RQ-9'])).toEqual(['x-hit', 'x-miss-outcome']);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'w-note', { kind: 'note', text: 'hi' });
  post(options, 'w-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'w-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.result', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-failed']);
});

it('rejects invalid or duplicate --body-kind and --result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', ''], ['--body-kind', 'two words'],
      ['--body-kind', 'x'.repeat(129)], ['--body-kind', 'note', '--body-kind', 'context'],
      ['--result'], ['--result', ''], ['--result', 'bogus'], ['--result', 'P0'], ['--result', 'COMPLETE'],
      ['--result', 'complete', '--result', 'failed'], ['--result', '--to'], ['--body-kind', '--result']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--result', 'complete'])).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind and --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'k-a', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'failed'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.result', result: 'failed' }));

  // A different outcome, a dropped filter or a changed body-kind is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'complete'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options)).toBe(1);
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
