import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { MAX_BUS_ENVELOPE_BYTES } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
const envelope = { id: 'fake-stdin-id', from: 'fake-agent', to: 'fake-worker', priority: 'P1', ttl: 1000, body: 'hello 🌍' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bus-stdin-'));
  roots.push(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return {
    options: { root, now: () => 100 },
    output: () => JSON.parse(String(log.mock.calls.at(-1)?.[0])) as unknown,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('posts split UTF-8 stdin once and reads it back from durable storage', async () => {
  const { options, output } = fixture();
  const data = Buffer.from(JSON.stringify(envelope));
  const split = data.indexOf(Buffer.from('🌍')) + 2;
  expect(await cmdCommsBus(['post', '--file', '-'], options, { stdin: Readable.from([data.subarray(0, split), data.subarray(split)]) })).toBe(0);
  expect(output()).toEqual({ status: 'posted', id: envelope.id, cursor: 1 });
  expect(await cmdCommsBus(['read'], options)).toBe(0);
  expect(output()).toEqual({ status: 'ok', messages: [{ cursor: 1, receivedAt: 100, envelope }], nextCursor: 1 });
});

it('accepts exactly the byte cap and rejects multibyte input over it without appending', async () => {
  const { options, output } = fixture();
  const json = JSON.stringify(envelope);
  const atCap = Buffer.from(json + ' '.repeat(MAX_BUS_ENVELOPE_BYTES - Buffer.byteLength(json)));
  expect(atCap.length).toBe(MAX_BUS_ENVELOPE_BYTES);
  expect(await cmdCommsBus(['post', '--file', '-'], options, { stdin: Readable.from([atCap]) })).toBe(0);
  expect(output()).toEqual({ status: 'posted', id: envelope.id, cursor: 1 });
  const overCap = Buffer.concat([atCap, Buffer.from('é')]);
  expect(await cmdCommsBus(['post', '--file', '-'], options, { stdin: Readable.from([overCap]) })).toBe(2);
  expect(output()).toEqual({ status: 'invalid' });
  expect(await cmdCommsBus(['read'], options)).toBe(0);
  expect(output()).toEqual({ status: 'ok', messages: [{ cursor: 1, receivedAt: 100, envelope }], nextCursor: 1 });
});

it('rejects malformed input and stream errors without appending', async () => {
  const { options, output } = fixture();
  const broken = new Readable({ read() { this.destroy(new Error('fake stdin failure')); } });
  for (const stdin of [Readable.from(['{"id":']), Readable.from([JSON.stringify(envelope) + '{}']), broken]) {
    expect(await cmdCommsBus(['post', '--file', '-'], options, { stdin })).toBe(2);
    expect(output()).toEqual({ status: 'invalid' });
  }
  expect(await cmdCommsBus(['read'], options)).toBe(0);
  expect(output()).toEqual({ status: 'ok', messages: [], nextCursor: 0 });
});

it('does not consume stdin for help, invalid options, or normal file posts', async () => {
  const { options, output } = fixture();
  const read = vi.fn();
  const stdin = new Readable({ read });
  expect(await cmdCommsBus(['post', '--help'], options, { stdin })).toBe(0);
  expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain('--file -');
  expect(await cmdCommsBus(['post', '--file', '--bad'], options, { stdin })).toBe(2);
  const file = join(options.root, 'fake-envelope.json');
  writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  expect(await cmdCommsBus(['post', '--file', file], options, { stdin })).toBe(0);
  expect(output()).toEqual({ status: 'posted', id: envelope.id, cursor: 1 });
  expect(read).not.toHaveBeenCalled();
  stdin.destroy();
});
