import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetLaneMerges, type LaneLimitsRead } from '../src/cli/fleet-lane-merges.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const at = (clock: string, day = '2026-11-01') => `${day}T${clock}:00Z`;
const row = (value: Record<string, unknown>) => JSON.stringify(value);
const noLimits: LaneLimitsRead = { state: 'missing', limits: new Map() };
const deps = (jobs: string | null, limits: LaneLimitsRead = noLimits) => ({
  readJobs: async () => jobs,
  readLimits: async () => limits,
  now: () => NOW,
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lane-merges-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('cmdFleetLaneMerges', () => {
  it('joins launch and outcome rows by job id and prints one line per lane', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'codex-personal', ts: at('10:00') }),
      row({ event: 'publish', job: 'RQ-A', url: 'https://github.com/AshlrAI/Phantom/pull/7', ts: at('10:30') }),
      row({ event: 'outcome', job: 'RQ-A', outcome: 'merged', ts: at('11:00') }),
      row({ event: 'launch', job: 'RQ-B', lane: 'codex-personal', ts: at('11:15') }),
      row({ event: 'launch', job: 'RQ-C', lane: 'devin', ts: at('09:00') }),
      row({ job: 'RQ-C', outcome: 'merged', pr: 'ashlrai/phantom#9', mergedAt: at('11:30') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ schema: 'fleet.lane-merges.v1', hours: 24, source: 'healthy', limits: 'missing', malformed: 0 });
    expect(report.lanes).toEqual([
      { lane: 'codex-personal', launches: 2, prs: 1, prUrls: ['ashlrai/phantom#7'], merges: 1, limit: null },
      { lane: 'devin', launches: 1, prs: 1, prUrls: ['ashlrai/phantom#9'], merges: 1, limit: null },
    ]);
  });

  it('prints plain words in human mode, limit unknown without a real source', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'codex-personal', ts: at('10:00') }),
      row({ event: 'outcome', job: 'RQ-A', outcome: 'merged', ts: at('11:00') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges([], deps(jobs))).toBe(0);
    expect(output.mock.calls.map(call => String(call[0]))).toEqual([
      'codex-personal: 1 launch, 0 PRs, 1 merge, limit unknown',
      'lane limits unknown (slots.json missing)',
    ]);
  });

  it('reads lane limits from slots.json and lists quiet lanes at zero', async () => {
    const jobs = row({ event: 'launch', job: 'RQ-A', lane: 'codex-personal', ts: at('10:00') });
    const limits: LaneLimitsRead = {
      state: 'healthy',
      limits: new Map([['codex-personal', 4], ['devin', 1]]),
    };
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(jobs, limits))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.lanes).toEqual([
      { lane: 'codex-personal', launches: 1, prs: 0, prUrls: [], merges: 0, limit: 4 },
      { lane: 'devin', launches: 0, prs: 0, prUrls: [], merges: 0, limit: 1 },
    ]);
  });

  it('dedupes merges by PR identity and skips job-only duplicates', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('09:00') }),
      row({ job: 'RQ-A', to: 'LAND', at: at('10:00') }),
      row({ job: 'RQ-A', to: 'LAND', at: at('10:01') }),
      row({ event: 'pr-merge', job: 'RQ-A', prUrl: 'https://github.com/ashlrai/phantom/pull/3', ts: at('10:02') }),
      row({ event: 'pr-merge', at: at('10:03') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    // Two LAND rows for one job fold to one merge; the job-only LANDs are
    // duplicates once the job names a PR; an unattributable merge row counts
    // for nobody.
    expect(report.lanes).toEqual([
      { lane: 'devin', launches: 1, prs: 1, prUrls: ['ashlrai/phantom#3'], merges: 1, limit: null },
    ]);
  });

  it('ignores activity outside the window but keeps old lanes for the join', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-OLD', lane: 'grok-ultra', ts: at('00:00', '2026-10-30') }),
      row({ job: 'RQ-OLD', outcome: 'merged', ts: at('11:00') }),
      row({ event: 'launch', job: 'RQ-FUTURE', lane: 'grok-ultra', ts: at('13:00') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.lanes).toEqual([
      { lane: 'grok-ultra', launches: 0, prs: 0, prUrls: [], merges: 1, limit: null },
    ]);
  });

  it('counts a relaunch at a new instant but not a duplicate append', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('10:00') }),
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('10:00') }),
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('11:00') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(jobs))).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0])).lanes[0]).toMatchObject({ launches: 2 });
  });

  it('counts malformed lines and marks the source degraded', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('10:00') }),
      'not json',
      '["array"]',
      '',
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ source: 'degraded', malformed: 2 });
  });

  it('reports a missing jobs ledger without failing', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--json'], deps(null))).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ source: 'missing', lanes: [] });
    expect(await cmdFleetLaneMerges([], deps(null))).toBe(0);
    expect(output).toHaveBeenCalledWith('no lane activity in the last 24 hours (jobs ledger missing)');
  });

  it('honors --hours for the window', async () => {
    const jobs = row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('09:00') });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--hours', '2', '--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.hours).toBe(2);
    expect(report.lanes).toEqual([]);
  });

  it('exits 1 when the jobs reader fails, without leaking its error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdFleetLaneMerges([], {
      readJobs: async () => { throw new Error('private path'); },
      readLimits: async () => noLimits,
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith('fleet lane-merges: metrics unavailable');
  });

  it('still reports when the limits reader fails; limits stay unknown', async () => {
    const jobs = row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('10:00') });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetLaneMerges(['--json'], {
      readJobs: async () => jobs,
      readLimits: async () => { throw new Error('io'); },
      now: () => NOW,
    });
    expect(code).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ limits: 'degraded' });
    expect(report.lanes[0]).toMatchObject({ lane: 'devin', limit: null });
  });

  it('rejects invalid flags before reading', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readJobs = vi.fn(async () => '');
    for (const args of [
      ['--hours', '0'], ['--hours', '169'], ['--hours', 'x'], ['--hours'],
      ['--root'], ['--root', 'relative/dir'], ['--wat'], ['--json', '--json'],
    ]) {
      expect(await cmdFleetLaneMerges(args, { readJobs }), JSON.stringify(args)).toBe(2);
    }
    expect(readJobs).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet lane-merges'));
  });

  it('prints its own help on --help and exits 0 without reading', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readJobs = vi.fn(async () => '');
    expect(await cmdFleetLaneMerges(['--help'], { readJobs })).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet lane-merges'));
    expect(readJobs).not.toHaveBeenCalled();
  });

  it('reads a real root end-to-end: metrics/jobs.jsonl plus queue/slots.json', async () => {
    await mkdir(join(root, 'metrics'), { recursive: true });
    await mkdir(join(root, 'queue'), { recursive: true });
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
      row({ event: 'launch', job: 'RQ-A', lane: 'codex-personal', ts: at('10:00') }),
      row({ job: 'RQ-A', outcome: 'merged', pr: 'ashlrai/phantom#11', ts: at('11:00') }),
    ].join('\n'));
    await writeFile(join(root, 'queue', 'slots.json'), JSON.stringify({
      lanes: { 'codex-personal': { target: 4, floor: 0, ceiling: 8, held: false } },
    }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneMerges(['--root', root, '--json'], { now: () => NOW })).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ source: 'healthy', limits: 'healthy' });
    expect(report.lanes).toEqual([
      { lane: 'codex-personal', launches: 1, prs: 1, prUrls: ['ashlrai/phantom#11'], merges: 1, limit: 4 },
    ]);
  });

  it('resolves through the fleet registry and dispatches ashlr fleet lane-merges --help', async () => {
    const resolved = resolveFleetSubcommand('lane-merges');
    expect(resolved).toEqual({ module: './fleet-lane-merges.js', exportName: 'cmdFleetLaneMerges' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['lane-merges']!();
    expect(loaded[resolved!.exportName]).toBe(cmdFleetLaneMerges);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['lane-merges', '--help'])).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet lane-merges'));
  });
});
