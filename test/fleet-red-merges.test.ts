import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { cmdFleetRedMerges } from '../src/cli/fleet-red-merges.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const at = (clock: string, day = '2026-11-01') => `${day}T${clock}:00Z`;
const row = (value: Record<string, unknown>) => JSON.stringify(value);
const deps = (jobs: string | null) => ({
  readJobs: async () => jobs,
  now: () => NOW,
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'red-merges-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('cmdFleetRedMerges', () => {
  it('counts MERGED outcomes by checks value per hour and per lane, joined to launches by job id', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'codex-personal', ts: at('08:00') }),
      row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', checks: 'red', ts: at('09:30') }),
      row({ event: 'launch', job: 'RQ-B', lane: 'codex-personal', ts: at('10:00') }),
      row({ event: 'outcome', job: 'RQ-B', state: 'MERGED', checks: 'green', ts: at('11:00') }),
      row({ event: 'launch', job: 'RQ-C', lane: 'devin', ts: at('10:15') }),
      row({ event: 'outcome', job: 'RQ-C', state: 'MERGED', checks: 'pending', ts: at('11:15') }),
      row({ event: 'outcome', job: 'RQ-D', state: 'MERGED', checks: 'green', ts: at('11:45') }),
      row({ event: 'outcome', job: 'RQ-E', state: 'MERGED', ts: at('05:00') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ schema: 'fleet.red-merges.v1', hours: 24, source: 'healthy', malformed: 0, merges: 5 });
    expect(report.window).toHaveLength(24);
    expect(report.window[0]).toMatchObject({ start: '2026-10-31T12:00:00.000Z', merges: 0, lanes: [] });
    expect(report.window[17]).toEqual({
      start: '2026-11-01T05:00:00.000Z', merges: 1,
      lanes: [{ lane: 'unattributed', red: 0, green: 0, other: 1 }],
    });
    expect(report.window[21]).toEqual({
      start: '2026-11-01T09:00:00.000Z', merges: 1,
      lanes: [{ lane: 'codex-personal', red: 1, green: 0, other: 0 }],
    });
    expect(report.window[23]).toEqual({
      start: '2026-11-01T11:00:00.000Z', merges: 3,
      lanes: [
        { lane: 'codex-personal', red: 0, green: 1, other: 0 },
        { lane: 'devin', red: 0, green: 0, other: 1 },
        { lane: 'unattributed', red: 0, green: 1, other: 0 },
      ],
    });
  });

  it('keeps a merge row own lane over the launch join and reads ChecksMemo-shaped checks', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('10:00') }),
      row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', lane: 'grok-ultra', checks: { state: 'red', detail: 'ci fail' }, ts: at('11:00') }),
      row({ event: 'outcome', job: 'RQ-B', state: 'MERGED', checks: 'GREEN', ts: at('11:30') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.window[23]).toEqual({
      start: '2026-11-01T11:00:00.000Z', merges: 2,
      lanes: [
        { lane: 'grok-ultra', red: 1, green: 0, other: 0 },
        { lane: 'unattributed', red: 0, green: 1, other: 0 },
      ],
    });
  });

  it('counts one merge per job at its earliest instant; duplicate rows fold', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('09:00') }),
      row({ job: 'RQ-A', to: 'LAND', checks: 'red', at: at('10:00') }),
      row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', checks: 'green', ts: at('10:05') }),
      row({ event: 'pr-merge', job: 'RQ-A', checks: 'other', ts: at('10:10') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.merges).toBe(1);
    expect(report.window[22]).toEqual({
      start: '2026-11-01T10:00:00.000Z', merges: 1,
      lanes: [{ lane: 'devin', red: 1, green: 0, other: 0 }],
    });
  });

  it('ignores merges outside the window but still joins the old launch', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-OLD', lane: 'grok-ultra', ts: at('00:00', '2026-10-30') }),
      row({ event: 'outcome', job: 'RQ-OLD', state: 'MERGED', checks: 'red', ts: at('11:00') }),
      row({ event: 'outcome', job: 'RQ-EARLY', state: 'MERGED', checks: 'red', ts: at('10:00', '2026-10-31') }),
      row({ event: 'outcome', job: 'RQ-FUTURE', state: 'MERGED', checks: 'red', ts: at('13:00') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.merges).toBe(1);
    expect(report.window[23]).toMatchObject({ merges: 1, lanes: [{ lane: 'grok-ultra', red: 1, green: 0, other: 0 }] });
  });

  it('prints unknown per hour, never zero, when the ledger is missing', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--json'], deps(null))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ source: 'missing', merges: 'unknown' });
    expect(report.window).toHaveLength(24);
    expect(report.window.every((h: { merges: unknown }) => h.merges === 'unknown')).toBe(true);
    expect(await cmdFleetRedMerges([], deps(null))).toBe(0);
    const lines = output.mock.calls.slice(1).map(call => String(call[0]));
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}unknown$/);
  });

  it('still prints unknown when the reader fails, and exits 1', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetRedMerges(['--json'], {
      readJobs: async () => { throw new Error('private path'); },
      now: () => NOW,
    });
    expect(code).toBe(1);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ source: 'unreadable', merges: 'unknown' });
  });

  it('counts malformed lines and marks the source degraded', async () => {
    const jobs = [
      row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', checks: 'red', ts: at('11:00') }),
      'not json',
      '["array"]',
      '',
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ source: 'degraded', malformed: 2, merges: 1 });
  });

  it('prints one plain line per hour in human mode', async () => {
    const jobs = [
      row({ event: 'launch', job: 'RQ-A', lane: 'devin', ts: at('10:00') }),
      row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', checks: 'red', ts: at('11:30') }),
      row({ event: 'outcome', job: 'RQ-B', state: 'MERGED', checks: 'green', ts: at('11:45') }),
    ].join('\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges([], deps(jobs))).toBe(0);
    const lines = output.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(24);
    expect(lines[0]).toBe('2026-10-31T12:00:00.000Z  no merges');
    expect(lines[23]).toBe('2026-11-01T11:00:00.000Z  2 merges — devin: red 1, green 0, other 0; unattributed: red 0, green 1, other 0');
  });

  it('honors --hours for the window', async () => {
    const jobs = row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', checks: 'red', ts: at('11:00') });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--hours', '2', '--json'], deps(jobs))).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.hours).toBe(2);
    expect(report.window).toHaveLength(2);
    expect(report.window[1]).toMatchObject({ start: '2026-11-01T11:00:00.000Z', merges: 1 });
  });

  it('rejects invalid flags before reading', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readJobs = vi.fn(async () => '');
    for (const args of [
      ['--hours', '0'], ['--hours', '169'], ['--hours', 'x'], ['--hours'],
      ['--root'], ['--root', 'relative/dir'], ['--wat'], ['--json', '--json'],
    ]) {
      expect(await cmdFleetRedMerges(args, { readJobs, now: () => NOW }), JSON.stringify(args)).toBe(2);
    }
    expect(readJobs).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet red-merges'));
  });

  it('prints its own help on --help and exits 0 without reading', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readJobs = vi.fn(async () => '');
    expect(await cmdFleetRedMerges(['--help'], { readJobs })).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet red-merges'));
    expect(readJobs).not.toHaveBeenCalled();
  });

  it('exits 1 when the clock source is not finite', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetRedMerges([], { readJobs: async () => '', now: () => Number.NaN })).toBe(1);
    expect(error).toHaveBeenCalledWith('fleet red-merges: metrics unavailable');
  });

  it('reads a real root end-to-end: metrics/jobs.jsonl under --root', async () => {
    await mkdir(join(root, 'metrics'), { recursive: true });
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
      row({ event: 'launch', job: 'RQ-A', lane: 'codex-personal', ts: at('10:00') }),
      row({ event: 'outcome', job: 'RQ-A', state: 'MERGED', checks: 'red', ts: at('11:00') }),
    ].join('\n'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedMerges(['--root', root, '--json'], { now: () => NOW })).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ source: 'healthy', merges: 1 });
    expect(report.window[23]).toMatchObject({ lanes: [{ lane: 'codex-personal', red: 1, green: 0, other: 0 }] });
  });

  it('resolves through the fleet registry and dispatches ashlr fleet red-merges --help', async () => {
    const resolved = resolveFleetSubcommand('red-merges');
    expect(resolved).toEqual({ module: './fleet-red-merges.js', exportName: 'cmdFleetRedMerges' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['red-merges']!();
    expect(loaded[resolved!.exportName]).toBe(cmdFleetRedMerges);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['red-merges', '--help'])).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet red-merges'));
  });
});
