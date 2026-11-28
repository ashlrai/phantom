import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutcomeRow } from '../src/core/fleet/eval-report.js';
import {
  IDEATION_OUTCOME_DIED_RECURRING,
  foldIdeationOutcomeCell,
  ideationOutcomeBacklogItems,
} from '../src/core/improve/ideation-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const NOW = Date.now();
const DAY = 24 * HOUR;

const row = (over: Partial<OutcomeRow>): OutcomeRow => ({
  state: 'CLOSED',
  atMs: NOW - 60 * MIN,
  ttmS: null,
  jobId: 'RQ-IDEA-A1',
  repo: null,
  mergeCommit: null,
  ...over,
});

describe('foldIdeationOutcomeCell', () => {
  const opts = { nowMs: NOW, windowHours: 168 };

  it('classifies proposals by the loop\'s own precedence and emits at the recurring-and-adverse bar', () => {
    const cell = foldIdeationOutcomeCell([
      row({ jobId: 'RQ-IDEA-D1', state: 'CLOSED' }),
      row({ jobId: 'RQ-IDEA-D2', state: 'DEAD' }),
      row({ jobId: 'RQ-IDEA-D3', state: 'CLOSED', repo: 'ashlrai/phantom' }),
      row({ jobId: 'RQ-IDEA-M1', state: 'MERGED', repo: 'ashlrai/phantom' }),
      row({ jobId: 'RQ-IDEA-U1', state: 'OPEN' }),
      // Same proposal with a later MERGED row: any MERGED wins.
      row({ jobId: 'RQ-IDEA-M2', state: 'CLOSED' }),
      row({ jobId: 'RQ-IDEA-M2', state: 'MERGED', atMs: NOW - 30 * MIN }),
      // Not all terminal-non-merge: stays unresolved.
      row({ jobId: 'RQ-IDEA-U2', state: 'CLOSED' }),
      row({ jobId: 'RQ-IDEA-U2', state: 'OPEN', atMs: NOW - 20 * MIN }),
    ], opts);
    expect(cell).not.toBeNull();
    expect(cell).toMatchObject({ merged: 2, died: 3, unresolved: 2 });
    // byRepo groups by label, not per proposal: the 'unknown' rows merge into one tally,
    // and it sorts first on died count.
    expect(cell!.byRepo).toEqual([
      { repo: 'unknown', merged: 1, died: 2, unresolved: 2 },
      { repo: 'ashlrai/phantom', merged: 1, died: 1, unresolved: 0 },
    ]);
    // Died proposals quote first (the adverse evidence), then the rest by recency.
    expect(cell!.examples.map((e) => e.id)).toEqual([
      'RQ-IDEA-D1', 'RQ-IDEA-D2', 'RQ-IDEA-D3', 'RQ-IDEA-U2', 'RQ-IDEA-M2',
    ]);
  });

  it('never emits when deaths do not outnumber merges or stay under the recurring bar', () => {
    expect(IDEATION_OUTCOME_DIED_RECURRING).toBe(3);
    // Three died but three merged: not adverse.
    expect(foldIdeationOutcomeCell([
      row({ jobId: 'RQ-IDEA-D1' }), row({ jobId: 'RQ-IDEA-D2' }), row({ jobId: 'RQ-IDEA-D3' }),
      row({ jobId: 'RQ-IDEA-M1', state: 'MERGED' }), row({ jobId: 'RQ-IDEA-M2', state: 'MERGED' }), row({ jobId: 'RQ-IDEA-M3', state: 'MERGED' }),
    ], opts)).toBeNull();
    // Two died: under the recurring bar.
    expect(foldIdeationOutcomeCell([
      row({ jobId: 'RQ-IDEA-D1' }), row({ jobId: 'RQ-IDEA-D2' }),
      row({ jobId: 'RQ-IDEA-M1', state: 'MERGED' }),
    ], opts)).toBeNull();
    // Died equal to merged is not adverse (3 vs 3 covered above; 4 vs 4 too).
    expect(foldIdeationOutcomeCell([
      ...['D1', 'D2', 'D3', 'D4'].map((id) => row({ jobId: `RQ-IDEA-${id}` })),
      ...['M1', 'M2', 'M3', 'M4'].map((id) => row({ jobId: `RQ-IDEA-${id}`, state: 'MERGED' })),
    ], opts)).toBeNull();
  });

  it('ignores outcomes outside the window, past the future skew, without timestamps, and non-proposal ids', () => {
    expect(foldIdeationOutcomeCell([
      row({ jobId: 'RQ-IDEA-OLD1', atMs: NOW - 8 * DAY }),
      row({ jobId: 'RQ-IDEA-OLD2', atMs: NOW - 8 * DAY }),
      row({ jobId: 'RQ-IDEA-OLD3', atMs: NOW - 8 * DAY }),
      row({ jobId: 'RQ-IDEA-FUT1', atMs: NOW + 2 * MIN }),
      row({ jobId: 'RQ-IDEA-FUT2', atMs: NOW + 2 * MIN }),
      row({ jobId: 'RQ-IDEA-FUT3', atMs: NOW + 2 * MIN }),
      row({ jobId: 'RQ-IDEA-NULL1', atMs: null }),
      row({ jobId: 'RQ-IDEA-NULL2', atMs: null }),
      row({ jobId: 'RQ-IDEA-NULL3', atMs: null }),
      row({ jobId: 'RQ-BETS-1' }), row({ jobId: 'RQ-BETS-2' }), row({ jobId: 'RQ-BETS-3' }),
      row({ jobId: 'RQ-IDEATION-20261114' }), row({ jobId: 'RQ-IDEATION-20261115' }), row({ jobId: 'RQ-IDEATION-20261116' }),
      row({ jobId: 'ordinary-job' }), row({ jobId: 'another-job' }), row({ jobId: null }),
    ], opts)).toBeNull();
    // Inside the one-minute skew the stamp still counts as same-host drift.
    const cell = foldIdeationOutcomeCell([
      row({ jobId: 'RQ-IDEA-S1', atMs: NOW - 30 * 1000 }),
      row({ jobId: 'RQ-IDEA-S2', atMs: NOW - 20 * 1000 }),
      row({ jobId: 'RQ-IDEA-S3', atMs: NOW - 10 * 1000 }),
    ], opts);
    expect(cell).toMatchObject({ died: 3, merged: 0, unresolved: 0 });
  });
});

