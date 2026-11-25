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
  const dir = mkdtempSync(join(tmpdir(), 'bus-result-filter-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown = { kind: 'note', text: id },
  extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'worker-a', priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

const resultBody = (outcome?: string, jobId = 'RQ-1') => ({
  kind: 'work.result', jobId, claimKey: 'pr:1',
  queueId: 'peer-work-00000000000000000000000000000000',
  receiptId: 'pw-00000000000000000000000000000000',
  ...(outcome === undefined ? {} : { outcome }),
});

it('keeps only work.result bodies whose own outcome strictly equals the code', async () => {
  const { options } = setup();
  post(options, 'resv', resultBody('reserved'));
  post(options, 'adm', resultBody('admitted'));
  post(options, 'comp', resultBody('complete'));
  post(options, 'fail', resultBody('failed'));
  post(options, 'no-outcome', resultBody());
  post(options, 'release', { kind: 'work.release', outcome: 'released' });
  post(options, 'other-kind', { kind: 'note', outcome: 'complete', text: 'borrowing the word' });
  post(options, 'kindless', { outcome: 'complete' });

  expect(await read(options, ['--result', 'reserved'])).toEqual(['resv']);
  expect(await read(options, ['--result', 'admitted'])).toEqual(['adm']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['comp']);
  expect(await read(options, ['--result', 'failed'])).toEqual(['fail']);
});

it('composes --result with the other read filters', async () => {
  const { options } = setup();
  post(options, 'comp-p0', resultBody('complete'), { priority: 'P0' });
  post(options, 'comp-p2', resultBody('complete'));
  post(options, 'fail-p0', resultBody('failed'), { priority: 'P0' });
  post(options, 'comp-other-job', resultBody('complete', 'RQ-9'));

  expect(await read(options, ['--result', 'complete', '--priority', 'P0'])).toEqual(['comp-p0']);
  expect(await read(options, ['--result', 'complete', '--job', 'RQ-1'])).toEqual(['comp-p0', 'comp-p2']);
  expect(await read(options, ['--result', 'complete', '--job', 'RQ-9'])).toEqual(['comp-other-job']);
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-1'])).toEqual(['fail-p0']);
});

it('applies --result on watch pages and still advances the cursor past filtered rows', async () => {
  const { options } = setup();
  post(options, 'comp', resultBody('complete'));
  post(options, 'fail', resultBody('failed'));
  post(options, 'note', { kind: 'note', text: 'plain' });
  const emitted: string[] = [];
  const deps = { emit: (json: string) => { emitted.push(json); } };

  expect(await cmdCommsBus(['watch', '--result', 'failed', '--max-pages', '1'], options, deps)).toBe(0);
  expect(emitted).toHaveLength(1);
  const page = JSON.parse(emitted[0]!);
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['fail']);
  expect(page.nextCursor).toBe(3);
});

it('rejects an invalid --result before reading the store', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const result of ['done', 'Complete', 'COMPLETE', 'released', 'completed', 'two words', '']) {
    expect(await cmdCommsBus(['read', '--result', result], options)).toBe(2);
    expect(await cmdCommsBus(['watch', '--result', result, '--max-pages', '1'], options)).toBe(2);
  }
  expect(log.mock.calls.at(-1)?.[0]).toBe(JSON.stringify({ status: 'invalid' }));
});

it('binds --result into the checkpoint filter identity', async () => {
  const { dir, options } = setup();
  const checkpoint = join(dir, 'checkpoint.json');
  post(options, 'comp', resultBody('complete'));
  post(options, 'fail', resultBody('failed'));
  const emitted: string[] = [];
  const deps = { emit: (json: string) => { emitted.push(json); } };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options, deps)).toBe(0);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8')).scanCursor).toBe(2);
  const page = JSON.parse(emitted.at(-1)!);
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['fail']);

  // A checkpoint saved under one outcome refuses to resume under another or none.
  for (const args of [[], ['--result', 'complete']]) {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, ...args], options, deps)).toBe(1);
    expect(String(error.mock.calls.at(-1))).toContain('filter mismatch');
  }
  // The same outcome resumes cleanly.
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options, deps)).toBe(0);
});
