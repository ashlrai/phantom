import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishChannelEnvelope } from '../src/core/fleet/channel-bus-publish.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readBusHoplogTail } from '../src/core/fleet/bus-hoplog.js';
import { busWakeQueuePath, readBusWakes } from '../src/core/fleet/bus-wake-queue.js';
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'channel-wake-')); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })));
const envelope = { channel: 'desktop' as const, verifiedSenderId: 'fake-mason', receivedAt: new Date(0).toISOString(), dedupeKey: 'a'.repeat(64), body: 'fake interjection' };
it('publishes inbox, hop and wake; replay keeps one wake', async () => {
  const directory = root(), opts = { root: directory };
  expect(await publishChannelEnvelope(envelope, opts)).toBe('published');
  expect(listBusInboxAfter(0, 50, opts)).toMatchObject({ status: 'ok', messages: [{ envelope: { from: 'mason' } }] });
  expect(readBusHoplogTail(10, join(directory, 'bus', 'hops.jsonl')).hops).toHaveLength(1);
  expect(readBusWakes(opts).wakes).toHaveLength(1);
  expect(await publishChannelEnvelope(envelope, opts)).toBe('published');
  expect(readBusWakes(opts).wakes).toHaveLength(1);
});
it('preserves accepted inbox when the wake queue refuses', async () => {
  const directory = root(), opts = { root: directory };
  mkdirSync(join(directory, 'bus'), { mode: 0o700 });
  mkdirSync(busWakeQueuePath(directory), { mode: 0o700 });
  expect(await publishChannelEnvelope(envelope, opts)).toBe('published');
  expect(listBusInboxAfter(0, 50, opts)).toMatchObject({ status: 'ok', messages: [{ envelope: { from: 'mason' } }] });
  expect(readBusWakes(opts).state).toBe('unreadable');
});
it('skips oversize bodies before any store writes', async () => {
  const directory = root();
  expect(await publishChannelEnvelope({ ...envelope, body: 'x'.repeat(70 * 1024) }, { root: directory })).toBe('skipped');
  expect(existsSync(join(directory, 'bus'))).toBe(false);
  expect(existsSync(join(directory, 'bus-inbox'))).toBe(false);
});
