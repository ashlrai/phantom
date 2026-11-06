import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdComms } from '../src/cli/comms.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import * as channel from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'inbox-receipt-'));
  roots.push(root);
  const runsDir = join(root, 'private-runs');
  const file = join(root, 'private-message.txt');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const output = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return { root, runsDir, file, log, output };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('returns a durable receipt for a post and its duplicate across receiver restarts', async () => {
  const { runsDir, file, log, output } = setup();
  const body = 'Private interjection: continue the shared handoff.';
  writeFileSync(file, body, { mode: 0o600 });
  const first = createCommsInboxCommand({ runsDir });
  expect(await first(['post', '--file', file, '--receipt-only', '--json'])).toBe(0);
  const accepted = output();
  expect(accepted).toEqual({ ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  const second = createCommsInboxCommand({ runsDir });
  expect(await second(['post', '--json', '--receipt-only', '--file', file])).toBe(0);
  expect(output()).toEqual({ ok: true, ack: { ...accepted.ack, status: 'duplicate' } });
  for (const [line] of log.mock.calls) {
    expect(String(line)).not.toContain(body);
    expect(String(line)).not.toContain(file);
    expect(String(line)).not.toContain(runsDir);
  }
  const inbox = await readInboxEntries({ runsDir });
  expect(inbox.entries).toHaveLength(1);
  expect(inbox.entries[0]?.text).toBe(body);
});

it('reports a failed inbox append and allows the same message to be retried', async () => {
  const { runsDir, file, output } = setup();
  writeFileSync(file, 'Retry this private handoff.', { mode: 0o600 });
  const blocked = join(runsDir, 'leader', 'MASON-INBOX.md');
  mkdirSync(blocked, { recursive: true });
  const command = createCommsInboxCommand({ runsDir });
  expect(await command(['post', '--file', file, '--receipt-only', '--json'])).toBe(1);
  expect(output()).toEqual({ ok: false, reason: 'write-failed' });
  rmSync(blocked, { recursive: true });
  expect(await command(['post', '--file', file, '--receipt-only'])).toBe(0);
  expect(output()).toMatchObject({ ok: true, ack: { status: 'accepted' } });
  expect((await readInboxEntries({ runsDir })).entries).toHaveLength(1);
});

it('projects only explicit acknowledgement fields and calls the receiver once per post', async () => {
  const { runsDir, output } = setup();
  const receive = vi.fn(async () => ({
    ok: true as const,
    envelope: { channel: 'cli' as const, verifiedSenderId: 'local-operator', body: 'private text', receivedAt: 'now', dedupeKey: 'receipt' },
    ack: { channel: 'cli' as const, status: 'accepted' as const, dedupeKey: 'receipt', privatePath: '/private/path', body: 'private text' },
  }));
  vi.spyOn(channel, 'createChannelReceiver').mockReturnValue(receive);
  const command = createCommsInboxCommand({ runsDir, stdin: Readable.from(['private text']) });
  expect(await command(['post', '--file', '-', '--receipt-only', '--json'])).toBe(0);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(receive).toHaveBeenCalledWith({ channel: 'cli', verifiedSenderId: 'local-operator', body: 'private text' });
  expect(output()).toEqual({ ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: 'receipt' } });
});

it('leaves the default post output intact', async () => {
  const { runsDir, output } = setup();
  const receive = vi.fn(async () => ({
    ok: true as const,
    envelope: { channel: 'cli' as const, verifiedSenderId: 'local-operator', body: 'message', receivedAt: 'now', dedupeKey: 'receipt' },
    ack: { channel: 'cli' as const, status: 'accepted' as const, dedupeKey: 'receipt', extra: 'preserved' },
  }));
  vi.spyOn(channel, 'createChannelReceiver').mockReturnValue(receive);
  const command = createCommsInboxCommand({ runsDir, stdin: Readable.from(['message']) });
  expect(await command(['post', '--file', '-', '--json'])).toBe(0);
  expect(output()).toEqual({ ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: 'receipt', extra: 'preserved' } });
  expect(receive).toHaveBeenCalledTimes(1);
});

it('routes help and post through the public parent and rejects invalid flag placement', async () => {
  const { file, log, output, runsDir } = setup();
  expect(await cmdComms(['inbox', 'post', '--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--receipt-only');
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('excludes message text and private paths');
  expect(await cmdComms(['inbox', 'post', '--file', file, '--receipt-only', '--json'])).toBe(1);
  expect(output()).toEqual({ ok: false, reason: 'file-unavailable' });
  const command = createCommsInboxCommand({ runsDir });
  for (const args of [
    ['read', '--receipt-only'], ['read', '--watch', '--receipt-only'], ['read', '--source', '--receipt-only'],
    ['post', '--file', file, '--receipt-only', '--receipt-only'], ['post', '--receipt-only'],
  ]) {
    expect(await command(args)).toBe(2);
    expect(output()).toEqual({ status: 'invalid' });
  }
});
