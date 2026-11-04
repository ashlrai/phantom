import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetIdleLanes } from '../src/cli/fleet-idle-lanes.js';
import { idleLaneAges } from '../src/core/fleet/idle-lane-age.js';
import type { IdleLane } from '../src/core/fleet/idle-lanes.js';
import type { LaneLedgerEvent } from '../src/core/fleet/lane-console.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ev = (pool: string | null, at: string | null): LaneLedgerEvent => ({ job: 'j', pool, at, pr: null, merge: false });
const red = (lane: string): IdleLane => ({ lane, status: 'red', running: 0, target: 4, queued: 17 });
const warn = (lane: string): IdleLane => ({ lane, status: 'warn', running: 0, target: 4, queued: 3 });

afterEach(() => vi.restoreAllMocks());

it('marks a red lane quiet for 45 min as stuck', () => {
  expect(idleLaneAges([red('a')], [ev('a', ago(45))], NOW)[0]).toMatchObject({ quietMin: 45, stuck: true, lastEventAt: ago(45) });
});
it('does not mark a red lane quiet for 5 min as stuck', () => {
  expect(idleLaneAges([red('a')], [ev('a', ago(5))], NOW)[0]).toMatchObject({ quietMin: 5, stuck: false });
});
it('never marks a held (warn) lane stuck', () => {
  expect(idleLaneAges([warn('h')], [ev('h', ago(120))], NOW)[0]).toMatchObject({ quietMin: 120, stuck: false });
});
it('uses the newest event and ignores other pools and unparseable timestamps', () => {
  const events = [ev('a', ago(90)), ev('a', ago(10)), ev('b', ago(1)), ev('a', 'garbage'), ev('a', null), ev(null, ago(0)), ev('a', '2026-11-04T11:59:00')];
  expect(idleLaneAges([red('a')], events, NOW)[0]).toMatchObject({ quietMin: 10, stuck: false });
});
it('gives unknown age and not-stuck for a lane without events', () => {
  expect(idleLaneAges([red('a')], [ev('b', ago(1)), ev('a', 'nope')], NOW)[0]).toEqual({ ...red('a'), lastEventAt: null, quietMin: null, stuck: false });
});

const STATUS = JSON.stringify({ lanes: {
  a: { running: 0, target: 4, queued: 17, held: false },
  b: { running: 0, target: 3, queued: 26, held: false },
  h: { running: 0, target: 2, queued: 3, held: true },
} });
const row = (pool: string, min: number) => JSON.stringify({ pool, ts: ago(min) });
function readerFor(ledger: string | Error) {
  return vi.fn(async (path: string) => {
    if (path.endsWith('status.json')) return STATUS;
    if (ledger instanceof Error) throw ledger;
    return ledger;
  });
}
const logs = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

it('prints age and STUCK in text output', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const output = logs();
    const code = await cmdFleetIdleLanes([], readerFor([row('a', 45), row('b', 5), row('h', 120), row('zzz', 1)].join('\n')));
    expect(code).toBe(1);
    expect(output.mock.calls[0]![0]).toBe([
      'red: a: 0/4 running, 17 queued, last event 45m ago STUCK',
      'red: b: 0/3 running, 26 queued, last event 5m ago',
      'warn: h: 0/2 running, 3 queued, last event 120m ago',
    ].join('\n'));
  } finally { vi.useRealTimers(); }
});
it('says no ledger event for a lane absent from the ledger, and adds fields in JSON', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const output = logs();
    await cmdFleetIdleLanes([], readerFor(row('a', 1)));
    expect(output.mock.calls[0]![0]).toContain('red: b: 0/3 running, 26 queued, no ledger event');
    await cmdFleetIdleLanes(['--json'], readerFor(row('a', 1)));
    const parsed = JSON.parse(output.mock.calls[1]![0]);
    expect(parsed.schema).toBe('fleet.idle-lanes.v1');
    expect(parsed.lanes[1]).toEqual({ lane: 'b', status: 'red', running: 0, target: 3, queued: 26, lastEventAt: null, quietMin: null, stuck: false });
  } finally { vi.useRealTimers(); }
});
it.each([
  ['corrupt', '{{{ not json\nnull\n[1]'],
  ['missing', new Error('ENOENT')],
  ['empty', ''],
])('keeps exit code and lane list when the ledger is %s', async (_name, ledger) => {
  const output = logs();
  expect(await cmdFleetIdleLanes(['--json'], readerFor(ledger))).toBe(1);
  expect(JSON.parse(output.mock.calls[0]![0]).lanes).toEqual([
    { lane: 'a', status: 'red', running: 0, target: 4, queued: 17 },
    { lane: 'b', status: 'red', running: 0, target: 3, queued: 26 },
    { lane: 'h', status: 'warn', running: 0, target: 2, queued: 3 },
  ]);
});
it('reads the ledger next to status.json and documents the stuck mark in help', async () => {
  const output = logs();
  const reader = readerFor('');
  await cmdFleetIdleLanes([], reader);
  expect(reader.mock.calls.map(c => c[0].split('/').pop())).toEqual(['status.json', 'jobs.jsonl']);
  await cmdFleetIdleLanes(['--help'], reader);
  expect(output.mock.calls.at(-1)![0]).toContain('STUCK');
});
