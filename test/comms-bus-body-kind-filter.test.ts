import { mkdtempSync, rmSync } from 'node:fs';
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

function post(options: BusInboxOptions, id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only envelopes whose body reports the exact kind discriminator', async () => {
  const { options } = setup();
  post(options, 'k-note', { kind: 'note', text: 'a note' });
  post(options, 'k-context', { kind: 'context', text: 'some context' });
  post(options, 'k-post', { kind: 'work.post', jobId: 'RQ-1', title: 't', repo: 'o/r', claimKeys: ['queue:RQ-1'] });
  post(options, 'k-status', { kind: 'work.status', jobId: 'RQ-1', status: 'running' });
  post(options, 'k-wake', { kind: 'wake', jobId: 'RQ-1', reason: 'r' });
  post(options, 'k-kindless', { inReplyTo: 'k-note', text: 'plain reply' });
  post(options, 'k-proto', { protocol: { version: 1, kind: 'task', topic: 'fleet.x' } }, { to: 'fleet.x' });

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['k-note']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['k-post']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['k-status']);
  expect(await read(options, ['--body-kind', 'wake'])).toEqual(['k-wake']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['k-proto']);
  // A kindless body reports null and never matches any --body-kind value.
  expect(await read(options, ['--body-kind', 'note', '--id', 'k-kindless'])).toEqual([]);
});

it('matches exactly and case-sensitively; unknown printable kinds are an honest empty match', async () => {
  const { options } = setup();
  post(options, 'e-note', { kind: 'note', text: 'a note' });
  post(options, 'e-NOTE', { kind: 'NOTE', text: 'caps' });

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['e-note']);
  expect(await read(options, ['--body-kind', 'NOTE'])).toEqual(['e-NOTE']);
  expect(await read(options, ['--body-kind', 'work.result'])).toEqual([]);
});

it('applies --body-kind to watch pages and composes with other filters', async () => {
  const { options } = setup();
  post(options, 'w-note', { kind: 'note', text: 'watch note' });
  post(options, 'w-post', { kind: 'work.post', jobId: 'RQ-9', title: 't', repo: 'o/r', claimKeys: ['queue:RQ-9'] });

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'note', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-note']);

  expect(await read(options, ['--body-kind', 'work.post', '--job', 'RQ-9'])).toEqual(['w-post']);
  expect(await read(options, ['--body-kind', 'work.post', '--job', 'RQ-1'])).toEqual([]);
});

it('rejects invalid or duplicate --body-kind values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn((await import('../src/core/fleet/bus-inbox.js')), 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', ''], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind', 'note', '--body-kind', 'context'], ['--body-kind', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('advertises --body-kind in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--body-kind <kind>');
});
