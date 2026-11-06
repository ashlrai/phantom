import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildFleetBusEnvelope,
  fleetBusEventId,
  mirrorDispatchToBus,
} from '../src/core/fleet/bus-mirror-dispatch.js';
import { appendBusInbox, inspectBusInbox, listBusInboxAfter, type BusInboxInspection, type BusInboxPost } from '../src/core/fleet/bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from '../src/core/fleet/channel-bus-publish.js';
import type { BusFeedEvent, BusFeedEventKind } from '../src/core/fleet/bus-feed.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const dirs: string[] = [];
const dir = () => { const root = mkdtempSync(join(tmpdir(), 'bus-mirror-')); dirs.push(root); return root; };
afterEach(() => dirs.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const event = (at: string, kind: BusFeedEventKind, text: string): BusFeedEvent => ({ at, kind, text });
const feed = (events: BusFeedEvent[]) => async () => ({ events });
const okInspect: BusInboxInspection = {
  source: 'available', retainedCount: 0, retainedBytes: 0,
  maxMessages: 1024, maxBytes: 1024 * 1024, liveCount: 0, expiredCount: 0,
};
const posted = () => vi.fn((envelope: BusEnvelope) =>
  ({ status: 'posted' as const, id: envelope.id, cursor: 1 }));

function harness(events: BusFeedEvent[], opts: { append?: (envelope: BusEnvelope) => BusInboxPost; inspect?: () => BusInboxInspection } = {}) {
  const append = opts.append ?? posted();
  const cursorFile = join(dir(), 'queue', 'bus-mirror.cursor');
  return {
    cursorFile,
    append,
    run: () => mirrorDispatchToBus({
      read: feed(events), append, inspect: opts.inspect ?? (() => okInspect), cursorFile,
    }),
  };
}

describe('fleet dispatch bus mirror', () => {
  it('builds a deterministic fleet -> all P2 fleet-event envelope', () => {
    const at = '2026-10-31 23:51:00';
    const text = 'RQ-PHX-FOO31 phantom claude frontier';
    const envelope = buildFleetBusEnvelope(event(at, 'launch', text));
    expect(envelope.id).toBe(`fleet-launch-${createHash('sha256').update(at + text, 'utf8').digest('hex').slice(0, 16)}`);
    expect(envelope.id).toBe(fleetBusEventId('launch', at, text));
    expect(envelope).toMatchObject({ from: 'fleet', to: 'all', priority: 'P2', ttl: CHANNEL_BUS_TTL_MS });
    expect(envelope.body).toEqual({ kind: 'fleet-event', event: 'launch', at, text, job: 'RQ-PHX-FOO31', lane: 'claude' });
    // Same event, same id — the store's id dedupe makes re-scans idempotent.
    expect(buildFleetBusEnvelope(event(at, 'launch', text)).id).toBe(envelope.id);
    expect(buildFleetBusEnvelope(event(at, 'launch', `${text} later`)).id).not.toBe(envelope.id);
  });

  it('extracts the first job token and first known lane, omitting both when absent', () => {
    const withLane = buildFleetBusEnvelope(event('2026-10-31 00:00:01', 'lane-hold', 'claude autobackoff job=RQ-PHX-BAR9 until=x'));
    expect(withLane.body).toMatchObject({ job: 'RQ-PHX-BAR9', lane: 'claude' });
    const unknownLane = buildFleetBusEnvelope(event('2026-10-31 00:00:02', 'lane-hold', 'released lane-a by reset-detect'));
    expect(unknownLane.body).not.toHaveProperty('job');
    expect(unknownLane.body).not.toHaveProperty('lane');
    const noJob = buildFleetBusEnvelope(event('2026-10-31 00:00:03', 'inbox', 'new entry from mason'));
    expect(noJob.body).not.toHaveProperty('job');
    expect(buildFleetBusEnvelope(event('2026-10-31 00:00:04', 'other', 'x'.repeat(600))).body)
      .toMatchObject({ text: 'x'.repeat(500) });
  });

  it('posts each new event oldest first and records the counters', async () => {
    const append = posted();
    const events = [
      event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-A1 phantom claude frontier'),
      event('2026-10-31 23:52:00', 'published', 'RQ-PHX-A1 pr opened'),
      event('2026-10-31 23:53:00', 'other', 'MERGED RQ-PHX-A1'),
    ];
    // Deliberately out of order: the mirror appends oldest first regardless.
    const { run } = harness([...events].reverse(), { append });
    const result = await run();
    expect(result).toMatchObject({ scanned: 3, posted: 3, duplicate: 0, skipped: 0, reason: 'ok' });
    expect(append.mock.calls.map((call) => (call[0] as BusEnvelope).body)).toEqual(
      events.map((e) => expect.objectContaining({ at: e.at, event: e.kind })));
  });

  it('advances the {at, key} cursor and skips covered rows on the next run', { timeout: 30_000 }, async () => {
    const root = dir(), cursorFile = join(root, 'queue', 'bus-mirror.cursor');
    const events = [
      event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-A1 phantom claude frontier'),
      event('2026-10-31 23:52:00', 'published', 'RQ-PHX-A1 pr opened'),
      event('2026-10-31 23:53:00', 'other', 'MERGED RQ-PHX-A1'),
    ];
    const deps = (evs: BusFeedEvent[]) => ({
      read: feed(evs),
      append: (envelope: BusEnvelope, o?: { now?: () => number }) => appendBusInbox(envelope, { root, now: o?.now }),
      inspect: (o?: { now?: () => number }) => inspectBusInbox({ root, now: o?.now }),
      cursorFile,
    });
    expect(await mirrorDispatchToBus(deps(events))).toMatchObject({ posted: 3, skipped: 0, reason: 'ok' });
    const cursor = JSON.parse(readFileSync(cursorFile, 'utf8')) as { at: string; key: string };
    expect(cursor).toEqual({ at: events[2]!.at, key: fleetBusEventId('other', events[2]!.at, events[2]!.text) });
    // Second run over the same rows: nothing posts and nothing is attempted again.
    const second = await mirrorDispatchToBus(deps(events));
    expect(second).toMatchObject({ scanned: 3, posted: 0, duplicate: 0, skipped: 3, reason: 'ok' });
    // A newer event posts alone; the cursor advances to it.
    const next = [...events, event('2026-10-31 23:54:00', 'inbox', 'new entry from mason')];
    expect(await mirrorDispatchToBus(deps(next))).toMatchObject({ posted: 1, skipped: 3, reason: 'ok' });
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).toMatchObject({ at: next[3]!.at });
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status === 'ok' && page.messages.map((m) => m.envelope.from)).toEqual(['fleet', 'fleet', 'fleet', 'fleet']);
  });

  it('posts only the rows after the cursor key within one timestamp', async () => {
    const cursorFile = join(dir(), 'queue', 'bus-mirror.cursor');
    const [a, b, c] = [
      event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-A1 one'),
      event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-B2 two'),
      event('2026-10-31 23:51:00', 'published', 'RQ-PHX-B2 three'),
    ];
    const deps = (evs: BusFeedEvent[]) => ({
      read: feed(evs), append: posted(), inspect: () => okInspect, cursorFile,
    });
    expect(await mirrorDispatchToBus(deps([a, b]))).toMatchObject({ posted: 2 });
    expect(await mirrorDispatchToBus(deps([a, b, c]))).toMatchObject({ posted: 1, skipped: 2, reason: 'ok' });
  });

  it('stops before posting when the store is near its caps', async () => {
    const nearFull: BusInboxInspection = { ...okInspect, retainedCount: 950 };
    const append = posted();
    const { run } = harness([event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-A1 x')], { append, inspect: () => nearFull });
    expect(await run()).toMatchObject({ scanned: 1, posted: 0, reason: 'headroom' });
    expect(append).not.toHaveBeenCalled();
    const nearBytes: BusInboxInspection = { ...okInspect, retainedBytes: Math.ceil(0.9 * okInspect.maxBytes) };
    const second = harness([event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-A1 x')], { inspect: () => nearBytes });
    expect((await second.run()).reason).toBe('headroom');
  });

  it('stops on a full store without throwing and lets the next run retry', { timeout: 30_000 }, async () => {
    const root = dir(), cursorFile = join(root, 'queue', 'bus-mirror.cursor');
    const events = [event('2026-10-31 23:51:00', 'launch', 'RQ-PHX-A1 x')];
    const failing = await mirrorDispatchToBus({
      read: feed(events),
      append: () => ({ status: 'full' }),
      inspect: () => okInspect,
      cursorFile,
    });
    expect(failing).toMatchObject({ posted: 0, reason: 'full' });
    expect(existsSync(cursorFile)).toBe(false);
    const retry = await mirrorDispatchToBus({
      read: feed(events),
      append: (envelope: BusEnvelope, o?: { now?: () => number }) => appendBusInbox(envelope, { root, now: o?.now }),
      inspect: (o?: { now?: () => number }) => inspectBusInbox({ root, now: o?.now }),
      cursorFile,
    });
    expect(retry).toMatchObject({ posted: 1, reason: 'ok' });
    expect(existsSync(cursorFile)).toBe(true);
  });

  it('skips permanently refused envelopes and keeps mirroring later events', async () => {
    const append = vi.fn((envelope: BusEnvelope): BusInboxPost =>
      (envelope.body as { text?: string }).text === 'poison'
        ? { status: 'conflict' }
        : { status: 'posted', id: envelope.id, cursor: 1 });
    const events = [
      event('2026-10-31 23:51:00', 'other', 'poison'),
      event('2026-10-31 23:52:00', 'launch', 'RQ-PHX-A1 x'),
    ];
    const { run, cursorFile } = harness(events, { append });
    expect(await run()).toMatchObject({ posted: 1, skipped: 1, reason: 'ok' });
    // The refused row advanced the cursor so it never stalls the mirror.
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).toMatchObject({ at: events[1]!.at });
  });

  it('never throws: read, inspect and append failures all land in reason', async () => {
    const cursorFile = join(dir(), 'queue', 'bus-mirror.cursor');
    expect(await mirrorDispatchToBus({
      read: async () => { throw new Error('gone'); }, inspect: () => okInspect, cursorFile,
    })).toMatchObject({ scanned: 0, reason: 'unavailable' });
    expect(await mirrorDispatchToBus({
      read: feed([event('2026-10-31 23:51:00', 'launch', 'x')]),
      inspect: () => { throw new Error('denied'); }, cursorFile,
    })).toMatchObject({ reason: 'unavailable' });
    expect(await mirrorDispatchToBus({
      read: feed([event('2026-10-31 23:51:00', 'launch', 'x')]),
      inspect: () => okInspect,
      append: () => { throw new Error('readonly'); },
      cursorFile,
    })).toMatchObject({ reason: 'unavailable' });
    expect(await mirrorDispatchToBus({
      read: feed([event('2026-10-31 23:51:00', 'launch', 'x')]),
      inspect: () => ({ ...okInspect, source: 'unavailable' as const, retainedCount: null, retainedBytes: null }),
      cursorFile,
    })).toMatchObject({ reason: 'unavailable' });
  });
});
