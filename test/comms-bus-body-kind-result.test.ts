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
  const dir = mkdtempSync(join(tmpdir(), 'bus-body-kind-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 3_600_000, body }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

function seed(options: BusInboxOptions): void {
  post(options, 'bk-note', { kind: 'note', thread: 't-1', text: 'a note' });
  post(options, 'bk-status', { kind: 'work.status', jobId: 'J-1', status: 'running' });
  post(options, 'bk-result-ok', { kind: 'work.result', jobId: 'J-1', claimKey: 'queue:q-1',
    queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'complete' });
  post(options, 'bk-result-bad', { kind: 'work.result', jobId: 'J-1', claimKey: 'queue:q-1',
    queueId: 'peer-work-cccccccccccccccccccccccccccccccc', receiptId: 'pw-dddddddddddddddddddddddddddddddd', outcome: 'failed' });
  post(options, 'bk-result-none', { kind: 'work.result', jobId: 'J-1' });
  post(options, 'bk-release', { kind: 'work.release', claimKey: 'queue:q-1', token: 'a'.repeat(64), outcome: 'released' });
  post(options, 'bk-protocol', { protocol: { version: 1, kind: 'task' }, payload: { text: 'v1' } });
  post(options, 'bk-kindless', { text: 'no discriminator' });
  post(options, 'bk-stray', { outcome: 'complete', text: 'stray outcome field' });
}

it('keeps only envelopes whose body carries the exact --body-kind discriminator', async () => {
  const { options } = setup();
  seed(options);

  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['bk-result-ok', 'bk-result-bad', 'bk-result-none']);
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['bk-status']);
  expect(await read(options, ['--body-kind', 'work.release'])).toEqual(['bk-release']);
  // The protocol-v1 fallback reads protocol.kind; the kindless body never matches.
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-protocol']);
  expect(await read(options, ['--body-kind', 'unrecognized'])).toEqual([]);
  expect(await read(options, [])).toEqual(['bk-note', 'bk-status', 'bk-result-ok', 'bk-result-bad', 'bk-result-none', 'bk-release', 'bk-protocol', 'bk-kindless', 'bk-stray']);
});

it('keeps only work.result bodies reporting the --result outcome', async () => {
  const { options } = setup();
  seed(options);

  expect(await read(options, ['--result', 'complete'])).toEqual(['bk-result-ok']);
  expect(await read(options, ['--result', 'failed'])).toEqual(['bk-result-bad']);
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('scopes --result to the work.result kind and composes with --body-kind', async () => {
  const { options } = setup();
  seed(options);

  // A kindless body carrying a stray `outcome` field is a different
  // vocabulary: it never satisfies a result-outcome match.
  expect(await read(options, ['--result', 'complete'])).toEqual(['bk-result-ok']);
  // A work.result carrying no outcome names no provable outcome.
  expect(await read(options, ['--body-kind', 'work.result', '--result', 'complete'])).toEqual(['bk-result-ok']);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  seed(options);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.result', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['bk-result-bad']);
});

it('rejects invalid --body-kind and --result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', '--to'],
      ['--result'], ['--result', 'bogus'], ['--result', 'COMPLETE'], ['--result', 'released'], ['--result', '--to'],
      ['--result', 'complete', '--result', 'failed']]) {
      expect(await cmdCommsBus([verb, ...args], options)).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'unused', '--result', 'complete'])).toBe(2);
});

it('binds --body-kind and --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  seed(options);
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'complete'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.result', result: 'complete' }));

  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    // A different --result, a dropped --body-kind and a dropped --result are
    // different filter sets: fail closed.
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'failed'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'complete'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result'], options)).toBe(1);
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
