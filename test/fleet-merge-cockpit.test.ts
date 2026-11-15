import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildMergeCockpit,
  parseQueueRows,
  parseQueuegenEmitted,
  readMergeCockpit,
  type MergeCockpitInput,
} from '../src/core/fleet/merge-cockpit.js';
import { cmdFleetMergeCockpit } from '../src/cli/fleet-merge-cockpit.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const SRC = { ready: 'healthy', claimed: 'healthy', queuegenState: 'healthy', jobs: 'healthy', landedCloses: 'healthy', mergeEvents: 'healthy' } as const;
const input = (over: Partial<MergeCockpitInput>): MergeCockpitInput => ({
  readyTsv: null, claimedTsv: null, queuegenStates: [], jobsJsonl: null, jobsClipped: false,
  landedClosesJsonl: null, mergeEventsJsonl: null, sources: { ...SRC }, hours: 24, now: NOW, ...over,
});

const stateFile = (emitted: Record<string, { id: string; at: number }>) => JSON.stringify({ v: 1, emitted });
const jobRow = (row: Record<string, unknown>) => JSON.stringify(row);

describe('parseQueuegenEmitted', () => {
  it('reads emitted rows and skips malformed entries', () => {
    const rows = parseQueuegenEmitted(stateFile({
      'ashlrai/phantom#10': { id: 'RQ-REBASE-phantom-10-aaaaaaa', at: NOW - H },
      'bad-key': { id: 'RQ-REBASE-phantom-1-aaaaaaa', at: 1 },
      'ashlrai/locus#x': { id: 'RQ-REBASE-locus-3-ccccccc', at: 2 },
      'ashlrai/locus#3': { id: 'not a job', at: 3 },
      'ashlrai/locus#4': { id: 'RQ-REBASE-locus-4-ccccccc', at: -1 },
    }));
    expect(rows).toEqual([{ repo: 'ashlrai/phantom', pr: 10, id: 'RQ-REBASE-phantom-10-aaaaaaa', at: NOW - H }]);
  });
  it('returns [] on non-JSON and missing emitted map', () => {
    expect(parseQueuegenEmitted('not json')).toEqual([]);
    expect(parseQueuegenEmitted('{"v":1}')).toEqual([]);
  });
});

describe('parseQueueRows', () => {
  it('rewrites status-first PARKED rows so parked rebase jobs surface', () => {
    const rows = parseQueueRows(
      'PARKED-DEP.devin\tRQ-REBASE-phantom-2-aaaaaaa\tdevin\twork\tphantom\tprompts/x.md\n'
      + 'READY\tRQ-REBASE-phantom-3-bbbbbbb\tdevin\twork\tphantom\n',
    ).rows;
    expect(rows.map(r => [r.id, r.status])).toEqual([
      ['RQ-REBASE-phantom-2-aaaaaaa', 'PARKED-DEP.DEVIN'],
      ['RQ-REBASE-phantom-3-bbbbbbb', 'READY'],
    ]);
    expect(rows[0]!.repo).toBe('phantom');
  });
});

