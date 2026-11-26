import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  emptyTagBacklogItems,
  foldEmptyTagWindow,
  EMPTY_TAG_RECURRING,
} from '../src/core/improve/empty-tag-backlog.js';
import type { EmptiesFinish } from '../src/core/fleet/empty-finishes.js';
import { ROUTER_OUTCOME_LEDGER_LIMIT } from '../src/core/router/outcomes.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-empty-tag-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const iso = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

/** One jobs-ledger finish row in the shared dialect: event + empty flag + safe job id. */
const finishRow = (id: string, hoursAgo: number, empty = true): string =>
  JSON.stringify({ ts: iso(hoursAgo), job: id, lane: 'work', event: 'finish', empty });

/** A dispatcher skip row: the finish fold marks it empty but skipped — never launched. */
const skipRow = (id: string, hoursAgo: number): string =>
  JSON.stringify({ ts: iso(hoursAgo), job: id, lane: 'work', event: 'precheck_skip' });

/** One job.empty-tag.v1 row as empty-tag-sync and `phm jobs empty --record` write it. */
const tagRow = (id: string, tag: string): string =>
  JSON.stringify({ schema: 'job.empty-tag.v1', job: id, lane: 'work', tag });

const finish = (id: string, over: Partial<EmptiesFinish> = {}): EmptiesFinish => ({
  id, lane: 'work', empty: true, skipped: false, tokens: null, exitCode: 0, poolError: false, ...over,
});

/** Write a scratch runs dir with the two ledgers and return its path. */
const writeRuns = (root: string, jobs: string, tags?: string): string => {
  const dir = path.join(home, root);
  fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'metrics', 'jobs.jsonl'), jobs);
  if (tags !== undefined) fs.writeFileSync(path.join(dir, 'metrics', 'empty-tags.jsonl'), tags);
  return dir;
};

describe('foldEmptyTagWindow', () => {
  it('tallies recorded tags, untagged finishes and skipped rows apart', () => {
    const finishes = [
      finish('RQ-A-1'), finish('RQ-A-2'), finish('RQ-A-3'),
      finish('RQ-B-1'), finish('RQ-C-1'),
      finish('RQ-SKIP-1', { skipped: true }),
      finish('RQ-OK-1', { empty: false }),
    ];
    const tags = new Map<string, string>([
      ['RQ-A-1', 'blocked'], ['RQ-A-2', 'blocked'], ['RQ-A-3', 'blocked'],
      ['RQ-B-1', 'already_done'], ['RQ-C-1', 'bogus-tag'],
      ['RQ-SKIP-1', 'unknown'],
    ]);
    const fold = foldEmptyTagWindow(finishes, tags);
    expect(fold.empties).toBe(5);
    expect(fold.skipped).toBe(1);
    expect(fold.counts['blocked']).toBe(3);
    expect(fold.counts['already_done']).toBe(1);
    expect(fold.counts['untagged']).toBe(1);
    expect(fold.counts['unknown']).toBe(0);
    expect(fold.examples['blocked']).toEqual(['RQ-A-1', 'RQ-A-2', 'RQ-A-3']);
    expect(fold.examples['untagged']).toEqual(['RQ-C-1']);
  });
});

