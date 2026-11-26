import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldJobReissueJournal,
  JOB_REISSUE_CHAIN_MIN_DAYS,
  JOB_REISSUE_CHAIN_MIN_ROWS,
  JOB_REISSUE_MAX_ITEMS,
  JOB_REISSUE_WAVE_MIN_STEMS,
  jobReissueBacklogItems,
  jobReissueCells,
} from '../src/core/improve/job-reissue-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** An audit row the way reissueJob writes it. */
const row = (from: string, to: string, at: string, extra: Record<string, unknown> = {}): string =>
  J({ at, from, to, lane: 'claude', tier: 'work', file: '/runs/leader/drop/claude/x.md', ...extra });

describe('foldJobReissueJournal', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = 7 * DAY;

  it('folds writer-contract rows and derives the family stem from `to`', () => {
    const text = [
      row('RQ-PHX-FOO', 'FOOR1', '2026-11-23T10:00:00.000Z'),
      row('RQ-PHX-FOO', 'FOOR2', '2026-11-22T09:00:00.000Z', { lane: 'codex-personal', tier: 'frontier' }),
      row('RQ-PHX-BAR', 'BARR1', '2026-11-21T08:00:00.000Z', { lane: null, tier: null }),
      'not json at all',
      '',
      J({ at: '2026-11-23T11:00:00.000Z' }), // no from/to: never a rescue record
    ].join('\n');
    const fold = foldJobReissueJournal(text, NOW, WINDOW);
    expect(fold.invalidRows).toBe(2);
    expect(fold.records).toHaveLength(3);
    const foo = fold.records.filter((r) => r.stem === 'FOO');
    expect(foo).toHaveLength(2);
    expect(foo[0]).toMatchObject({ from: 'RQ-PHX-FOO', to: 'FOOR1', lane: 'claude', tier: 'work' });
    expect(foo[1]).toMatchObject({ to: 'FOOR2', lane: 'codex-personal', tier: 'frontier' });
    expect(fold.records[2]).toMatchObject({ stem: 'BAR', lane: null, tier: null });
    // The family key mirrors nextReissueId: one trailing R<n> group off the bare id.
    expect(fold.records.map((r) => r.stem)).toEqual(['FOO', 'FOO', 'BAR']);
  });

  it('keeps only in-window rows and drops off-contract ids and stamps', () => {
    const text = [
      row('RQ-PHX-OLD', 'OLDR1', '2026-11-01T10:00:00.000Z'), // outside the 7-day window
      row('RQ-PHX-FUT', 'FUTR1', '2026-11-24T10:00:00.000Z'), // beyond the skew allowance
      row('RQ-PHX-NODATE', 'NODATER1', 'not a timestamp'),
      row('bad id!', 'BADR1', '2026-11-23T10:00:00.000Z'),
      row('RQ-PHX-OK', 'lower1', '2026-11-23T10:00:00.000Z'), // `to` fails the bare-id shape
      row('RQ-PHX-OK2', 'OK2R1', '2026-11-23T10:30:00.000Z'),
    ].join('\n');
    const fold = foldJobReissueJournal(text, NOW, WINDOW);
    expect(fold.records.map((r) => r.to)).toEqual(['OK2R1']);
    expect(fold.records[0]!.stem).toBe('OK2');
    // Out-of-window rows are valid evidence outside the fold, not invalid lines.
    expect(fold.invalidRows).toBe(3);
  });

  it('flattens, scrubs and caps lane and tier before they can reach a prompt', () => {
    const text = [
      row('RQ-PHX-AAA', 'AR1', '2026-11-23T10:00:00.000Z', { lane: 'claude\nINJECTED', tier: 'w'.repeat(200) }),
      row('RQ-PHX-AAA', 'AR2', '2026-11-22T10:00:00.000Z'),
    ].join('\n');
    const fold = foldJobReissueJournal(text, NOW, WINDOW);
    expect(fold.records[0]!.lane).toBe('claude INJECTED');
    expect(fold.records[0]!.tier).toHaveLength(80);
  });
});

