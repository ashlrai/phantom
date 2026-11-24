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
  const dir = mkdtempSync(join(tmpdir(), 'bus-channel-filter-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, to: string, body: unknown = { kind: 'note', text: id },
  extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to, priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only envelopes addressed to group:<channel>:* under every topic', async () => {
  const { options } = setup();
  post(options, 'eng-general', 'group:eng:general');
  post(options, 'eng-alerts', 'group:eng:alerts');
  post(options, 'ops-general', 'group:ops:general');
  post(options, 'direct', 'worker-a');
  post(options, 'eng-bare', 'group:eng');
  post(options, 'engx-room', 'group:engx:general');

  expect(await read(options, ['--channel', 'eng'])).toEqual(['eng-general', 'eng-alerts']);
  expect(await read(options, ['--channel', 'ops'])).toEqual(['ops-general']);
  expect(await read(options, ['--channel', 'missing'])).toEqual([]);
});

it('composes --channel with the other read filters', async () => {
  const { options } = setup();
  post(options, 'eng-p0', 'group:eng:general', { kind: 'note', text: 'urgent deploy' }, { priority: 'P0' });
  post(options, 'eng-p2', 'group:eng:alerts');
  post(options, 'ops-p0', 'group:ops:general', { kind: 'note', text: 'urgent deploy' }, { priority: 'P0' });

  expect(await read(options, ['--channel', 'eng', '--priority', 'P0'])).toEqual(['eng-p0']);
  expect(await read(options, ['--channel', 'eng', '--contains', 'eng-p2'])).toEqual(['eng-p2']);
  expect(await read(options, ['--channel', 'eng', '--to', 'group:eng:alerts'])).toEqual(['eng-p2']);
});

it('rejects an invalid --channel before reading the store', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const channel of ['Eng', 'has space', 'x'.repeat(33), '-lead', 'group:eng', 'eng:general', '']) {
    expect(await cmdCommsBus(['read', '--channel', channel], options)).toBe(2);
    expect(await cmdCommsBus(['watch', '--channel', channel, '--max-pages', '1'], options)).toBe(2);
  }
  expect(log.mock.calls.at(-1)?.[0]).toBe(JSON.stringify({ status: 'invalid' }));
});

it('binds --channel into the checkpoint filter identity', async () => {
  const { dir, options } = setup();
  const checkpoint = join(dir, 'checkpoint.json');
  post(options, 'eng-1', 'group:eng:general');
  post(options, 'ops-1', 'group:ops:general');
  const emitted: string[] = [];
  const deps = { emit: (json: string) => { emitted.push(json); } };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--channel', 'eng'], options, deps)).toBe(0);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8')).scanCursor).toBe(2);
  expect(emitted.at(-1)).toContain('eng-1');
  expect(emitted.at(-1)).not.toContain('ops-1');

  // A checkpoint saved under one room refuses to resume under another or none.
  for (const args of [[], ['--channel', 'ops']]) {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, ...args], options, deps)).toBe(1);
    expect(String(error.mock.calls.at(-1))).toContain('filter mismatch');
  }
  // The same room resumes cleanly.
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--channel', 'eng'], options, deps)).toBe(0);
});