describe('emptyTagBacklogItems', () => {
  it.each(['launch', 'batch_claim'])('uses only current-attempt finishes after a %s', async (event) => {
    const ids = ['RQ-RETRY-1', 'RQ-RETRY-2', 'RQ-RETRY-3'];
    const receipts = ids.flatMap((job) => [
      finishRow(job, 4),
      JSON.stringify({ ts: iso(4), job, event }),
      finishRow(job, 4), // Replaying the old finish cannot complete the retry.
    ]);
    const options = { repo: 'ashlrai/phantom', now: NOW, tagsText: '' };
    expect(await emptyTagBacklogItems({ ...options, jobsText: receipts.join('\n') })).toEqual([]);

    // New finishes count even when their receipts were appended out of timestamp order.
    const jobsText = [...ids.map((job) => finishRow(job, 2)), ...receipts].join('\n');
    const items = await emptyTagBacklogItems({ ...options, jobsText });
    expect(items.map((item) => item.id)).toEqual(['fleet-empty-tag-untagged']);
    expect(items[0]?.prompt).toContain('untagged=3');
  });

  it('turns a recurring recorded tag into a valid priority-3 backlog item', async () => {
    const jobs = [finishRow('RQ-AAA-1', 5), finishRow('RQ-AAA-2', 4), finishRow('RQ-AAA-3', 3)].join('\n');
    const tags = [tagRow('RQ-AAA-1', 'blocked'), tagRow('RQ-AAA-2', 'blocked'), tagRow('RQ-AAA-3', 'blocked')].join('\n');
    const items = await emptyTagBacklogItems({ repo: 'ashlrai/phantom', runsDir: writeRuns('runs-a', jobs, tags), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toBe('fleet-empty-tag-blocked');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'fleet-empty-tags' });
    expect(item.title).toContain('blocked');
    expect(item.prompt).toContain('blocked=3');
    expect(item.prompt).toContain('RQ-AAA-1');
    expect(item.prompt).toContain('empty-final-reason');
    expect(item.prompt).toContain('empty-tags.jsonl');
    expect(item.prompt).toContain('no-change');
  });

  it('emits for recurring unknown tags with the could-not-classify framing', async () => {
    const jobs = [finishRow('RQ-BBB-1', 6), finishRow('RQ-BBB-2', 5), finishRow('RQ-BBB-3', 4), finishRow('RQ-BBB-4', 3)].join('\n');
    const tags = [tagRow('RQ-BBB-1', 'unknown'), tagRow('RQ-BBB-2', 'unknown'), tagRow('RQ-BBB-3', 'unknown'), tagRow('RQ-BBB-4', 'already_done')].join('\n');
    const items = await emptyTagBacklogItems({ repo: 'ashlrai/phantom', runsDir: writeRuns('runs-b', jobs, tags), now: NOW });
    expect(items.map((i) => i.id)).toEqual(['fleet-empty-tag-unknown']);
    expect(items[0]!.prompt).toContain('could-not-classify');
    expect(items[0]!.prompt).toContain('unknown=3');
  });

  it('emits for an untagged majority but not for a minority the sync is still draining', async () => {
    // Majority: 3 empties, no tag rows at all — every join is honestly untagged.
    const majorityJobs = [finishRow('RQ-U1', 5), finishRow('RQ-U2', 4), finishRow('RQ-U3', 3)].join('\n');
    const majority = await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-c1', majorityJobs), now: NOW,
    });
    expect(majority.map((i) => i.id)).toEqual(['fleet-empty-tag-untagged']);
    expect(majority[0]!.prompt).toContain('untagged=3');
    expect(majority[0]!.prompt).toContain('empty-tag-sync');

    // Minority: the same 3 untagged plus 4 tagged finishes — the sync's
    // normal per-pass deferral, not a coverage gap.
    const minorityJobs = [
      ...[1, 2, 3, 4].map((i) => finishRow(`RQ-T${i}`, 8 - i)),
      finishRow('RQ-U1', 5), finishRow('RQ-U2', 4), finishRow('RQ-U3', 3),
    ].join('\n');
    const minorityTags = [1, 2, 3, 4].map((i) => tagRow(`RQ-T${i}`, 'already_done')).join('\n');
    const minority = await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-c2', minorityJobs, minorityTags), now: NOW,
    });
    expect(minority).toEqual([]);
  });

  it('withholds an untagged majority from a clipped jobs read while reporting recorded tags', async () => {
    const clippedIds = ['RQ-T1', 'RQ-T2', 'RQ-T3', 'RQ-T4'];
    const blockedIds = ['RQ-B1', 'RQ-B2', 'RQ-B3'];
    const untaggedIds = ['RQ-U1', 'RQ-U2', 'RQ-U3', 'RQ-U4'];
    const jobs = [
      ...clippedIds.map(id => finishRow(id, 8)),
      ' '.repeat(ROUTER_OUTCOME_LEDGER_LIMIT),
      ...blockedIds.map(id => finishRow(id, 5)),
      ...untaggedIds.map(id => finishRow(id, 4)),
    ].join('\n');
    const tags = [
      ...clippedIds.map(id => tagRow(id, 'already_done')),
      ...blockedIds.map(id => tagRow(id, 'blocked')),
    ].join('\n');
    const items = await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-clipped', jobs, tags), now: NOW,
    });
    expect(items.map(item => item.id)).toEqual(['fleet-empty-tag-blocked']);
    expect(items[0]?.prompt).toContain('blocked=3');
    expect(items[0]?.prompt).toContain('counts cover only the retained receipts');
  });

  it('emits nothing below the recurring bar or when only explained tags recur', async () => {
    const belowJobs = Array.from({ length: EMPTY_TAG_RECURRING - 1 }, (_, i) => finishRow(`RQ-D${i + 1}`, 6 - i)).join('\n');
    const belowTags = Array.from({ length: EMPTY_TAG_RECURRING - 1 }, (_, i) => tagRow(`RQ-D${i + 1}`, 'blocked')).join('\n');
    expect(await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-d1', belowJobs, belowTags), now: NOW,
    })).toEqual([]);

    // already_done, no_change_needed and pool_cap are explained outcomes —
    // recurring or not, they never become work here.
    const healthy = [
      finishRow('RQ-E1', 9), finishRow('RQ-E2', 8), finishRow('RQ-E3', 7),
      finishRow('RQ-E4', 6), finishRow('RQ-E5', 5), finishRow('RQ-E6', 4),
    ].join('\n');
    const healthyTags = [
      tagRow('RQ-E1', 'already_done'), tagRow('RQ-E2', 'already_done'), tagRow('RQ-E3', 'already_done'),
      tagRow('RQ-E4', 'no_change_needed'), tagRow('RQ-E5', 'pool_cap'), tagRow('RQ-E6', 'pool_cap'),
    ].join('\n');
    expect(await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-d2', healthy, healthyTags), now: NOW,
    })).toEqual([]);
  });

  it('never counts gate-skipped finishes toward a tag bucket', async () => {
    // The sync tags skipped jobs 'unknown' (they have no log); the feed must
    // not inherit that noise — a skip is a gate decision, not a worker empty.
    const jobs = [skipRow('RQ-S1', 5), skipRow('RQ-S2', 4), skipRow('RQ-S3', 3), finishRow('RQ-S4', 2, false)].join('\n');
    const tags = [tagRow('RQ-S1', 'unknown'), tagRow('RQ-S2', 'unknown'), tagRow('RQ-S3', 'unknown')].join('\n');
    const items = await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-e', jobs, tags), now: NOW,
    });
    expect(items).toEqual([]);
  });

  it('emits every recurring actionable bucket and honours the limit', async () => {
    const jobs = [
      finishRow('RQ-F1', 9), finishRow('RQ-F2', 8), finishRow('RQ-F3', 7),
      finishRow('RQ-F4', 6), finishRow('RQ-F5', 5), finishRow('RQ-F6', 4),
      finishRow('RQ-F7', 3), finishRow('RQ-F8', 2), finishRow('RQ-F9', 1),
    ].join('\n');
    const tags = [
      tagRow('RQ-F1', 'blocked'), tagRow('RQ-F2', 'blocked'), tagRow('RQ-F3', 'blocked'),
      tagRow('RQ-F4', 'unknown'), tagRow('RQ-F5', 'unknown'), tagRow('RQ-F6', 'unknown'),
      // RQ-F7..F9 left untagged: untagged=3 of empties=9 — a minority, suppressed.
    ].join('\n');
    const items = await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-f', jobs, tags), now: NOW,
    });
    expect(items.map((i) => i.id)).toEqual(['fleet-empty-tag-blocked', 'fleet-empty-tag-unknown']);
    for (const item of items) expect(validBacklogItem(item)).not.toBeNull();
    const one = await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-f2', jobs, tags), now: NOW, limit: 1,
    });
    expect(one.map((i) => i.id)).toEqual(['fleet-empty-tag-blocked']);
  });

  it('emits nothing for stale finishes, a missing jobs ledger or an unjoinable tags ledger', async () => {
    const stale = [finishRow('RQ-G1', 80), finishRow('RQ-G2', 79), finishRow('RQ-G3', 78)].join('\n');
    const staleTags = [tagRow('RQ-G1', 'blocked'), tagRow('RQ-G2', 'blocked'), tagRow('RQ-G3', 'blocked')].join('\n');
    expect(await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: writeRuns('runs-g1', stale, staleTags), now: NOW,
    })).toEqual([]);
    expect(await emptyTagBacklogItems({
      repo: 'ashlrai/phantom', runsDir: path.join(home, 'no-such-runs'), now: NOW,
    })).toEqual([]);

    // A tags path that is not a file makes the join untrustworthy — quiet, not guessed.
    const dir = writeRuns('runs-g2', [finishRow('RQ-G4', 5), finishRow('RQ-G5', 4), finishRow('RQ-G6', 3)].join('\n'));
    fs.mkdirSync(path.join(dir, 'metrics', 'empty-tags.jsonl'));
    expect(await emptyTagBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository — the tag machinery is this repo\'s', async () => {
    const jobs = [finishRow('RQ-H1', 5), finishRow('RQ-H2', 4), finishRow('RQ-H3', 3)].join('\n');
    const tags = [tagRow('RQ-H1', 'blocked'), tagRow('RQ-H2', 'blocked'), tagRow('RQ-H3', 'blocked')].join('\n');
    const runsDir = writeRuns('runs-h', jobs, tags);
    expect(await emptyTagBacklogItems({ repo: 'ashlrai/other', runsDir, now: NOW })).toEqual([]);
    expect(await emptyTagBacklogItems({ repo: 'other-owner/phantom', runsDir, now: NOW })).toEqual([]);
    expect(await emptyTagBacklogItems({ repo: 'AshlrAI/Phantom', runsDir, now: NOW }))
      .toEqual([expect.objectContaining({ id: 'fleet-empty-tag-blocked', repo: 'AshlrAI/Phantom' })]);
    expect(await emptyTagBacklogItems({ repo: 'phantom', runsDir, now: NOW })).not.toEqual([]);
  });

  it('tolerates torn ledger lines and derives stable ids across refreshes', async () => {
    const jobs = `{not json\n${[finishRow('RQ-I1', 5), finishRow('RQ-I2', 4), finishRow('RQ-I3', 3)].join('\n')}\n`;
    const tags = `${tagRow('RQ-I1', 'blocked')}\n{bad\n${tagRow('RQ-I2', 'blocked')}\n${tagRow('RQ-I3', 'blocked')}\n`;
    const runsDir = writeRuns('runs-i', jobs, tags);
    const first = await emptyTagBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: NOW });
    const second = await emptyTagBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: NOW });
    expect(first.map((i) => i.id)).toEqual(['fleet-empty-tag-blocked']);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends empty-tag items through discovery and dedupes on refresh', async () => {
    const savedRuns = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = path.join(home, '.ashlr-runs');
    try {
      // discoverBacklog anchors the fold at the real clock, so fixture rows
      // stamp relative to it — the 72h window is the fold's own.
      const recent = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
      const jobs = [1, 2, 3].map((i) => JSON.stringify({
        ts: recent(10 - i), job: `RQ-J${i}`, lane: 'work', event: 'finish', empty: true,
      })).join('\n');
      const tags = [1, 2, 3].map((i) => JSON.stringify({
        schema: 'job.empty-tag.v1', job: `RQ-J${i}`, lane: 'work', tag: 'blocked',
      })).join('\n');
      writeRuns('.ashlr-runs', jobs, tags);
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const tagged = first.items.filter((i) => i.id.startsWith('fleet-empty-tag-'));
      expect(tagged.map((i) => i.id)).toEqual(['fleet-empty-tag-blocked']);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(tagged)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-empty-tag-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-empty-tag-'))).toHaveLength(1);
    } finally {
      if (savedRuns === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = savedRuns;
    }
  });
});