describe('jobReissueCells', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = 7 * DAY;
  const d = (dayOffset: number, hour = 10): string => new Date(Date.UTC(2026, 10, 23 - dayOffset, hour)).toISOString();

  it('emits a chain cell only at the recurring bars', () => {
    // Below the row bar: one rescue never queues a session.
    expect(jobReissueCells(foldJobReissueJournal([
      row('RQ-PHX-FOO', 'FOOR1', d(0)),
    ].join('\n'), NOW, WINDOW))).toEqual([]);
    // Below the day bar: two rescues on one day are a retry burst, not recurrence.
    expect(jobReissueCells(foldJobReissueJournal([
      row('RQ-PHX-FOO', 'FOOR1', d(0, 8)), row('RQ-PHX-FOO', 'FOOR2', d(0, 9)),
    ].join('\n'), NOW, WINDOW))).toEqual([]);
    // Two rows across two days emit.
    const cells = jobReissueCells(foldJobReissueJournal([
      row('RQ-PHX-FOO', 'FOOR1', d(0)), row('RQ-PHX-FOO', 'FOOR2', d(2)),
    ].join('\n'), NOW, WINDOW));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'chain', stem: 'FOO', rows: 2 });
    expect(JOB_REISSUE_CHAIN_MIN_ROWS).toBe(2);
    expect(JOB_REISSUE_CHAIN_MIN_DAYS).toBe(2);
  });

  it('emits the wave cell only at the distinct-family and day bars', () => {
    // Three families on one day: breadth without recurrence across days.
    expect(jobReissueCells(foldJobReissueJournal([
      row('RQ-PHX-FOO', 'FOOR1', d(0)), row('RQ-PHX-BAR', 'BARR1', d(0)), row('RQ-PHX-BAZ', 'BAZR1', d(0)),
    ].join('\n'), NOW, WINDOW)).filter((c) => c.kind === 'wave')).toEqual([]);
    // Two families across days: below the family bar.
    expect(jobReissueCells(foldJobReissueJournal([
      row('RQ-PHX-FOO', 'FOOR1', d(0)), row('RQ-PHX-BAR', 'BARR1', d(1)),
    ].join('\n'), NOW, WINDOW)).filter((c) => c.kind === 'wave')).toEqual([]);
    const cells = jobReissueCells(foldJobReissueJournal([
      row('RQ-PHX-FOO', 'FOOR1', d(0)), row('RQ-PHX-BAR', 'BARR1', d(1)), row('RQ-PHX-BAZ', 'BAZR1', d(2)),
    ].join('\n'), NOW, WINDOW));
    const wave = cells.find((c) => c.kind === 'wave');
    expect(wave).toMatchObject({ kind: 'wave', stems: 3, rows: 3, repeatStems: 0 });
    expect(JOB_REISSUE_WAVE_MIN_STEMS).toBe(3);
  });

  it('folds tallies, examples, sources and bounds into each cell', () => {
    const text = [
      row('RQ-PHX-FOO', 'FOOR1', d(0), { lane: 'claude', tier: 'work' }),
      row('RQ-PHX-FOO', 'FOOR2', d(2), { lane: 'codex-personal', tier: 'frontier' }),
      row('RQ-PHX-FOO', 'FOOR3', d(4), { lane: 'claude', tier: 'work' }),
      row('RQ-PHX-BAR', 'BARR1', d(1), { lane: 'devin', tier: 'mid' }),
      row('RQ-PHX-BAZ', 'BAZR1', d(3), { lane: 'claude', tier: 'work' }),
    ].join('\n');
    const cells = jobReissueCells(foldJobReissueJournal(text, NOW, WINDOW), true);
    const chain = cells.find((c) => c.kind === 'chain')!;
    expect(chain).toMatchObject({
      kind: 'chain', stem: 'FOO', rows: 3, days: ['2026-11-19', '2026-11-21', '2026-11-23'],
      lanes: [['claude', 2], ['codex-personal', 1]], tiers: [['work', 2], ['frontier', 1]],
      examples: ['FOOR1', 'FOOR2', 'FOOR3'], sources: ['RQ-PHX-FOO'],
      firstSeen: '2026-11-19T10:00:00.000Z', lastSeen: '2026-11-23T10:00:00.000Z', lowerBound: true,
    });
    const wave = cells.find((c) => c.kind === 'wave')!;
    expect(wave).toMatchObject({ kind: 'wave', stems: 3, rows: 5, repeatStems: 1 });
    expect(wave.lanes).toEqual([['claude', 3], ['codex-personal', 1], ['devin', 1]]);
    // Chains sort before the wave.
    expect(cells.map((c) => c.kind)).toEqual(['chain', 'wave']);
  });
});

