import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobSource, readYieldBy, worstYield, yieldBy, yieldByLines, yieldDigestLine } from '../src/core/fleet/yield-by.js';
import { cmdJobsYield } from '../src/cli/jobs-yield.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const launch = (job: string, lane = 'work', minutesAgo = 120, extra: Record<string, unknown> = {}) => row({ event: 'launch', job, repo: 'phantom', lane, tier: 'mid', ts: at(minutesAgo), ...extra });
const pr = (job: string) => row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: at(90) });
const done = (job: string, minutesAgo: number) => row({ event: 'outcome', job, state: 'MERGED', ts: at(minutesAgo) });
/** Launched 120 minutes ago, merged `after` minutes later. */
const merged = (job: string, lane = 'work', after = 30) => [launch(job, lane), pr(job), done(job, 120 - after)];
const empty = (job: string, lane = 'work') => [launch(job, lane), row({ event: 'finish', job, empty: true, ts: at(100) })];

describe('jobSource', () => {
  it.each([
    ['RQ-BETYIELDN21GQ8', null, 'leader'], ['RQ-PHX-RECUTCOREC566', null, 'core'], ['RQ-CL-DOCS-1795140094', null, 'cl-stream'],
    ['FIXUP-CI-phantom-preflight-fixer-866712', null, 'guardian'], ['RQ-MD3A111800Q8', null, 'filler'], ['RQ-DVL-BUS-1795099428', null, 'other'],
    ['RQ-DVL-BUS-1795099428', 'filler', 'filler'], ['RQ-PHX-RECUTCOREC566', 'leader', 'leader'], ['RQ-DVL-BUS-1795099428', 'somebody', 'other'],
    ['RQ-PHX-RECUTCOREC566', 'somebody', 'core'],
  ])('%s with tag %s is %s', (id, tag, source) => expect(jobSource(id, tag)).toBe(source));
});

describe('yieldBy source', () => {
  const lines = [
    ...Array.from({ length: 5 }, (_, i) => empty(`RQ-MD${i}A11180${i}Q8`)).flat(),
    ...merged('RQ-MD9A111809Q8', 'work', 10),
    ...merged('RQ-PHX-RECUTCOREC1', 'work', 20), ...merged('RQ-PHX-RECUTCOREC2', 'work', 40), ...merged('RQ-PHX-RECUTCOREC3', 'work', 90),
    ...empty('RQ-PHX-RECUTCOREC4'), ...empty('RQ-PHX-RECUTCOREC5'),
    launch('RQ-CL-DOCS-1', 'work', 120, { src: 'cl-stream' }), row({ event: 'publish', job: 'RQ-CL-DOCS-1', class: 'abort', ts: at(100) }),
  ];

  it('rolls up launches, PRs, merged, empty, aborted, rate and median minutes', () => {
    const report = yieldBy(lines, 'source', now, 24);
    const filler = report.rows.find(r => r.name === 'filler')!, core = report.rows.find(r => r.name === 'core')!;
    expect(filler).toMatchObject({ launches: 6, prs: 1, merged: 1, empty: 5, aborted: 0, median_minutes_to_merge: 10 });
    expect(filler.merged_per_launch).toBeCloseTo(1 / 6);
    expect(core).toMatchObject({ launches: 5, prs: 3, merged: 3, empty: 2, median_minutes_to_merge: 40 });
    expect(report.rows.find(r => r.name === 'cl-stream')).toMatchObject({ launches: 1, aborted: 1, merged: 0, median_minutes_to_merge: null });
    expect(report).toMatchObject({ schema: 'jobs.yield-by.v1', version: 1, by: 'source', known: true, launches: 12 });
  });

  it('sorts judged sources lowest merged per launch first, small sources after', () => {
    expect(yieldBy(lines, 'source', now, 24).rows.map(r => r.name)).toEqual(['filler', 'core', 'cl-stream']);
  });

  it('takes the source from the queue when the launch row has no tag, and reports the gap when the queue is unreadable', () => {
    const only = [launch('RQ-DVL-X-1'), launch('RQ-DVL-X-2')];
    expect(yieldBy(only, 'source', now, 24, new Map([['RQ-DVL-X-1', 'filler']])).rows.map(r => r.name).sort()).toEqual(['filler', 'other']);
    expect(yieldBy(only, 'source', now, 24, null).gaps[0]).toMatch(/queue unreadable/);
    expect(yieldBy(only, 'source', now, 24, new Map()).gaps).toEqual([]);
  });

  it('groups by lane', () => {
    const report = yieldBy([...merged('RQ-A-1', 'zai'), ...empty('RQ-A-2', 'zai'), ...merged('RQ-A-3', 'claude')], 'lane', now, 24);
    expect(report.rows.map(r => [r.name, r.launches, r.merged])).toEqual([['zai', 2, 1], ['claude', 1, 1]]);
  });

  it('shows a merge with no usable time as unknown, not zero', () => {
    const report = yieldBy([launch('RQ-A-1'), row({ event: 'outcome', job: 'RQ-A-1', state: 'MERGED' })], 'lane', now, 24);
    expect(report.rows[0]).toMatchObject({ merged: 1, median_minutes_to_merge: null });
    expect(report.gaps.join()).toMatch(/no usable time/);
  });
});

