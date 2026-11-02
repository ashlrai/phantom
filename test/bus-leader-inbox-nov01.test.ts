import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { inboxTextFor, isLeaderAddressedFromConsole, mirrorLeaderPostToInbox } from '../src/core/fleet/bus-leader-inbox.js';
import { INBOX_MAX_CHARS, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

const message: BusEnvelope = { id: 'fake-id', from: 'mason', to: 'leaders', priority: 'P0', ttl: 1000, body: { text: 'hello' } };
const roots: string[] = [];
function runsDir() { const root = mkdtempSync(join(tmpdir(), 'leader-inbox-')); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('bus leader inbox bridge', () => {
  it('selects only console posts addressed to leaders', () => {
    expect(isLeaderAddressedFromConsole(message)).toBe(true);
    expect(isLeaderAddressedFromConsole({ ...message, from: 'agent' })).toBe(false);
    expect(isLeaderAddressedFromConsole({ ...message, to: 'agent' })).toBe(false);
  });
  it('renders text bodies and bounds the entire inbox entry', () => {
    expect(inboxTextFor(message)).toBe('[bus→leaders] hello');
    expect(inboxTextFor({ ...message, body: 'hello' })).toBe('[bus→leaders] hello');
    for (const body of [null, [], { text: 1 }, 5]) expect(inboxTextFor({ ...message, body })).toBeNull();
    expect(inboxTextFor({ ...message, body: 'x'.repeat(INBOX_MAX_CHARS) })?.length).toBe(INBOX_MAX_CHARS);
  });
  it('records the bus id, deduplicates retries across time, and keeps distinct IDs', async () => {
    const root = runsDir();
    const now = new Date('2026-10-31T04:13:00Z');
    const first = await mirrorLeaderPostToInbox(message, { runsDir: root, now: () => now });
    expect(first).toMatchObject({ ok: true, ack: { channel: 'desktop', dedupeKey: 'fake-id', status: 'accepted' }, publishState: 'skipped' });
    const retry = await mirrorLeaderPostToInbox(message, { runsDir: root, now: () => new Date(now.getTime() + 86_400_000) });
    expect(retry).toMatchObject({ ok: true, ack: { dedupeKey: 'fake-id', status: 'duplicate' } });
    expect(await mirrorLeaderPostToInbox({ ...message, id: 'other-id' }, { runsDir: root })).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    const inbox = await readInboxEntries({ runsDir: root });
    expect(inbox.entries).toHaveLength(2);
    expect(inbox.entries.every(entry => entry.source === 'desktop' && entry.text === '[bus→leaders] hello')).toBe(true);
    expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
  });
  it('ignores ineligible envelopes without creating a store', async () => {
    const root = runsDir();
    for (const envelope of [{ ...message, from: 'agent' }, { ...message, to: 'agent' }, { ...message, body: {} }]) {
      expect(await mirrorLeaderPostToInbox(envelope, { runsDir: root })).toBeNull();
    }
    expect(existsSync(join(root, 'channel-receipts'))).toBe(false);
  });
  it('serializes simultaneous retries of the same id', async () => {
    const root = runsDir();
    const results = await Promise.all(Array.from({ length: 4 }, () => mirrorLeaderPostToInbox(message, { runsDir: root })));
    expect(results.filter(result => result?.ok && result.ack.status === 'accepted')).toHaveLength(1);
    expect(results.filter(result => result?.ok && result.ack.status === 'duplicate')).toHaveLength(3);
    expect((await readInboxEntries({ runsDir: root })).entries).toHaveLength(1);
  });
});