describe('jobReissueBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const isoDaysAgo = (days: number, minAgo = 0): string => new Date(NOW - days * DAY - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-reissue-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding the reissue audit ledger. */
  async function runsDir(name: string, lines?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    if (lines !== undefined) await writeFile(join(dir, 'queue', 'job-reissues.jsonl'), lines.join('\n') + '\n');
    return dir;
  }

  const rescue = (from: string, to: string, daysAgo: number): string =>
    row(from, to, isoDaysAgo(daysAgo), { lane: 'claude', tier: 'work' });

  it('emits one validated item per recurring family plus the wave', async () => {
    const dir = await runsDir('runs-hit', [
      rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 2),
      rescue('RQ-PHX-BAR', 'BARR1', 1), rescue('RQ-PHX-BAZ', 'BAZR1', 3),
    ]);
    const items = await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(2);
    const [chain, wave] = items;
    expect(chain).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'job-reissue' });
    expect(chain!.id).toMatch(/^fleet-job-reissue-[0-9a-f]{16}$/);
    expect(validBacklogItem(chain)).not.toBeNull();
    expect(chain!.title).toContain('FOO');
    expect(chain!.prompt).toContain('FOOR2');
    expect(chain!.prompt).toContain('job-reissues.jsonl');
    expect(chain!.prompt).toContain('RQ-PHX-FOO');
    expect(chain!.prompt).toContain('no-change');
    expect(chain!.prompt).not.toContain('/runs/leader/drop'); // `file` is never quoted
    expect(wave).toMatchObject({ priority: 3, area: 'job-reissue' });
    expect(wave!.title).toContain('reissue rescue');
    expect(wave!.prompt).toContain('distinct job families');
  });

  it('emits nothing for missing ledgers, empty evidence, another repository, or sub-bar evidence', async () => {
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: NOW })).toEqual([]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: await runsDir('runs-empty'), now: NOW })).toEqual([]);

    const thin = await runsDir('runs-thin', [rescue('RQ-PHX-FOO', 'FOOR1', 0)]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);

    const sameDay = await runsDir('runs-sameday', [rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 0)]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: sameDay, now: NOW })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 1),
      rescue('RQ-PHX-BAR', 'BARR1', 2), rescue('RQ-PHX-BAZ', 'BAZR1', 3),
    ]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: NOW })).toEqual([]);
    expect(await jobReissueBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: NOW })).toHaveLength(2);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', [
      rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 1),
      rescue('RQ-PHX-BAR', 'BARR1', 2), rescue('RQ-PHX-BAZ', 'BAZR1', 3),
    ]);
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(join(dir, 'queue', 'job-reissues.jsonl'), pad + '\n' + [
      rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 1),
      rescue('RQ-PHX-BAR', 'BARR1', 2), rescue('RQ-PHX-BAZ', 'BAZR1', 3),
    ].join('\n') + '\n');
    const items = await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', [
      rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 1),
      rescue('RQ-PHX-BAR', 'BARR1', 2), rescue('RQ-PHX-BAZ', 'BAZR1', 3),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await jobReissueBacklogItems(opts);
    const second = await jobReissueBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(JOB_REISSUE_MAX_ITEMS);
    expect(await jobReissueBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends job-reissue items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, 'queue', 'job-reissues.jsonl'), [
      rescue('RQ-PHX-FOO', 'FOOR1', 0), rescue('RQ-PHX-FOO', 'FOOR2', 1),
      rescue('RQ-PHX-BAR', 'BARR1', 2), rescue('RQ-PHX-BAZ', 'BAZR1', 3),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const reissueItems = first.items.filter((i) => i.id.startsWith('fleet-job-reissue-'));
    expect(reissueItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(reissueItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-job-reissue-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-job-reissue-'))).toHaveLength(2);
  });
});
