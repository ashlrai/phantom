import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWaiting, explainFleetWaiting, type FleetWaitingReaders } from '../src/cli/fleet-waiting.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const ready = (id: string, extra = 'src=leader') => `- READY ${id} pool=codex-personal repo=phantom ${extra} private prompt`;
const input = (queue = ready('RQ-A'), jobs = '', events = ''): FleetWaitingReaders => ({
  queue: vi.fn(async () => queue), jobs: vi.fn(async () => jobs), events: vi.fn(async () => events),
});
afterEach(() => vi.restoreAllMocks());

describe('fleet waiting', () => {
  it('loads through the fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.waiting!()).cmdFleetWaiting).toBe(cmdFleetWaiting);
  });
  it('selects READY leader jobs, projects metadata and removes duplicates', () => {
    const queue = [ready('RQ-A'), ready('RQ-A'), ready('RQ-B', 'src=leaderish'), ready('RQ-C', 'src=other'),
      ready('RQ-D').replace('- READY', '- DONE'), ` ${ready('RQ-E')}`, '- READY RQ-F src=leader',
      '- READY RQ-G (pool=claude-api, repo=ashlrai/phantom, src=leader)'].join('\n');
    expect(explainFleetWaiting(queue, '', '', now)).toEqual([
      { id: 'RQ-A', pool: 'codex-personal', repo: 'phantom', ageSeconds: 'unknown' },
      { id: 'RQ-G', pool: 'claude-api', repo: 'ashlrai/phantom', ageSeconds: 'unknown' },
    ]);
  });
  it('drops exact ids with launch or precheck_skip, tolerating malformed ledger rows', () => {
    const queue = ['RQ-A', 'RQ-B', 'RQ-C', 'RQ-D'].map(id => ready(id)).join('\n');
    const jobs = ['broken', 'null', JSON.stringify({ event: 'launch', job: 'RQ-A' }),
      JSON.stringify({ event: 'precheck_skip', job_id: 'RQ-B' }),
      JSON.stringify({ event: 'launch', jobId: 'RQ-C-RETRY' }), JSON.stringify({ event: 'finish', job: 'RQ-D' })].join('\n');
    expect(explainFleetWaiting(queue, jobs, '', now).map(row => row.id)).toEqual(['RQ-C', 'RQ-D']);
  });
  it('considers only the last 3000 metric lines', () => {
    const launch = JSON.stringify({ event: 'launch', job: 'RQ-A' });
    expect(explainFleetWaiting(ready('RQ-A'), [launch, ...Array<string>(3000).fill('{}')].join('\n') + '\n', '', now)).toHaveLength(1);
    expect(explainFleetWaiting(ready('RQ-A'), [...Array<string>(2999).fill('{}'), launch].join('\n'), '', now)).toEqual([]);
    expect(explainFleetWaiting(ready('RQ-A'), launch + '\n'.repeat(3001), '', now)).toHaveLength(1);
  });
  it('uses the first exact event match, with unknown for invalid or future dates', () => {
    const events = ['2026-11-04T11:00:00Z RQ-A-RETRY', '2026-11-04T11:58:00Z RQ-A',
      '2026-11-04T11:59:00Z RQ-A', 'undated RQ-B', '2026-11-04T11:00:00Z RQ-B',
      '2026-11-05T12:00:00Z RQ-C'].join('\n');
    expect(explainFleetWaiting(['RQ-A', 'RQ-B', 'RQ-C'].map(id => ready(id)).join('\n'), '', events, now)
      .map(row => row.ageSeconds)).toEqual([120, 'unknown', 'unknown']);
  });
  it('prints typed JSON and one plain line per waiting job without prompt text', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readers = input(ready('RQ-A'), '', '2026-11-04T11:59:00Z RQ-A');
    expect(await cmdFleetWaiting(['--json'], readers, now)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({ schema: 'fleet.waiting.v1', readOnly: true,
      rows: [{ id: 'RQ-A', pool: 'codex-personal', repo: 'phantom', ageSeconds: 60 }] });
    output.mockClear();
    expect(await cmdFleetWaiting([], readers, now)).toBe(0);
    expect(output.mock.calls).toEqual([['RQ-A pool=codex-personal repo=phantom age=60s']]);
    output.mockClear();
    await cmdFleetWaiting([], input(), now);
    expect(output.mock.calls).toEqual([['RQ-A pool=codex-personal repo=phantom age=unknown']]);
    output.mockClear();
    expect(await cmdFleetWaiting([], input(''), now)).toBe(0);
    expect(output).not.toHaveBeenCalled();
  });
  it('reports read failures without echoing their contents', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const key of ['queue', 'jobs', 'events'] as const) {
      const readers = input();
      readers[key] = async () => { throw new Error('private contents'); };
      expect(await cmdFleetWaiting(['--json'], readers, now)).toBe(2);
      expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ schema: 'fleet.waiting.v1', readOnly: true, error: 'Waiting-job evidence is unreadable.' });
    }
  });
  it('handles help and invalid flags before reading', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readers = input();
    expect(await cmdFleetWaiting(['--help'], readers)).toBe(0);
    expect(await cmdFleetWaiting(['-h'], readers)).toBe(0);
    expect(await cmdFleetWaiting(['--json', '--json'], readers)).toBe(2);
    expect(await cmdFleetWaiting(['--apply'], readers)).toBe(2);
    expect(readers.queue).not.toHaveBeenCalled();
  });
});
