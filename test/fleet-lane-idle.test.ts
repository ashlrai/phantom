import { afterEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetLaneIdle, explainIdleLanes } from '../src/cli/fleet-lane-idle.js';

const lane = (overrides = {}) => ({ running: 1, target: 3, queued: 2, held: false, ...overrides });
afterEach(() => vi.restoreAllMocks());

it('explains all four reasons with hold and empty-queue precedence, omitting full lanes', () => {
  const lanes = { held: lane({ held: true }), empty: lane({ queued: 0 }), blocked: lane(), full: lane({ running: 3 }), over: lane({ running: 4 }) };
  expect(explainIdleLanes({ lanes, admission: { admit: false, gate_reason: 'load high\nwait' } }).map(l => l.line))
    .toEqual(['held: held', 'empty: nothing queued', 'blocked: admission closed (load high wait)']);
  expect(explainIdleLanes({ lanes: { ready: lane() }, admission: { admit: true, gate_reason: null } })[0])
    .toMatchObject({ reason: 'queued work not launching', gate_reason: null, running: 1, target: 3, queued: 2 });
});

it('reads the exact status path once and exposes only the typed projection in JSON and plain text', async () => {
  const reader = vi.fn().mockResolvedValue(JSON.stringify({ lanes: { codex: lane() }, unrelated: 'private metadata' }));
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetLaneIdle(['--json'], reader)).toBe(0);
  expect(reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ schema: 'fleet.lane-idle.v1', readOnly: true, lanes: [{ line: 'codex: queued work not launching' }] });
  expect(output.mock.calls[0]![0]).not.toContain('private metadata');
  expect(await cmdFleetLaneIdle([], reader)).toBe(0);
  expect(output.mock.calls.at(-1)![0]).toBe('codex: queued work not launching');
});

it('handles pauses, closed admission without a gate reason, and an empty fleet', () => {
  for (const status of [{ paused: 'maintenance' }, { admission: { admit: false } }, { admission: { decision: 'stop' } }]) {
    expect(explainIdleLanes({ lanes: { codex: lane() }, ...status })[0]!.reason).toBe('admission closed');
  }
  expect(explainIdleLanes({ lanes: {} })).toEqual([]);
});

it('rejects invalid or missing status without echoing its contents or reader errors', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const data of ['private broken json', '{}', JSON.stringify({ lanes: { bad: lane({ running: -1 }) } })]) {
    expect(await cmdFleetLaneIdle(['--json'], async () => data)).toBe(1);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).error).toBe('Queue status unavailable or invalid.');
  }
  expect(await cmdFleetLaneIdle([], async () => { throw new Error('private path'); })).toBe(1);
  expect(output.mock.calls.at(-1)![0]).not.toContain('private path');
});

it('validates arguments and prints help without reading', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const reader = vi.fn();
  expect(await cmdFleetLaneIdle(['--help'], reader)).toBe(0);
  expect(await cmdFleetLaneIdle(['--bogus'], reader)).toBe(2);
  expect(await cmdFleetLaneIdle(['--json', '--json'], reader)).toBe(2);
  expect(reader).not.toHaveBeenCalled();
});