describe('buildMergeCockpit', () => {
  it('counts open conflicts, coverage, triage→close and merge rate per repo', () => {
    const report = buildMergeCockpit(input({
      queuegenStates: [stateFile({
        'ashlrai/phantom#10': { id: 'RQ-REBASE-phantom-10-aaaaaaa', at: NOW - 2 * H },
        'ashlrai/phantom#11': { id: 'RQ-REBASE-phantom-11-bbbbbbb', at: NOW - 5 * H },
        'ashlrai/phantom#13': { id: 'RQ-REBASE-phantom-13-ddddddd', at: NOW - H },
        'ashlrai/phantom#14': { id: 'RQ-FIXUP-phantom-14-eeeeeee', at: NOW - H }, // not a conflict
        'ashlrai/locus#3': { id: 'RQ-REBASE-locus-3-ccccccc', at: NOW - H },
      })],
      readyTsv: [
        'READY\tRQ-REBASE-phantom-10-aaaaaaa\tdevin\twork\tphantom',
        'PARKED-HOLD.devin\tRQ-REBASE-phantom-11-fffffff\tdevin\twork\tphantom\tprompts/r.md',
        'DONE\tRQ-REBASE-locus-3-ccccccc\tdevin\twork\tlocus',
      ].join('\n'),
      jobsJsonl: [
        jobRow({ event: 'enqueue', job: 'RQ-REBASE-locus-3-ccccccc', ts: iso(NOW - H) }),
        jobRow({ event: 'launch', job: 'RQ-REBASE-locus-3-ccccccc', ts: iso(NOW - H + 60_000) }),
        jobRow({ event: 'finish', job: 'RQ-REBASE-locus-3-ccccccc', ts: iso(NOW - 40 * 60_000) }),
        jobRow({ event: 'outcome', state: 'MERGED', job: 'RQ-PHX-77', url: 'https://github.com/ashlrai/locus/pull/3', ts: iso(NOW - 15 * 60_000), ttm_s: 2700 }),
        jobRow({ event: 'outcome', state: 'MERGED', job: 'RQ-PHX-78', prUrl: 'https://github.com/ashlrai/phantom/pull/99', ts: iso(NOW - 30 * 60_000), ttm_s: 1200 }),
        jobRow({ event: 'finish', job: 'RQ-OTHER-1', ts: iso(NOW - 10 * 60_000) }),
      ].join('\n'),
      landedClosesJsonl: jobRow({ at: iso(NOW - 30 * 60_000), pr: 10, outcome: 'closed' }),
    }));

    const phantom = report.repos.find(r => r.repo === 'ashlrai/phantom')!;
    // #11 parked on a stale head (fffffff != emitted bbbbbbb), #13 uncovered -> 2 open.
    expect(phantom.conflictsOpen).toBe(2);
    expect(phantom.conflictsTriaged).toBe(3); // #10, #11, #13 triaged in window — FIXUP excluded
    expect(phantom.conflictsClosed).toBe(1);  // #10 via landed-close
    expect(phantom.triageToCloseS).toEqual({ count: 1, medianS: 5400, p90S: 5400, maxS: 5400 });
    expect(phantom.coverage).toEqual({ current: 0, staleHead: 1, worked: 0, uncovered: 1 });
    expect(phantom.rebase).toEqual({ ready: 1, running: 0, parked: 1, spins: 2, runs: 0, repeatPrs: 0 });
    expect(phantom.merges).toEqual({ count: 1, perHour: 1 / 24, medianTtmS: 1200 });

    const locus = report.repos.find(r => r.repo === 'ashlrai/locus')!;
    expect(locus.conflictsOpen).toBe(0);
    expect(locus.conflictsClosed).toBe(1);
    expect(locus.triageToCloseS).toEqual({ count: 1, medianS: 2700, p90S: 2700, maxS: 2700 });
    expect(locus.rebase.runs).toBe(1);
    expect(locus.merges.count).toBe(1);

    expect(report.totals.conflictsOpen).toBe(2);
    expect(report.totals.triageToCloseS).toEqual({ count: 2, medianS: 2700, p90S: 5400, maxS: 5400 });
    expect(report.known).toBe(true);
  });

  it('marks head churn as repeat PRs and current-head coverage', () => {
    const report = buildMergeCockpit(input({
      queuegenStates: [stateFile({ 'ashlrai/phantom#5': { id: 'RQ-REBASE-phantom-5-aaaaaaa', at: NOW - 3 * H } })],
      readyTsv: [
        'READY\tRQ-REBASE-phantom-5-aaaaaaa\tdevin\twork\tphantom',
        'READY\tRQ-REBASE-phantom-5-bbbbbbb\tdevin\twork\tphantom',
      ].join('\n'),
    }));
    const phantom = report.repos.find(r => r.repo === 'ashlrai/phantom')!;
    expect(phantom.conflictsOpen).toBe(1);
    expect(phantom.coverage).toEqual({ current: 1, staleHead: 0, worked: 0, uncovered: 0 });
    expect(phantom.rebase).toMatchObject({ ready: 2, spins: 2, repeatPrs: 1 });
  });

  it('reports null coverage when the queue is unreadable', () => {
    const report = buildMergeCockpit(input({
      readyTsv: null, claimedTsv: null,
      sources: { ...SRC, ready: 'missing', claimed: 'missing' },
      queuegenStates: [stateFile({ 'ashlrai/phantom#5': { id: 'RQ-REBASE-phantom-5-aaaaaaa', at: NOW - H } })],
    }));
    expect(report.repos[0]!.coverage).toBeNull();
    expect(report.repos[0]!.conflictsOpen).toBe(1);
  });

  it('drops stale triage records with no close evidence and no live job', () => {
    const report = buildMergeCockpit(input({
      queuegenStates: [stateFile({ 'ashlrai/phantom#5': { id: 'RQ-REBASE-phantom-5-aaaaaaa', at: NOW - 30 * H } })],
    }));
    expect(report.repos.find(r => r.repo === 'ashlrai/phantom')!.conflictsOpen).toBe(0);
  });

  it('refuses to attribute rebase jobs when a short name collides across owners', () => {
    const report = buildMergeCockpit(input({
      queuegenStates: [stateFile({
        'ashlrai/phantom#5': { id: 'RQ-REBASE-phantom-5-aaaaaaa', at: NOW - H },
        'other/phantom#9': { id: 'RQ-REBASE-phantom-9-bbbbbbb', at: NOW - H },
      })],
      readyTsv: 'READY\tRQ-REBASE-phantom-7-ccccccc\tdevin\twork\n',
      jobsJsonl: jobRow({ event: 'launch', job: 'RQ-REBASE-phantom-8-ddddddd', ts: iso(NOW - H) }),
    }));
    const phantom = report.repos.find(r => r.repo === 'ashlrai/phantom')!;
    expect(phantom.conflictsOpen).toBe(1); // only the queuegen-triaged #5; queue row and launch stay unattributed
    expect(phantom.rebase).toMatchObject({ ready: 0, runs: 0, spins: 0 });
  });

  it('reads merge-events closes and conflicts', () => {
    const report = buildMergeCockpit(input({
      mergeEventsJsonl: [
        jobRow({ repo: 'ashlrai/phantom', pr: 20, type: 'conflict', at: iso(NOW - 4 * H) }),
        jobRow({ repo: 'ashlrai/phantom', pr: 20, type: 'closed', at: iso(NOW - H) }),
        jobRow({ repo: 'ashlrai/phantom', pr: 21, type: 'conflict', at: iso(NOW - 2 * H) }),
      ].join('\n'),
    }));
    const phantom = report.repos.find(r => r.repo === 'ashlrai/phantom')!;
    expect(phantom.conflictsOpen).toBe(1);
    expect(phantom.conflictsClosed).toBe(1);
    expect(phantom.triageToCloseS).toEqual({ count: 1, medianS: 3 * 3600, p90S: 3 * 3600, maxS: 3 * 3600 });
    expect(phantom.conflictsUntracked).toBe(0);
  });

  it('skips malformed ledger lines instead of throwing', () => {
    const report = buildMergeCockpit(input({
      queuegenStates: [stateFile({ 'ashlrai/phantom#5': { id: 'RQ-REBASE-phantom-5-aaaaaaa', at: NOW - H } })],
      jobsJsonl: ['{not json', '', jobRow({ event: 'outcome', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/42', ts: iso(NOW - H), ttm_s: 900 })].join('\n'),
      mergeEventsJsonl: '{oops\n' + jobRow({ repo: 'ashlrai/phantom', pr: 5, type: 'conflict', at: iso(NOW - 2 * H) }),
      landedClosesJsonl: '}{broken',
    }));
    const phantom = report.repos.find(r => r.repo === 'ashlrai/phantom')!;
    expect(phantom.conflictsOpen).toBe(1);
    expect(phantom.merges.count).toBe(1);
  });

  it('reports unknown when nothing is readable', () => {
    const report = buildMergeCockpit(input({
      sources: { ready: 'missing', claimed: 'missing', queuegenState: 'missing', jobs: 'missing', landedCloses: 'missing', mergeEvents: 'missing' },
    }));
    expect(report.known).toBe(false);
    expect(report.repos).toEqual([]);
  });
});

describe('readMergeCockpit', () => {
  it('projects a fixture runs dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merge-cockpit-'));
    try {
      await mkdir(join(root, 'queue'), { recursive: true });
      await mkdir(join(root, 'metrics'), { recursive: true });
      await writeFile(join(root, 'queue', 'router-queue.md.queuegen-state.json'), stateFile({
        'ashlrai/phantom#10': { id: 'RQ-REBASE-phantom-10-aaaaaaa', at: NOW - 2 * H },
      }));
      await writeFile(join(root, 'queue', 'ready.tsv'), 'READY\tRQ-REBASE-phantom-10-aaaaaaa\tdevin\twork\tphantom\n');
      await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${jobRow({ event: 'outcome', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/42', ts: iso(NOW - H), ttm_s: 900 })}\n`);
      const report = await readMergeCockpit({ runsDir: root, now: NOW });
      expect(report.known).toBe(true);
      expect(report.sources).toMatchObject({ ready: 'healthy', queuegenState: 'healthy', jobs: 'healthy', claimed: 'missing', mergeEvents: 'missing', landedCloses: 'missing' });
      const phantom = report.repos.find(r => r.repo === 'ashlrai/phantom')!;
      expect(phantom.conflictsOpen).toBe(1);
      expect(phantom.coverage).toEqual({ current: 1, staleHead: 0, worked: 0, uncovered: 0 });
      expect(phantom.merges.count).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports unknown on an empty runs dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merge-cockpit-empty-'));
    try {
      const report = await readMergeCockpit({ runsDir: root, now: NOW });
      expect(report.known).toBe(false);
      expect(report.repos).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('cmdFleetMergeCockpit', () => {
  it('prints help and validates flags', async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const out = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    const err = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
    try {
      expect(await cmdFleetMergeCockpit(['--help'])).toBe(0);
      expect(logs.at(-1)).toContain('Usage: phm fleet merge-cockpit');
      expect(await cmdFleetMergeCockpit(['--bogus'])).toBe(2);
      expect(await cmdFleetMergeCockpit(['--hours', '9999'])).toBe(2);
      expect(await cmdFleetMergeCockpit(['--root', 'relative/path'])).toBe(2);
    } finally { out.mockRestore(); err.mockRestore(); }
  });

  it('emits the report JSON', async () => {
    const logs: string[] = [];
    const out = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    try {
      const report = buildMergeCockpit(input({}));
      expect(await cmdFleetMergeCockpit(['--json'], { read: async () => report })).toBe(0);
      expect(JSON.parse(logs.at(-1)!).schema).toBe('fleet.merge-cockpit.v1');
    } finally { out.mockRestore(); }
  });
});
