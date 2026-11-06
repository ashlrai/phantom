import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetIdleLanes } from '../src/cli/fleet-idle-lanes.js';
import { DEFAULT_STUCK_AFTER_MIN } from '../src/core/fleet/idle-lane-age.js';
import type { IdleLane } from '../src/core/fleet/idle-lanes.js';
import type { LaneLedgerEvent } from '../src/core/fleet/lane-console.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const NOW = Date.parse('2026-11-04T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ev = (pool: string | null, at: string | null): LaneLedgerEvent => ({ job: 'j', pool, at, pr: null, merge: false });
const red = (lane: string): IdleLane => ({ lane, status: 'red', running: 0, target: 4, queued: 17 });

function fixture(contents: unknown) {
  const dir = join(tmpdir(), `idle-lanes-stuck-${Date.now()}`);
  dirs.push(dir);
  const path = join(dir, 'status.json');
  return vi.fn(async (p: string) => {
    if (p.endsWith('status.json')) {
      return typeof contents === 'string' ? contents : JSON.stringify(contents);
    }
    throw new Error('unreadable or over read bound');
  });
}

function readerWithLedger(status: unknown, ledger: string | Error) {
  const dir = join(tmpdir(), `idle-lanes-ledger-${Date.now()}`);
  dirs.push(dir);
  return vi.fn(async (p: string) => {
    if (p.endsWith('status.json')) {
      return typeof status === 'string' ? status : JSON.stringify(status);
    }
    if (ledger instanceof Error) throw ledger;
    return ledger;
  });
}

it('a red lane quiet for 20 min is not STUCK by default, but STUCK with --stuck-after 15', async () => {
  const lane = 'stuck-demo';
  const status = JSON.stringify({ lanes: { [lane]: { running: 0, target: 4, queued: 17, held: false } } });
  const ledger = JSON.stringify({ pool: lane, ts: ago(20) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = readerWithLedger(status, ledger);

    // Default: 20 min quiet is under 30 → not stuck
    expect(await cmdFleetIdleLanes(['--json'], r)).toBe(1);
    const parsedDefault = JSON.parse(logs.mock.calls[0]![0]);
    expect(parsedDefault.lanes[0].stuck).toBe(false);

    // --stuck-after 15: 20 min >= 15 → stuck
    const r2 = readerWithLedger(status, ledger);
    expect(await cmdFleetIdleLanes(['--json', '--stuck-after', '15'], r2)).toBe(1);
    const parsed15 = JSON.parse(logs.mock.calls[1]![0]);
    expect(parsed15.lanes[0].stuck).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('--json --stuck-after 15 reports stuckAfterMin 15 and stuck true; --json alone reports stuckAfterMin 30', async () => {
  const lane = 'json-test';
  const status = JSON.stringify({ lanes: { [lane]: { running: 0, target: 4, queued: 17, held: false } } });
  const ledger = JSON.stringify({ pool: lane, ts: ago(20) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // --json alone: stuckAfterMin 30
    const r1 = readerWithLedger(status, ledger);
    await cmdFleetIdleLanes(['--json'], r1);
    const alone = JSON.parse(logs.mock.calls[0]![0]);
    expect(alone.stuckAfterMin).toBe(DEFAULT_STUCK_AFTER_MIN);
    expect(alone.lanes[0].stuck).toBe(false); // 20 < 30

    // --json --stuck-after 15: stuckAfterMin 15
    const r2 = readerWithLedger(status, ledger);
    await cmdFleetIdleLanes(['--json', '--stuck-after', '15'], r2);
    const with15 = JSON.parse(logs.mock.calls[1]![0]);
    expect(with15.stuckAfterMin).toBe(15);
    expect(with15.lanes[0].stuck).toBe(true); // 20 >= 15
  } finally { vi.useRealTimers(); }
});

it('flag order --stuck-after 15 --json works the same way', async () => {
  const lane = 'order-test';
  const status = JSON.stringify({ lanes: { [lane]: { running: 0, target: 4, queued: 17, held: false } } });
  const ledger = JSON.stringify({ pool: lane, ts: ago(20) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = readerWithLedger(status, ledger);
    await cmdFleetIdleLanes(['--stuck-after', '15', '--json'], r);
    const parsed = JSON.parse(logs.mock.calls[0]![0]);
    expect(parsed.stuckAfterMin).toBe(15);
    expect(parsed.lanes[0].stuck).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('exits 2 for bad --stuck-after: missing, 0, 1441, 2.5, abc, repeated, --bogus', async () => {
  const r = fixture({ lanes: {} });
  const bads: string[][] = [
    ['--stuck-after'],          // missing value
    ['--stuck-after', '0'],     // under 1
    ['--stuck-after', '1441'],  // over 1440
    ['--stuck-after', '2.5'],   // non-integer
    ['--stuck-after', 'abc'],   // non-numeric
    ['--stuck-after', '15', '--stuck-after', '20'], // repeated
    ['--bogus'],                // unknown argument
  ];
  for (const args of bads) {
    expect(await cmdFleetIdleLanes(args, r)).toBe(2);
  }
});

it('--help still returns 0', async () => {
  const r = fixture({ lanes: {} });
  expect(await cmdFleetIdleLanes(['--help'], r)).toBe(0);
});
