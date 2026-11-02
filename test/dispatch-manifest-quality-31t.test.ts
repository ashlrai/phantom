import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dispatchManifestDir,
  readDispatchManifestEvents,
  readDispatchManifestEventsDetailed,
  type DispatchManifestEvent,
} from '../src/core/fleet/dispatch-manifest.js';

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-quality-'));
  previousHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = path.join(tmp, 'store');
  fs.mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function event(id: string, ts: string): DispatchManifestEvent {
  return {
    schemaVersion: 1, manifestId: id, ts, mode: 'concurrent', dryRun: false,
    claimedItemIds: [], assignments: [], unassigned: [], slots: {}, backendCounts: {},
    counts: { claimed: 0, assigned: 0, unassigned: 0 },
  };
}

function writePartition(date: string, text: string): string {
  const file = path.join(dispatchManifestDir(), `${date}.jsonl`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

const row = (value: DispatchManifestEvent): string => `${JSON.stringify(value)}\n`;
const inspect = { inspectionOnly: true } as const;

describe('dispatch manifest forensic source quality', () => {
  it('reports a torn final row and retains committed records, including through the compatibility reader', () => {
    const first = event('first', '2026-10-30T09:00:00.000Z');
    const tail = event('tail', '2026-10-30T10:00:00.000Z');
    const file = writePartition('2026-10-30', row(first) + '{"schemaVersion":1');
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({
      sourceState: 'degraded', sourcePresent: true, complete: false, invalidRows: 1,
      rowsScanned: 2, events: [{ manifestId: 'first' }],
    });
    const compatible = readDispatchManifestEvents(inspect) as DispatchManifestEvent[] & { sourceQuality: unknown };
    expect(compatible.map((item) => item.manifestId)).toEqual(['first']);
    expect(compatible.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(Object.keys(compatible)).toEqual(['0']);
    expect(readDispatchManifestEvents({ ...inspect, requireComplete: true })).toEqual([]);

    fs.writeFileSync(file, row(first) + JSON.stringify(tail));
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({
      complete: false, invalidRows: 1, events: [{ manifestId: 'first' }],
    });
  });

  it('retains valid evidence on both sides of a corrupt middle row', () => {
    const first = event('first', '2026-10-30T09:00:00.000Z');
    const later = event('later', '2026-10-30T10:00:00.000Z');
    writePartition('2026-10-30', row(first) + '{bad json}\n' + row(later));
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1, rowsScanned: 3,
      events: [{ manifestId: 'later' }, { manifestId: 'first' }],
    });
  });

  it('accepts exact file, byte and row budgets only when all history fits', () => {
    const first = event('first', '2026-10-29T09:00:00.000Z');
    const second = event('second', '2026-10-30T09:00:00.000Z');
    const a = row(first); const b = row(second);
    writePartition('2026-10-29', a); writePartition('2026-10-30', b);
    const bytes = Buffer.byteLength(a + b);
    expect(readDispatchManifestEventsDetailed({ ...inspect, maxFiles: 2, maxRows: 2, maxBytes: bytes }))
      .toMatchObject({ sourceState: 'healthy', complete: true, filesRead: 2, rowsScanned: 2, bytesRead: bytes });
    expect(readDispatchManifestEventsDetailed({ ...inspect, maxFiles: 1 }))
      .toMatchObject({ complete: false, stopReasons: ['file-limit'], filesRead: 1, events: [{ manifestId: 'second' }] });
    expect(readDispatchManifestEventsDetailed({ ...inspect, maxRows: 1 }))
      .toMatchObject({ complete: false, stopReasons: ['row-limit'], rowsScanned: 1, events: [{ manifestId: 'second' }] });
    expect(readDispatchManifestEventsDetailed({ ...inspect, maxBytes: bytes - 1 }))
      .toMatchObject({ complete: false, stopReasons: ['byte-limit'], events: [{ manifestId: 'second' }] });
  });

  it('selects chronologically within the newest partition even when append order differs', () => {
    writePartition('2026-10-29', row(event('previous', '2026-10-29T23:00:00.000Z')));
    writePartition('2026-10-30', [
      row(event('newest', '2026-10-30T23:00:00.000Z')),
      row(event('middle', '2026-10-30T12:00:00.000Z')),
      row(event('oldest', '2026-10-30T01:00:00.000Z')),
    ].join(''));
    expect(readDispatchManifestEventsDetailed({ ...inspect, limit: 1, stopAfterLimit: true }))
      .toMatchObject({ complete: false, stopReasons: ['event-limit'], filesRead: 1, rowsScanned: 3, events: [{ manifestId: 'newest' }] });
    expect(readDispatchManifestEvents({ ...inspect, limit: 2 }).map((item) => item.manifestId))
      .toEqual(['newest', 'middle']);
  });

  it.runIf(process.platform !== 'win32')('reports unsafe partitions and retains other private partitions', () => {
    const external = path.join(tmp, 'external');
    fs.writeFileSync(external, row(event('external', '2026-10-30T00:00:00.000Z')), { mode: 0o600 });
    fs.symlinkSync(external, path.join(dispatchManifestDir(), '2026-10-30.jsonl'));
    writePartition('2026-10-29', row(event('safe', '2026-10-29T00:00:00.000Z')));
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({
      sourceState: 'degraded', complete: false, unreadableFiles: 1, stopReasons: ['io-error'],
      events: [{ manifestId: 'safe' }],
    });
    expect(fs.readFileSync(external, 'utf8')).toContain('external');
  });

  it('reports an invalid partition name while retaining dated evidence', () => {
    fs.writeFileSync(path.join(dispatchManifestDir(), 'unknown.jsonl'), 'x\n', { mode: 0o600 });
    writePartition('2026-10-30', row(event('safe', '2026-10-30T00:00:00.000Z')));
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({
      complete: false, unreadableFiles: 1, stopReasons: ['io-error'], events: [{ manifestId: 'safe' }],
    });
  });

  it('reports directory entry exhaustion without selecting an arbitrary subset', () => {
    for (let i = 0; i < 2048; i++) fs.writeFileSync(path.join(dispatchManifestDir(), `other-${i}`), '');
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({ sourceState: 'healthy', complete: true });
    writePartition('2026-10-30', row(event('hidden', '2026-10-30T00:00:00.000Z')));
    expect(readDispatchManifestEventsDetailed(inspect)).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['file-limit'], events: [],
    });
  }, 60_000);
});
