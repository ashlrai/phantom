import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldPickJobOutcomes,
  foldSelectorPicks,
  parseQueueV1Jobs,
  parseSelectorPicks,
  pickState,
  selectorPicksBacklogItems,
  type PickJobTally,
  type QueueEvidence,
  type SelectorPickRow,
} from '../src/core/improve/selector-picks-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-selector-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

// Real now: discoverBacklog stamps its own `new Date()`, so fixtures must be
// relative to the clock the code under test actually reads.
const NOW = new Date();
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;
/** Past the 48h settle bound with margin — the youngest age a settled pick may carry. */
const SETTLED_MS = 2 * DAY + 3600_000;
const iso = (msAgo: number): string => new Date(NOW_MS - msAgo).toISOString();

const REPO = 'ashlrai/phantom';

/** A runs dir with the selector/queue/metrics layout the fold reads. */
function runsDir(): string {
  const dir = path.join(home, 'runs');
  fs.mkdirSync(path.join(dir, 'selector'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
  return dir;
}

function writePicks(dir: string, rows: unknown[]): void {
  fs.writeFileSync(path.join(dir, 'selector', 'picks.jsonl'),
    rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

function pickRow(id: string, msAgo: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: iso(msAgo), rank: 1, id, repo: 'phantom', jobType: 'work',
    score: 1.5, predictedValue: 0.75, mergeRate: 0.5, minutes: 30, usage: 0.3,
    basis: 'learned', ...over,
  };
}

function writeReady(dir: string, rows: string[]): void {
  fs.writeFileSync(path.join(dir, 'queue', 'ready.tsv'), rows.join('\n') + '\n');
}
const readyRow = (id: string, lane = 'claude'): string => `${id}\tphantom\t${lane}\twork\t${dir0}/prompts/${id}.md`;
let dir0 = '';

function writeDropped(dir: string, ids: string[]): void {
  fs.writeFileSync(path.join(dir, 'queue', 'dropped.tsv'), ids.map((id) => readyRow(id)).join('\n') + '\n');
}

function writeRouterQueue(dir: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, 'queue', 'router-queue.md'), lines.join('\n') + '\n');
}

function writeQueueV1(dir: string, jobs: Array<{ id: string; status?: string }>): void {
  fs.writeFileSync(path.join(dir, 'queue', 'queue.v1.json'),
    JSON.stringify({ schema: 'queue.v1', jobs: jobs.map((j) => ({ id: j.id, status: j.status ?? 'READY', repo: 'phantom' })) }));
}

function writeJobs(dir: string, rows: unknown[]): void {
  fs.writeFileSync(path.join(dir, 'metrics', 'jobs.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Three never-proposed picks for one repo across two UTC days. */
function neverProposedFixture(dir: string): void {
  writePicks(dir, [
    pickRow('RQ-SEL-1', 3 * DAY),
    pickRow('RQ-SEL-2', 2 * DAY),
    pickRow('RQ-SEL-3', SETTLED_MS, { repo: 'phantom', jobType: 'friction' }),
    // Pending and healthy context that must not emit.
    pickRow('RQ-SEL-4', 3600_000),
    pickRow('RQ-SEL-5', 8 * DAY),
  ]);
}

const emptyEvidence = (): QueueEvidence => ({
  marketLive: new Set(), marketDropped: new Set(), proposed: new Set(),
  readyLive: new Set(), readyParked: new Set(), dropped: new Set(), degraded: false,
});

const pick = (id: string, msAgo: number, over: Partial<SelectorPickRow> = {}): SelectorPickRow => ({
  atMs: NOW_MS - msAgo, utcDay: new Date(NOW_MS - msAgo).toISOString().slice(0, 10),
  id, repo: 'phantom', jobType: 'work', mergeRate: 0.5, predictedValue: 0.75, ...over,
});

describe('parseSelectorPicks', () => {
  it('parses valid rows and drops malformed or duplicate ids', () => {
    const { picks, skipped } = parseSelectorPicks([
      JSON.stringify(pickRow('RQ-OK-1', SETTLED_MS)),
      'not json',
      JSON.stringify({ at: 'nope', id: 'RQ-BAD-1', repo: 'phantom', jobType: 'work' }),
      JSON.stringify(pickRow('bad id!', SETTLED_MS)),
      JSON.stringify(pickRow('RQ-OK-1', 2 * DAY)), // duplicate id: first wins
      JSON.stringify({ ...pickRow('RQ-OK-2', SETTLED_MS), repo: '' }),
      JSON.stringify(pickRow('RQ-OK-3', DAY, { mergeRate: 'not-a-number' })),
    ].join('\n'));
    expect(picks.map((p) => p.id)).toEqual(['RQ-OK-1', 'RQ-OK-3']);
    expect(picks[0]!.atMs).toBe(NOW_MS - SETTLED_MS);
    expect(picks[1]!.mergeRate).toBeNull();
    expect(skipped).toBe(5);
  });
});

describe('parseQueueV1Jobs', () => {
  it('maps job ids to statuses and returns null on invalid JSON', () => {
    const map = parseQueueV1Jobs(JSON.stringify({ jobs: [{ id: 'RQ-A-1', status: 'READY' }, { id: 'RQ-B-2', status: 'DROPPED' }, { nope: true }] }));
    expect(map?.get('RQ-A-1')).toBe('READY');
    expect(map?.get('RQ-B-2')).toBe('DROPPED');
    expect(map?.size).toBe(2);
    expect(parseQueueV1Jobs('{oops')).toBeNull();
    expect(parseQueueV1Jobs('[]')).toBeNull();
    expect(parseQueueV1Jobs('{}')?.size).toBe(0);
  });
});

describe('foldPickJobOutcomes', () => {
  it('tallies launch, finish, publish and outcome rows for pick ids only', () => {
    const tallies = foldPickJobOutcomes([
      { job: 'RQ-A-1', event: 'launch', ts: iso(3 * DAY) },
      { job: 'RQ-A-1', event: 'finish', empty: true, ts: iso(2 * DAY) },
      { job: 'RQ-B-2', event: 'launch', ts: iso(3 * DAY) },
      { job: 'RQ-B-2', event: 'finish', ts: iso(2 * DAY) },
      { job: 'RQ-B-2', event: 'publish', class: 'pr', prUrl: 'https://x/1', ts: iso(DAY) },
      { job: 'RQ-C-3', event: 'launch', ts: iso(3 * DAY) },
      { job: 'RQ-C-3', event: 'finish', ts: iso(2 * DAY) },
      { job: 'RQ-C-3', event: 'outcome', phase: 'MERGED', ts: iso(DAY) },
      { job: 'RQ-OTHER', event: 'launch', ts: iso(3 * DAY) },
      { job: 'RQ-A-1', event: 'launch', ts: iso(30 * DAY) }, // outside window
    ].map((r) => JSON.stringify(r)).join('\n'), new Set(['RQ-A-1', 'RQ-B-2', 'RQ-C-3']), NOW_MS);
    expect(tallies.get('RQ-A-1')).toMatchObject({ launches: 1, finishes: 1, finishEmpty: 1 });
    expect(tallies.get('RQ-B-2')).toMatchObject({ launches: 1, finishes: 1, prs: 1 });
    expect(tallies.get('RQ-C-3')).toMatchObject({ launches: 1, finishes: 1, merged: 1 });
    expect(tallies.has('RQ-OTHER')).toBe(false);
  });
});

describe('pickState', () => {
  const ev = emptyEvidence();
  const tally = (over: Partial<PickJobTally>): PickJobTally => ({
    launches: 0, finishes: 0, finishEmpty: 0, prs: 0, publishEmpty: 0,
    aborts: 0, merged: 0, closed: 0, openPhases: 0, resolvedOther: 0, ...over,
  });

  it('classifies jobs-ledger outcomes before queue evidence', () => {
    expect(pickState(pick('RQ-1', 3 * DAY), tally({ merged: 1 }), ev)).toBe('merged');
    expect(pickState(pick('RQ-2', 3 * DAY), tally({ launches: 1 }), ev)).toBe('in-flight');
    expect(pickState(pick('RQ-3', 3 * DAY), tally({ launches: 1, finishes: 1, prs: 1 }), ev)).toBe('in-flight');
    expect(pickState(pick('RQ-4', 3 * DAY), tally({ launches: 1, finishes: 1, closed: 1 }), ev)).toBe('unmerged');
    expect(pickState(pick('RQ-5', 3 * DAY), tally({ launches: 1, finishes: 1, finishEmpty: 1 }), ev)).toBe('empty');
    expect(pickState(pick('RQ-6', 3 * DAY), tally({ launches: 1, publishEmpty: 1 }), ev)).toBe('empty');
    expect(pickState(pick('RQ-7', 3 * DAY), tally({ launches: 1, finishes: 2, finishEmpty: 1 }), ev)).toBe('unmerged');
  });

  it('classifies queue-side evidence when no job rows exist', () => {
    const withDrop = { ...ev, dropped: new Set(['RQ-D-1']) };
    expect(pickState(pick('RQ-D-1', 3 * DAY), undefined, withDrop)).toBe('dropped');
    const withMarketDrop = { ...ev, marketDropped: new Set(['RQ-M-1']) };
    expect(pickState(pick('RQ-M-1', 3 * DAY), undefined, withMarketDrop)).toBe('dropped');
    const withMarket = { ...ev, marketLive: new Set(['RQ-Q-1']) };
    expect(pickState(pick('RQ-Q-1', 3 * DAY), undefined, withMarket)).toBe('marketed');
    const withProposal = { ...ev, proposed: new Set(['RQ-P-1']) };
    expect(pickState(pick('RQ-P-1', 3 * DAY), undefined, withProposal)).toBe('proposed');
    const withReady = { ...ev, readyLive: new Set(['RQ-R-1']), readyParked: new Set(['RQ-R-2']) };
    expect(pickState(pick('RQ-R-1', 3 * DAY), undefined, withReady)).toBe('queued');
    expect(pickState(pick('RQ-R-2', 3 * DAY), undefined, withReady)).toBe('parked');
    expect(pickState(pick('RQ-N-1', 3 * DAY), undefined, ev)).toBe('never-proposed');
    expect(pickState(pick('RQ-N-2', 3 * DAY), undefined, { ...ev, degraded: true })).toBe('unknown');
  });
});

describe('foldSelectorPicks', () => {
  it('counts settled picks per cell and skips pending/out-of-window', () => {
    const picks = [
      pick('RQ-N-1', 3 * DAY), pick('RQ-N-2', 2 * DAY), pick('RQ-N-3', SETTLED_MS),
      pick('RQ-P-1', 3600_000), pick('RQ-O-1', 9 * DAY),
    ];
    const fold = foldSelectorPicks(picks, new Map(), emptyEvidence(), NOW_MS);
    expect(fold.neverProposed.get('phantom')?.picks).toBe(3);
    expect(fold.pending).toBe(1);
    expect(fold.outOfWindow).toBe(1);
    expect(fold.settled).toBe(3);
  });
});

describe('selectorPicksBacklogItems', () => {
  it('emits a never-proposed item for funded picks with no queue or job evidence', async () => {
    const dir = runsDir();
    neverProposedFixture(dir);
    const items = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^selectorpick-never-proposed-/);
    expect(items[0]!.area).toBe('selector-picks');
    expect(items[0]!.priority).toBe(3);
    expect(items[0]!.prompt).toContain('RQ-SEL-1');
    expect(items[0]!.prompt).toContain('never reach the queue');
    expect(items[0]!.prompt).toContain('fundedIds');
  });

  it('does not emit when picks reached the queue via any evidence source', async () => {
    const dir = runsDir();
    writePicks(dir, [
      pickRow('RQ-PROP-1', 3 * DAY), pickRow('RQ-PROP-2', 2 * DAY), pickRow('RQ-PROP-3', SETTLED_MS),
      pickRow('RQ-READY-1', 3 * DAY), pickRow('RQ-READY-2', 2 * DAY), pickRow('RQ-READY-3', SETTLED_MS),
      pickRow('RQ-MKT-1', 3 * DAY), pickRow('RQ-MKT-2', 2 * DAY), pickRow('RQ-MKT-3', SETTLED_MS),
      pickRow('RQ-PRK-1', 3 * DAY), pickRow('RQ-PRK-2', 2 * DAY), pickRow('RQ-PRK-3', SETTLED_MS),
    ]);
    dir0 = dir;
    writeRouterQueue(dir, ['# queue', '- READY RQ-PROP-1 (P2, pool=claude, tier=work, repo=phantom): do prop work', '- CLAIMED RQ-PROP-2 (P2): x', 'prose mentioning RQ-PROP-3']);
    writeReady(dir, [readyRow('RQ-READY-1'), 'RQ-READY-2\tphantom\tPARKED-BYHAND.codex\twork\t/x.md']);
    writeQueueV1(dir, [{ id: 'RQ-MKT-1' }, { id: 'RQ-MKT-2', status: 'CLAIMED' }, { id: 'RQ-MKT-3', status: 'DONE' }]);
    // RQ-PRK-* sit on parked ready rows only.
    writeReady(dir, [...fs.readFileSync(path.join(dir, 'queue', 'ready.tsv'), 'utf8').trim().split('\n'),
      'RQ-PRK-1\tphantom\tPARKED-BYHAND.codex\twork\t/x.md',
      'RQ-PRK-2\tphantom\tPARKED-BYHAND.claude\twork\t/x.md',
      'RQ-PRK-3\tphantom\tPARKED-OPS\twork\t/x.md']);
    const items = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    expect(items).toEqual([]);
  });

  it('emits a dropped item for picks found in the drop archive or terminal market status', async () => {
    const dir = runsDir();
    dir0 = dir;
    writePicks(dir, [
      pickRow('RQ-DROP-1', 3 * DAY), pickRow('RQ-DROP-2', 2 * DAY), pickRow('RQ-DROP-3', SETTLED_MS),
      pickRow('RQ-MDROP-1', 3 * DAY), pickRow('RQ-MDROP-2', 2 * DAY), pickRow('RQ-MDROP-3', SETTLED_MS),
    ]);
    writeDropped(dir, ['RQ-DROP-1', 'RQ-DROP-2', 'RQ-DROP-3']);
    writeQueueV1(dir, [{ id: 'RQ-MDROP-1', status: 'DROPPED' }, { id: 'RQ-MDROP-2', status: 'RETIRED' }, { id: 'RQ-MDROP-3', status: 'DROPPED' }]);
    const items = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^selectorpick-dropped-/);
    expect(items[0]!.prompt).toContain('dropped.tsv');
  });

  it('emits unmerged and empty items from jobs-ledger outcomes', async () => {
    const dir = runsDir();
    writePicks(dir, [
      pickRow('RQ-UM-1', 3 * DAY, { jobType: 'friction' }), pickRow('RQ-UM-2', 2 * DAY, { jobType: 'friction' }), pickRow('RQ-UM-3', SETTLED_MS, { jobType: 'friction' }),
      pickRow('RQ-EM-1', 3 * DAY), pickRow('RQ-EM-2', 2 * DAY), pickRow('RQ-EM-3', SETTLED_MS),
      pickRow('RQ-MG-1', 3 * DAY), pickRow('RQ-MG-2', 2 * DAY), pickRow('RQ-MG-3', SETTLED_MS),
      pickRow('RQ-IF-1', 3 * DAY), pickRow('RQ-IF-2', 2 * DAY), pickRow('RQ-IF-3', SETTLED_MS),
    ]);
    writeJobs(dir, [
      { job: 'RQ-UM-1', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-UM-1', event: 'finish', ts: iso(DAY) },
      { job: 'RQ-UM-2', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-UM-2', event: 'finish', ts: iso(DAY) },
      { job: 'RQ-UM-3', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-UM-3', event: 'finish', ts: iso(DAY) }, { job: 'RQ-UM-3', event: 'outcome', phase: 'CLOSED', ts: iso(DAY) },
      { job: 'RQ-EM-1', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-EM-1', event: 'finish', empty: true, ts: iso(DAY) },
      { job: 'RQ-EM-2', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-EM-2', event: 'publish', class: 'empty', ts: iso(DAY) },
      { job: 'RQ-EM-3', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-EM-3', event: 'finish', empty: true, ts: iso(DAY) },
      { job: 'RQ-MG-1', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-MG-1', event: 'finish', ts: iso(DAY) }, { job: 'RQ-MG-1', event: 'outcome', phase: 'MERGED', ts: iso(DAY) },
      { job: 'RQ-MG-2', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-MG-2', event: 'finish', ts: iso(DAY) }, { job: 'RQ-MG-2', event: 'outcome', phase: 'MERGED', ts: iso(DAY) },
      { job: 'RQ-MG-3', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-MG-3', event: 'finish', ts: iso(DAY) }, { job: 'RQ-MG-3', event: 'outcome', phase: 'MERGED', ts: iso(DAY) },
      { job: 'RQ-IF-1', event: 'launch', ts: iso(2 * DAY) },
      { job: 'RQ-IF-2', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-IF-2', event: 'publish', class: 'pr', prUrl: 'https://x/1', ts: iso(DAY) },
      { job: 'RQ-IF-3', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-IF-3', event: 'finish', ts: iso(DAY) }, { job: 'RQ-IF-3', event: 'publish', class: 'pr', prUrl: 'https://x/2', ts: iso(DAY) },
    ]);
    const items = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    const kinds = items.map((i) => i.id.split('-')[1]).sort();
    // unmerged + empty only; merged and in-flight picks emit nothing.
    expect(kinds).toEqual(['empty', 'unmerged']);
    const unmerged = items.find((i) => i.id.startsWith('selectorpick-unmerged-'))!;
    const empty = items.find((i) => i.id.startsWith('selectorpick-empty-'))!;
    expect(unmerged.prompt).toContain('RQ-UM-1');
    expect(unmerged.prompt).toContain('never merge');
    expect(empty.prompt).toContain('finish EMPTY');
  });

  it('suppresses never-proposed when a queue evidence source is degraded', async () => {
    const dir = runsDir();
    neverProposedFixture(dir);
    // Invalid queue.v1.json marks the market evidence degraded → 'unknown'.
    fs.writeFileSync(path.join(dir, 'queue', 'queue.v1.json'), '{not json');
    expect(await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW })).toEqual([]);
  });

  it('requires the recurring bar: fewer than 3 picks or a single day emits nothing', async () => {
    const dir = runsDir();
    writePicks(dir, [pickRow('RQ-ONE-1', 3 * DAY), pickRow('RQ-ONE-2', 2 * DAY)]);
    expect(await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW })).toEqual([]);
    const dir2 = runsDir();
    writePicks(dir2, [pickRow('RQ-SAME-1', SETTLED_MS), pickRow('RQ-SAME-2', DAY + 3600_000), pickRow('RQ-SAME-3', DAY + 7200_000)]);
    expect(await selectorPicksBacklogItems({ repo: REPO, runsDir: dir2, now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const dir = runsDir();
    neverProposedFixture(dir);
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/lexicon', runsDir: dir, now: NOW })).toEqual([]);
    expect(await selectorPicksBacklogItems({ repo: '', runsDir: dir, now: NOW })).toEqual([]);
    const items = await selectorPicksBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('yields nothing for a missing picks journal or empty parse', async () => {
    const dir = runsDir();
    expect(await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW })).toEqual([]);
    writePicks(dir, ['garbage', '{"at":"bad"}']);
    expect(await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = runsDir();
    neverProposedFixture(dir);
    const first = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    const second = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default paths under ASHLR_RUNS_DIR', async () => {
    process.env.ASHLR_RUNS_DIR = runsDir();
    neverProposedFixture(process.env.ASHLR_RUNS_DIR);
    const items = await selectorPicksBacklogItems({ repo: REPO, now: NOW });
    expect(items.some((i) => i.id.startsWith('selectorpick-never-proposed-'))).toBe(true);
  });

  it('honours the item limit', async () => {
    const dir = runsDir();
    // Two adverse cells: never-proposed (phantom) + unmerged (phantom/work).
    writePicks(dir, [
      pickRow('RQ-NP-1', 3 * DAY), pickRow('RQ-NP-2', 2 * DAY), pickRow('RQ-NP-3', SETTLED_MS),
      pickRow('RQ-UM-1', 3 * DAY), pickRow('RQ-UM-2', 2 * DAY), pickRow('RQ-UM-3', SETTLED_MS),
    ]);
    writeJobs(dir, [
      { job: 'RQ-UM-1', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-UM-1', event: 'finish', ts: iso(DAY) },
      { job: 'RQ-UM-2', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-UM-2', event: 'finish', ts: iso(DAY) },
      { job: 'RQ-UM-3', event: 'launch', ts: iso(2 * DAY) }, { job: 'RQ-UM-3', event: 'finish', ts: iso(DAY) },
    ]);
    const all = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    expect(all.length).toBe(2);
    const one = await selectorPicksBacklogItems({ repo: REPO, runsDir: dir, now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(all[0]!.id);
  });

  it('appends selector-pick items through discovery and dedupes on refresh', async () => {
    const dir = runsDir();
    process.env.ASHLR_RUNS_DIR = dir;
    neverProposedFixture(dir);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const picks = first.items.filter((i) => i.id.startsWith('selectorpick-'));
    expect(picks.length).toBeGreaterThan(0);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(picks)).toBe(picks.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('selectorpick-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('selectorpick-'))).toHaveLength(picks.length);
  });
});
