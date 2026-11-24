import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdWorklog, worklogText } from '../src/cli/worklog.js';
import { eventRows, leaderRows, readWorklog, worklog, type WorklogRow } from '../src/core/fleet/worklog.js';

const now = Date.parse('2026-11-09T11:00:00Z');
const fixtures = fileURLToPath(new URL('./fixtures/worklog/', import.meta.url));
// The dispatch events log is written in local wall-clock time, so build it from instants.
const stamp = (iso: string) => {
  const d = new Date(iso), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const events = [
  `${stamp('2026-11-09T10:01:00Z')} LANE_HOLD stopped RQ-HELD by owner: manual stop`,
  `${stamp('2026-11-09T10:02:00Z')} PARKED RQ-BLOCK [precheck code=13 reason=dependency not merged]`,
  `${stamp('2026-11-09T10:05:00Z')} INCIDENT no launch and no merge in 30 min`,
  `${stamp('2026-11-09T10:06:00Z')} INCIDENT no launch and no merge in 30 min`,
  `${stamp('2026-11-09T10:07:00Z')} LAUNCH RQ-POOLS on work`,
].join('\n') + '\n';
let runsDir: string; let worktreesDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'worklog-runs-')); worktreesDir = await mkdtemp(join(tmpdir(), 'worklog-wt-'));
  await mkdir(join(runsDir, 'metrics')); await mkdir(join(runsDir, 'queue')); await mkdir(join(runsDir, 'leader'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(runsDir, { recursive: true, force: true }); await rm(worktreesDir, { recursive: true, force: true }); });
async function seed() {
  await cp(join(fixtures, 'feed-jobs.jsonl'), join(runsDir, 'metrics', 'jobs.jsonl'));
  await cp(join(fixtures, 'feed-plan-log.md'), join(runsDir, 'leader', 'PLAN-LOG.md'));
  await writeFile(join(runsDir, 'queue', 'dispatch-events.log'), events);
  await mkdir(join(worktreesDir, 'RQ-COVERED'));
  await writeFile(join(worktreesDir, 'RQ-COVERED', 'BRIDGE_NOTES.md'), 'No change needed: the tests already covered this.\n');
}
const read = (hours = 6) => readWorklog(hours, { runsDir, worktreesDir, now });