describe('ideationOutcomeBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'ideation-outcome-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding metrics/jobs.jsonl. */
  async function runsDir(name: string, ledger: string[] | null | undefined): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (ledger !== undefined && ledger !== null) {
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger.join('\n') + '\n');
    }
    return dir;
  }

  /** An outcome row in the jobs.jsonl dialect foldJobsLedger reads. */
  const outcome = (job: string, state: string, minsAgo: number, extra: Record<string, unknown> = {}): string => J({
    job, event: 'outcome', state, ts: new Date(NOW - minsAgo * MIN).toISOString(), ...extra,
  });
  const merged = (job: string, minsAgo: number, pr = 100): string => outcome(job, 'MERGED', minsAgo, {
    mergedAt: new Date(NOW - minsAgo * MIN).toISOString(),
    url: `https://github.com/ashlrai/phantom/pull/${pr}`,
    repo: 'ashlrai/phantom',
  });
  const PR_URLS = [101, 102, 103, 104, 105, 106];

  it('emits an ideation-outcomes item for a died-dominant proposal mix and validates it', async () => {
    const dir = await runsDir('runs-died', [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 5),
      outcome('RQ-IDEA-D2', 'DEAD', 60 * 24 * 4),
      outcome('RQ-IDEA-D3', 'CLOSED', 60 * 24 * 3, { repo: 'ashlrai/phantom' }),
      merged('RQ-IDEA-M1', 60 * 24 * 2, PR_URLS[0]),
      outcome('RQ-IDEA-U1', 'OPEN', 60 * 5),
      outcome('RQ-IDEA-U2', 'CLOSED', 60 * 4),
      outcome('RQ-IDEA-U2', 'OPEN', 60 * 3),
      merged('RQ-IDEA-M2', 60 * 24, PR_URLS[1]),
    ]);
    const items = await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'ideation-outcomes' });
    expect(item!.id).toMatch(/^ideation-outcome-[0-9a-f]{16}$/);
    expect(item!.title).toContain('ideation');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('3 recorded RQ-IDEA proposals resolved to a terminal non-merge');
    expect(item!.prompt).toContain('2 merged');
    expect(item!.prompt).toContain('RQ-IDEA-D1');
    expect(item!.prompt).toContain('jobs.jsonl');
    expect(item!.prompt).toContain('foldJobsLedger');
    expect(item!.prompt).toContain('phm fleet ideation tick');
    expect(item!.prompt).toContain('unresolved');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits nothing below the recurring-and-adverse bar, for a missing ledger, or another repository', async () => {
    const balanced = await runsDir('runs-balanced', [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 3),
      outcome('RQ-IDEA-D2', 'CLOSED', 60 * 24 * 2),
      outcome('RQ-IDEA-D3', 'CLOSED', 60 * 24),
      merged('RQ-IDEA-M1', 60 * 20, PR_URLS[2]),
      merged('RQ-IDEA-M2', 60 * 19, PR_URLS[3]),
      merged('RQ-IDEA-M3', 60 * 18, PR_URLS[4]),
    ]);
    expect(await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: balanced, now: new Date(NOW) })).toEqual([]);

    const quiet = await runsDir('runs-quiet', [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 2),
      merged('RQ-IDEA-M1', 60 * 20, PR_URLS[5]),
    ]);
    expect(await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    expect(await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);
    const empty = await runsDir('runs-empty', null);
    expect(await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 3),
      outcome('RQ-IDEA-D2', 'CLOSED', 60 * 24 * 2),
      outcome('RQ-IDEA-D3', 'CLOSED', 60 * 24),
      merged('RQ-IDEA-M1', 60 * 20, PR_URLS[0]),
    ]);
    expect(await ideationOutcomeBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await ideationOutcomeBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('ignores outcomes outside the window and in-flight-only proposals', async () => {
    const dir = await runsDir('runs-window', [
      outcome('RQ-IDEA-OLD1', 'CLOSED', 60 * 24 * 8),
      outcome('RQ-IDEA-OLD2', 'CLOSED', 60 * 24 * 8),
      outcome('RQ-IDEA-OLD3', 'CLOSED', 60 * 24 * 8),
      outcome('RQ-IDEA-IN1', 'OPEN', 60 * 5),
      outcome('RQ-IDEA-IN2', 'OPEN', 60 * 4),
      outcome('RQ-IDEA-IN3', 'OPEN', 60 * 3),
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 2),
      outcome('RQ-IDEA-D2', 'CLOSED', 60 * 24),
      outcome('RQ-IDEA-M1', 'MERGED', 60 * 20, { mergedAt: new Date(NOW - 60 * 20 * MIN).toISOString(), url: 'https://github.com/ashlrai/phantom/pull/200' }),
    ]);
    // Only two in-window deaths — under the bar; OPEN-only proposals are unresolved context.
    expect(await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('states counts as recorded floors when the fold ignored rows', async () => {
    const dir = await runsDir('runs-partial', [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 3),
      'not json at all',
      outcome('RQ-IDEA-D2', 'CLOSED', 60 * 24 * 2),
      outcome('RQ-IDEA-D3', 'CLOSED', 60 * 24),
      merged('RQ-IDEA-M1', 60 * 20, PR_URLS[0]),
    ]);
    const items = await ideationOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 3 recorded RQ-IDEA proposals');
  });

  it('derives a stable id so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 3),
      outcome('RQ-IDEA-D2', 'CLOSED', 60 * 24 * 2),
      outcome('RQ-IDEA-D3', 'CLOSED', 60 * 24),
      merged('RQ-IDEA-M1', 60 * 20, PR_URLS[0]),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await ideationOutcomeBacklogItems(opts);
    const second = await ideationOutcomeBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
    expect(await ideationOutcomeBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends the ideation-outcome item through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      outcome('RQ-IDEA-D1', 'CLOSED', 60 * 24 * 3),
      outcome('RQ-IDEA-D2', 'CLOSED', 60 * 24 * 2),
      outcome('RQ-IDEA-D3', 'CLOSED', 60 * 24),
      merged('RQ-IDEA-M1', 60 * 20, PR_URLS[0]),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const ideaItems = first.items.filter((i) => i.id.startsWith('ideation-outcome-'));
    expect(ideaItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(ideaItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('ideation-outcome-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('ideation-outcome-'))).toHaveLength(1);
  });
});