describe('verdict', () => {
  const fill = (n: number, mergedCount: number) => Array.from({ length: n }, (_, i) => i < mergedCount ? merged(`RQ-MD${i}A11180${i}Q8`) : empty(`RQ-MD${i}A11180${i}Q8`)).flat();

  it('names the worst source in plain words', () => {
    const report = yieldBy([...fill(40, 2), ...merged('RQ-PHX-RECUTCOREC1'), ...empty('RQ-PHX-RECUTCOREC2')], 'source', now, 24);
    expect(report.worst).toBe('filler');
    expect(report.verdict).toBe('filler: 2 merged of 40 launches, consider stopping it');
    expect(yieldDigestLine(report)).toBe('yield_low: filler: 2 merged of 40 launches, consider stopping it');
  });

  it('does not suggest stopping a source that is merging', () => {
    expect(yieldBy(fill(10, 4), 'source', now, 24).verdict).toBe('filler: 4 merged of 10 launches, the lowest yield');
  });

  it('never suggests stopping the catch-all', () => {
    expect(worstYield([{ name: 'other', launches: 9, prs: 0, merged: 0, empty: 9, aborted: 0, merged_per_launch: 0, median_minutes_to_merge: null }], 'source', 24).verdict).toBe('other: 0 merged of 9 launches, the lowest yield');
  });

  it('says so when nothing can be judged yet', () => {
    expect(yieldBy(fill(2, 0), 'source', now, 24)).toMatchObject({ worst: null, verdict: 'No source has 5 launches yet, too early to judge' });
    expect(yieldDigestLine(yieldBy(fill(2, 0), 'source', now, 24))).toBeNull();
  });
});

describe('empty window', () => {
  it('reports no launches without a worst source', () => {
    const report = yieldBy([launch('RQ-MD1A111800Q8', 'work', 60 * 30)], 'source', now, 24);
    expect(report).toMatchObject({ known: true, launches: 0, rows: [], worst: null, verdict: 'No launches in the last 24 hours' });
    expect(yieldDigestLine(report)).toBeNull();
  });
});

describe('digest', () => {
  it('carries the yield line after the supply line', () => {
    const lines = buildStatusDigest({ installedVersion: { ok: true, value: '1.0.0' }, publishedVersion: { ok: true, value: '1.0.0' }, updatePending: false,
      mergesLastHour: { ok: true, value: 1 }, mergesLast24h: { ok: true, value: 9 }, lanes: { ok: false, reason: 'x' }, needsMason: { ok: false, reason: 'x' },
      topP0: { ok: false, reason: 'x' }, workClaims: { ok: false, reason: 'x' }, supplyLine: 'supply_low: Claude (0 queued)', yieldLine: 'yield_low: filler: 2 merged of 40 launches, consider stopping it' } as never);
    expect(lines.indexOf('yield_low: filler: 2 merged of 40 launches, consider stopping it')).toBe(lines.indexOf('supply_low: Claude (0 queued)') + 1);
  });
});

describe('phm jobs yield --by', () => {
  let dir: string, logs: string[], errors: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yieldby-'));
    logs = []; errors = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  const write = (lines: string[]) => { const path = join(dir, 'jobs.jsonl'); writeFileSync(path, lines.join('\n')); return path; };

  it('prints the typed JSON with its schema id', async () => {
    const metrics = write(Array.from({ length: 5 }, (_, i) => empty(`RQ-MD${i}A11180${i}Q8`)).flat());
    expect(await cmdJobsYield(['--by', 'source', '--metrics', metrics, '--json'], undefined, now)).toBe(0);
    const out = JSON.parse(logs[0]!);
    expect(out).toMatchObject({ schema: 'jobs.yield-by.v1', version: 1, by: 'source', worst: 'filler' });
  });

  it('prints the verdict first in plain words', async () => {
    const metrics = write(Array.from({ length: 5 }, (_, i) => empty(`RQ-MD${i}A11180${i}Q8`)).flat());
    expect(await cmdJobsYield(['--by', 'lane', '--since', '7d', '--metrics', metrics], undefined, now)).toBe(0);
    expect(logs[0]!.split('\n')[0]).toBe('work: 0 merged of 5 launches, consider stopping it');
  });

  it('reads the queue src tag from the runs dir', async () => {
    const metrics = write([launch('RQ-DVL-A-1'), launch('RQ-DVL-A-2'), launch('RQ-DVL-A-3'), launch('RQ-DVL-A-4'), launch('RQ-DVL-A-5')]);
    const queue = join(dir, 'queue.md');
    writeFileSync(queue, ['1', '2', '3', '4', '5'].map(n => `- READY RQ-DVL-A-${n} (P1, pool=claude, src=leader): x`).join('\n'));
    const report = await readYieldBy({ by: 'source', now, metrics, queue });
    expect(report.rows[0]).toMatchObject({ name: 'leader', launches: 5 });
  });

  it('exits 1 with unknown for an unreadable ledger and 2 for a bad flag', async () => {
    expect(await cmdJobsYield(['--by', 'source', '--metrics', join(dir, 'missing.jsonl')], undefined, now)).toBe(1);
    expect(errors.join()).toMatch(/unknown/);
    expect(await cmdJobsYield(['--by', 'nope'], undefined, now)).toBe(2);
    expect(await cmdJobsYield(['--by', 'source', '--stop-list'], undefined, now)).toBe(2);
  });
});
