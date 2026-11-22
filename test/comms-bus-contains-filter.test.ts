import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import * as inbox from '../src/core/fleet/bus-inbox.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { BUS_READ_CONTAINS_MAX } from '../src/core/agents/bus-unified.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup(now = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-contains-filter-')); roots.push(dir);
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

it('keeps only envelopes whose summary carries the needle, case-insensitive', async () => {
  const { options } = setup();
  post(options, 'c-note', { kind: 'note', text: 'Please review the RQ-ALPHA rollout' });
  post(options, 'c-other', { kind: 'note', text: 'Unrelated chatter about lunch' });
  post(options, 'c-status', { kind: 'work.status', jobId: 'RQ-BETA', status: 'running', detail: 'alpha gate holds' });
  post(options, 'c-reply', { inReplyTo: 'c-note', text: 'Alpha ack received' });

  expect(await read(options, ['--contains', 'alpha'])).toEqual(['c-note', 'c-status', 'c-reply']);
  expect(await read(options, ['--contains', 'ALPHA'])).toEqual(['c-note', 'c-status', 'c-reply']);
  expect(await read(options, ['--contains', 'lunch'])).toEqual(['c-other']);
  expect(await read(options, ['--contains', 'nothing-here'])).toEqual([]);
});

it('collapses whitespace on both sides so spaced phrases still match', async () => {
  const { options } = setup();
  post(options, 'c-multi', { kind: 'note', text: 'line one\n   line   two' });
  post(options, 'c-single', { kind: 'note', text: 'line one line two' });

  expect(await read(options, ['--contains', 'one   line'])).toEqual(['c-multi', 'c-single']);
  expect(await read(options, ['--contains', '  LINE ONE LINE TWO  '])).toEqual(['c-multi', 'c-single']);
});

it('matches the rendered summary, never secret-shaped body values', async () => {
  const { options } = setup();
  post(options, 'c-secret', { kind: 'note', text: 'deploy key sk-' + 'FAKE0123456789abcdef now' });
  post(options, 'c-plain', { kind: 'note', text: 'deploy window at noon' });

  // The secret-shaped value is scrubbed out of the summary: it cannot be found.
  expect(await read(options, ['--contains', 'sk-FAKE0123456789abcdef'])).toEqual([]);
  expect(await read(options, ['--contains', 'deploy'])).toEqual(['c-secret', 'c-plain']);
  expect(await read(options, ['--contains', 'now'])).toEqual(['c-secret']);
});

it('keeps protocol-v1 payloads opaque: kind, topic and payload_ref match, payload text does not', async () => {
  const { options } = setup();
  post(options, 'c-proto', {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'artifact:run-9/plan.md' },
    correlation_id: 'corr-1', payload: { text: 'needle-in-payload' },
  }, { to: 'fleet.deploy' });
  post(options, 'c-plain', { kind: 'note', text: 'needle-in-payload' });

  expect(await read(options, ['--contains', 'needle-in-payload'])).toEqual(['c-plain']);
  expect(await read(options, ['--contains', 'fleet.deploy'])).toEqual(['c-proto']);
  expect(await read(options, ['--contains', 'artifact:run-9/plan.md'])).toEqual(['c-proto']);
  expect(await read(options, ['--contains', 'corr-1'])).toEqual([]);
});

it('composes --contains with the other read filters', async () => {
  const { options } = setup(5000);
  post(options, 'x-hit', { kind: 'note', text: 'alpha target' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-from', { kind: 'note', text: 'alpha target' }, { from: 'agent:atlas' });
  post(options, 'x-miss-text', { kind: 'note', text: 'beta target' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-job', { kind: 'work.post', jobId: 'RQ-J-1', title: 'alpha job', repo: 'o/r', claimKeys: ['queue:RQ-J-1'] });

  expect(await read(options, ['--contains', 'alpha', '--from', 'agent:orion'])).toEqual(['x-hit']);
  expect(await read(options, ['--contains', 'alpha', '--priority', 'P0'])).toEqual(['x-hit']);
  expect(await read(options, ['--contains', 'alpha', '--job', 'RQ-J-1'])).toEqual(['x-job']);
  expect(await read(options, ['--contains', 'alpha', '--to', 'leaders'])).toEqual(['x-hit', 'x-miss-from', 'x-job']);
});

it('applies --contains to watch pages', async () => {
  const { options } = setup();
  post(options, 'w-hit', { kind: 'note', text: 'watch me alpha' });
  post(options, 'w-miss', { kind: 'note', text: 'nothing' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--contains', 'alpha', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-hit']);
});

it('rejects invalid or duplicate --contains values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--contains'], ['--contains', ''], ['--contains', '   '],
      ['--contains', 'x'.repeat(BUS_READ_CONTAINS_MAX + 1)],
      ['--contains', 'alpha', '--contains', 'beta'], ['--contains', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--contains', 'alpha'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('accepts --contains=<text> inline, including flag-looking needles', async () => {
  const { options } = setup();
  post(options, 'i-dash', { kind: 'note', text: 'value -leading dash here' });
  post(options, 'i-other', { kind: 'note', text: 'plain' });

  expect(await read(options, ['--contains=-leading'])).toEqual(['i-dash']);
  expect(await read(options, ['--contains', '-leading'])).toEqual(['i-dash']);
});

it('binds --contains into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'k-a', { kind: 'note', text: 'alpha one' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--contains', 'alpha'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ contains: 'alpha' }));

  // A different --contains or a dropped --contains is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--contains', 'beta'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --contains in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--contains <text>');
});
