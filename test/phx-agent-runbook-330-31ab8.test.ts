import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const store = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'runbook-330-bus-'));
  roots.push(root);
  return root;
};
const lastJson = (log: MockInstance): Record<string, unknown> =>
  JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
const writeEnvelope = (root: string, name: string, envelope: unknown): string => {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  return file;
};
const envelope = {
  id: 'fake-hello-1', from: 'fake-agent', to: 'fake-coordinator',
  priority: 'P3', ttl: 300_000, body: { note: 'first-run check' },
};

afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('agent-first-run-330 documented local bus exchange', () => {
  it('runs status, post, read and resume exactly as the runbook documents', async () => {
    const root = store();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // `phm comms bus status` on a fresh host: missing store, null counts, no files created.
    expect(await cmdCommsBus(['status'], { root })).toBe(0);
    expect(lastJson(log)).toEqual({
      source: 'missing', retainedCount: null, retainedBytes: null,
      maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES,
      liveCount: null, expiredCount: null,
    });
    expect(existsSync(join(root, 'bus-inbox'))).toBe(false);

    // `phm comms bus post --file <envelope.json>` returns the post receipt.
    const file = writeEnvelope(root, 'fake-envelope.json', envelope);
    expect(await cmdCommsBus(['post', '--file', file], { root, now: () => 1_000 })).toBe(0);
    expect(lastJson(log)).toEqual({ status: 'posted', id: 'fake-hello-1', cursor: 1 });

    // Status now reports one live retained record with bounded metadata only.
    expect(await cmdCommsBus(['status'], { root, now: () => 1_500 })).toBe(0);
    expect(lastJson(log)).toMatchObject({
      source: 'available', retainedCount: 1, liveCount: 1, expiredCount: 0,
      maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES,
    });
    expect(String(log.mock.calls.at(-1)?.[0])).not.toContain('first-run check');

    // `phm comms bus read --after 0` returns the stored receipt: persistent cursor,
    // epoch-ms receivedAt and the validated envelope with remaining TTL.
    expect(await cmdCommsBus(['read', '--after', '0'], { root, now: () => 1_500 })).toBe(0);
    expect(lastJson(log)).toEqual({
      status: 'ok', nextCursor: 1,
      messages: [{ cursor: 1, receivedAt: 1_000, envelope: { ...envelope, ttl: 299_500 } }],
    });

    // The documented --id filter selects the same receipt.
    expect(await cmdCommsBus(['read', '--after', '0', '--id', 'fake-hello-1'], { root, now: () => 1_500 })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'ok', nextCursor: 1, messages: [{ cursor: 1 }] });

    // Resuming from nextCursor yields an empty page that keeps the cursor.
    expect(await cmdCommsBus(['read', '--after', '1'], { root, now: () => 2_000 })).toBe(0);
    expect(lastJson(log)).toEqual({ status: 'ok', messages: [], nextCursor: 1 });
  });

  it('treats a repost as a duplicate receipt, conflicting IDs as conflict, and filters as non-mutating', async () => {
    const root = store();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = writeEnvelope(root, 'fake-envelope.json', envelope);
    expect(await cmdCommsBus(['post', '--file', file], { root, now: () => 1_000 })).toBe(0);

    // Identical envelope and ID is a successful duplicate, not a new record.
    expect(await cmdCommsBus(['post', '--file', file], { root, now: () => 2_000 })).toBe(0);
    expect(lastJson(log)).toEqual({ status: 'duplicate', id: 'fake-hello-1', cursor: 1 });

    // Same ID with different content conflicts and exits 1.
    const conflict = writeEnvelope(root, 'fake-conflict.json', { ...envelope, body: { note: 'different' } });
    expect(await cmdCommsBus(['post', '--file', conflict], { root, now: () => 2_000 })).toBe(1);
    expect(lastJson(log)).toEqual({ status: 'conflict' });

    // A non-matching routing-label filter returns no rows but still advances the cursor.
    expect(await cmdCommsBus(['read', '--after', '0', '--to', 'fake-other'], { root, now: () => 2_000 })).toBe(0);
    expect(lastJson(log)).toEqual({ status: 'ok', messages: [], nextCursor: 1 });

    // A cursor beyond the retained end is invalid (exit 2), not silently reset.
    expect(await cmdCommsBus(['read', '--after', '2'], { root, now: () => 2_000 })).toBe(2);
    expect(lastJson(log)).toEqual({ status: 'invalid' });
  });

  it('detects the documented full store through status counts and the post status', async () => {
    const root = store();
    const directory = join(root, 'bus-inbox');
    mkdirSync(directory, { mode: 0o700 });
    const rows = Array.from({ length: BUS_INBOX_MAX_MESSAGES }, (_, i) => ({
      cursor: i + 1, receivedAt: 0,
      envelope: { id: `fake-${i}`, from: 'fake-agent', to: 'fake-coordinator', priority: 'P3', ttl: 1, body: null },
    }));
    writeFileSync(join(directory, 'messages.json'), JSON.stringify(rows), { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // retainedCount reaching maxMessages is the documented full-store signal.
    expect(await cmdCommsBus(['status'], { root, now: () => 1 })).toBe(0);
    expect(lastJson(log)).toMatchObject({
      source: 'available', retainedCount: BUS_INBOX_MAX_MESSAGES,
      maxMessages: BUS_INBOX_MAX_MESSAGES, liveCount: 0, expiredCount: BUS_INBOX_MAX_MESSAGES,
    });

    // Nothing is evicted, including expired records: the next post reports full.
    const file = writeEnvelope(root, 'fake-extra.json', { ...envelope, id: 'fake-extra' });
    expect(await cmdCommsBus(['post', '--file', file], { root, now: () => 1 })).toBe(1);
    expect(lastJson(log)).toEqual({ status: 'full' });
  });
});