describe('work log feed', () => {
  it('shows every kind as one plain line, newest first, with collapsed repeats', async () => {
    await seed();
    const report = await read();
    expect(report.sources).toEqual({ jobs: { state: 'ok' }, events: { state: 'ok' }, leader: { state: 'ok' } });
    expect(report.rows.map(row => [row.kind, row.job, row.text, row.count])).toEqual([
      ['leader', null, 'Leader: Pools panel merged. Next up is the phone work log.', 1],
      ['incident', null, 'Incident: no launch and no merge in 30 min', 2],
      ['incident', 'RQ-BLOCK', 'Parked: RQ-BLOCK [precheck code=13 reason=dependency not merged]', 1],
      ['incident', 'RQ-HELD', 'Lane hold: stopped RQ-HELD by owner: manual stop', 1],
      ['incident', 'RQ-BROKE', 'Failed with exit code 2', 1],
      ['launched', 'RQ-BROKE', 'Launched', 1],
      ['empty', 'RQ-COVERED', 'Ended with no change: work was already completed or covered', 1],
      ['launched', 'RQ-COVERED', 'Launched', 1],
      ['merged', 'RQ-POOLS', 'Merged #6675 Pools panel in 2m 40s', 1],
      ['finished', 'RQ-POOLS', 'Opened PR #6675 Pools panel', 2],
      ['launched', 'RQ-POOLS', 'Launched with model-a', 2],
    ]);
    expect(report.rows[8]).toEqual({ at: '2026-11-09T09:23:40.000Z', kind: 'merged', job: 'RQ-POOLS', lane: 'work', repo: 'phantom',
      text: 'Merged #6675 Pools panel in 2m 40s', url: 'https://github.com/ashlrai/phantom/pull/6675', count: 1 });
    expect((await read(1.2)).rows.map(row => row.kind)).toEqual(['leader', 'incident', 'incident', 'incident', 'incident', 'launched']);
  });
  it('collapses only consecutive same-kind rows from one job', () => {
    const line = (job: string, ts: string) => JSON.stringify({ event: 'launch', job, ts });
    const text = [line('A', '2026-11-09T10:00:00Z'), line('A', '2026-11-09T10:01:00Z'), line('B', '2026-11-09T10:02:00Z'), line('A', '2026-11-09T10:03:00Z')].join('\n');
    expect(worklog(text, 0, now).rows.map(row => [row.job, row.count, row.at])).toEqual([
      ['A', 1, '2026-11-09T10:03:00.000Z'], ['B', 1, '2026-11-09T10:02:00.000Z'], ['A', 2, '2026-11-09T10:01:00.000Z']]);
    expect(worklog(text, 0, now).entries).toHaveLength(4);
  });
  it('reports a missing or unreadable source as unknown with a reason and keeps the rest', async () => {
    const blank = await read();
    expect(blank.rows).toEqual([]);
    expect(blank.sources).toEqual({ jobs: { state: 'unknown', reason: 'No jobs ledger has been written yet.' },
      events: { state: 'unknown', reason: 'No dispatch events log has been written yet.' },
      leader: { state: 'unknown', reason: 'No leader plan log has been written yet.' } });
    await seed();
    await rm(join(runsDir, 'metrics', 'jobs.jsonl')); await mkdir(join(runsDir, 'metrics', 'jobs.jsonl'));
    await rm(join(runsDir, 'leader', 'PLAN-LOG.md')); await mkdir(join(runsDir, 'leader', 'PLAN-LOG.md'));
    const report = await read();
    expect(report.sources.jobs).toEqual({ state: 'unknown', reason: 'The jobs ledger could not be read.' });
    expect(report.sources.leader).toEqual({ state: 'unknown', reason: 'The leader plan log could not be read.' });
    expect(report.rows.map(row => row.kind)).toEqual(['incident', 'incident', 'incident']);
    expect(JSON.stringify(report)).not.toContain(runsDir);
    const lines = worklogText(report, false);
    expect(lines).toContain('Unknown: job results. The jobs ledger could not be read.');
    expect(lines).toContain('Unknown: leader replies. The leader plan log could not be read.');
  });
  it('falls back to the runs-root dispatch events log when the queue log is absent', async () => {
    await writeFile(join(runsDir, 'dispatch-events.log'), events);
    const report = await read();
    expect(report.sources.events).toEqual({ state: 'ok' });
    expect(report.rows).toHaveLength(3);
  });
  it('serializes the same events in the same order whatever order the sources arrive in', async () => {
    const at = '2026-11-09T10:00:00.000Z';
    const extra: WorklogRow[] = [
      ...leaderRows([{ at, text: 'second' }, { at, text: 'first' }, { at: 'not a date', text: 'dropped' }]),
      ...eventRows([{ at: '', atIso: at, kind: 'incident', text: 'INCIDENT stalled' }, { at: '', atIso: at, kind: 'launch', text: 'LAUNCH X' }, { at: '', kind: 'incident', text: 'INCIDENT undated' }]),
    ];
    const ledger = [{ event: 'launch', job: 'B', ts: at }, { event: 'launch', job: 'A', ts: at }].map(row => JSON.stringify(row));
    const forward = worklog(ledger.join('\n'), 0, now, { rows: extra });
    const reversed = worklog([...ledger].reverse().join('\n'), 0, now, { rows: [...extra].reverse() });
    expect(JSON.stringify(reversed.rows)).toBe(JSON.stringify(forward.rows));
    expect(forward.rows.map(row => row.text)).toEqual(['Launched', 'Launched', 'Leader: first', 'Leader: second', 'Incident: stalled']);
    expect(forward.rows.map(row => row.job)).toEqual(['A', 'B', null, null, null]);
    expect(Object.keys(forward.rows[0]!)).toEqual(['at', 'kind', 'job', 'lane', 'repo', 'text', 'url', 'count']);
    expect(Object.keys(forward)).toEqual(['schema', 'hours', 'rows', 'sources', 'entries', 'malformedLines']);
  });
  it('filters by kind on the command line and prints plain lines', async () => {
    await seed();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = vi.fn(read);
    expect(await cmdWorklog(['--hours', '6', '--kind', 'merged', '--json'], reader)).toBe(0);
    expect(reader).toHaveBeenCalledWith(6);
    expect(JSON.parse(output.mock.calls[0]![0] as string).rows.map((row: WorklogRow) => row.text)).toEqual(['Merged #6675 Pools panel in 2m 40s']);
    expect(await cmdWorklog(['--kind', 'empty'], reader)).toBe(0);
    expect(output.mock.calls[1]![0]).toMatch(/^\d\d-\d\d \d\d:\d\d {2}empty {6}RQ-COVERED · fast · locus {2}Ended with no change: work was already completed or covered$/);
    expect(await cmdWorklog(['--kind', 'finished'], reader)).toBe(0);
    expect(output.mock.calls[2]![0]).toContain('Opened PR #6675 Pools panel (2 events)  https://github.com/ashlrai/phantom/pull/6675');
    for (const bad of [['--kind', 'bogus'], ['--kind'], ['--hours', '0'], ['--hours', '-1']]) expect(await cmdWorklog(bad, reader)).toBe(2);
    expect(reader).toHaveBeenCalledTimes(3);
  });
});
