import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isNonNegativeFinite,
  isNonNegativeSafeInt,
  isPlainRecord,
  isPositiveSafeInt,
  isStrictUtcIsoTimestamp,
  readBoundedRegularFileUtf8,
  uuidV5Url,
  withAbortTimeout,
} from '../src/core/observability/hop-events.js';
import { buildFleetHop, FLEET_HOP_EVENT, FLEET_HOP_ID_RE } from '../src/core/observability/fleet-hop.js';
import { buildMergedPrCostRollup } from '../src/core/observability/rollup.js';
import { cmdMergeThroughput, diagnoseMergeThroughput } from '../src/cli/telemetry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'phantom-obs-shared-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('observability shared record and numeric guards', () => {
  it('isPlainRecord accepts only non-null non-array objects', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('str')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
  });

  it('distinguishes non-negative finite numbers, safe integers, and positive safe integers', () => {
    expect(isNonNegativeFinite(0)).toBe(true);
    expect(isNonNegativeFinite(0.25)).toBe(true);
    expect(isNonNegativeFinite(-0.01)).toBe(false);
    expect(isNonNegativeFinite(NaN)).toBe(false);
    expect(isNonNegativeFinite(Infinity)).toBe(false);
    expect(isNonNegativeFinite('0')).toBe(false);

    expect(isNonNegativeSafeInt(0)).toBe(true);
    expect(isNonNegativeSafeInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isNonNegativeSafeInt(1.5)).toBe(false);
    expect(isNonNegativeSafeInt(-1)).toBe(false);
    expect(isNonNegativeSafeInt(Number.MAX_SAFE_INTEGER + 1)).toBe(false);

    expect(isPositiveSafeInt(1)).toBe(true);
    expect(isPositiveSafeInt(0)).toBe(false);
    expect(isPositiveSafeInt(-1)).toBe(false);
    expect(isPositiveSafeInt(1.5)).toBe(false);
  });
});

describe('isStrictUtcIsoTimestamp', () => {
  it('accepts canonical UTC timestamps and rejects rollovers or non-UTC shapes', () => {
    expect(isStrictUtcIsoTimestamp('2026-10-26T10:00:00Z')).toBe(true);
    expect(isStrictUtcIsoTimestamp('2026-10-26T10:00:00.123Z')).toBe(true);
    expect(isStrictUtcIsoTimestamp('2026-10-26T10:00:00Z', { requireMillis: true })).toBe(false);
    expect(isStrictUtcIsoTimestamp('2026-10-26T10:00:00.000Z', { requireMillis: true })).toBe(true);
    expect(isStrictUtcIsoTimestamp('2026-02-30T12:00:00Z')).toBe(false);
    expect(isStrictUtcIsoTimestamp('2026-02-30T12:00:00.000Z', { requireMillis: true })).toBe(false);
    expect(isStrictUtcIsoTimestamp('2026-10-26T10:00:00+00:00')).toBe(false);
    expect(isStrictUtcIsoTimestamp(1700000000000)).toBe(false);
  });
});

describe('uuidV5Url', () => {
  it('produces deterministic RFC 4122 UUIDv5 strings', () => {
    const first = uuidV5Url('phantom-router:["spend","ashlrai/phantom","rec-1"]');
    const second = uuidV5Url('phantom-router:["spend","ashlrai/phantom","rec-1"]');
    const other = uuidV5Url('https://phm.dev/queue.v1/evt-1');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(other).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
});

describe('withAbortTimeout', () => {
  it('clears its timer on normal completion and aborts when the deadline expires', async () => {
    vi.useFakeTimers();
    const ok = await withAbortTimeout(1_000, async (signal) => {
      expect(signal.aborted).toBe(false);
      return 'done';
    });
    expect(ok).toBe('done');
    expect(vi.getTimerCount()).toBe(0);

    let capturedSignal: AbortSignal | undefined;
    const pending = withAbortTimeout(50, (signal) => new Promise<never>((_resolve, reject) => {
      capturedSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
    }));
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(capturedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readBoundedRegularFileUtf8', () => {
  it('reads regular UTF-8 files up to maxBytes and rejects oversized or non-regular paths', async () => {
    const file = join(tmpDir, 'sample.json');
    writeFileSync(file, '{"ok":true}', 'utf8');
    expect(await readBoundedRegularFileUtf8(file, 11)).toBe('{"ok":true}');
    await expect(readBoundedRegularFileUtf8(file, 10)).rejects.toThrow('File too large');
    await expect(readBoundedRegularFileUtf8(tmpDir, 1024)).rejects.toThrow('Expected regular file');
  });
});

describe('fleet-hop and rollup shared contract', () => {
  it('shares the fleet_hop event name and id shape between emitter and rollup', () => {
    expect(FLEET_HOP_EVENT).toBe('fleet_hop');
    expect(FLEET_HOP_ID_RE.test('RQ-OBS-1')).toBe(true);
    expect(FLEET_HOP_ID_RE.test('bad id with spaces')).toBe(false);

    const emitted = buildFleetHop(
      {
        job_id: 'RQ-OBS-1',
        pr: 123,
        station: 'merged',
        pool: 'codex-cmp',
        enter_ts: '2026-10-26T06:00:00Z',
        exit_ts: '2026-10-26T06:01:00Z',
        tokens: 500,
        usd: 0.02,
      },
      () => new Date('2026-10-26T06:01:00Z'),
    );
    expect(emitted?.event).toBe(FLEET_HOP_EVENT);
    const rollup = buildMergedPrCostRollup([emitted]);
    expect(rollup.mergedPrs).toHaveLength(1);
    expect(rollup.mergedPrs[0]?.totals).toMatchObject({ hops: 1, tokens: 500, usd: 0.02 });
  });
});

describe('telemetry merge-throughput shared helpers', () => {
  it('validates canonical UTC timestamps and reads bounded regular files', async () => {
    expect(() =>
      diagnoseMergeThroughput({
        start: '2026-02-30T00:00:00Z',
        end: '2026-03-01T00:00:00Z',
        complete: true,
        observations: [],
      }),
    ).toThrow('Invalid merge snapshot');

    const snapshotPath = join(tmpDir, 'snapshot.json');
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        start: '2026-10-26T00:00:00Z',
        end: '2026-10-26T02:00:00Z',
        complete: true,
        observations: [
          { id: 'pr-1', state: 'merged', mergedAt: '2026-10-26T01:00:00Z' },
          { id: 'pr-2', state: 'waiting' },
        ],
      }),
      'utf8',
    );
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdMergeThroughput(['--input', snapshotPath, '--json'])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      schema: 'merge-throughput.v1',
      coverage: 'complete',
      completedMerges: 1,
      waitingObservedAtEnd: 1,
      mergesPerHour: 0.5,
    });

    // Directory (non-regular file) is rejected cleanly.
    expect(await cmdMergeThroughput(['--input', tmpDir, '--json'])).toBe(1);
  });
});
