import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readSupplyRank, runSupplyFloor } from '../src/core/fleet/supply-floor.js';
import { planAutofill } from '../src/core/fleet/queue-autofill.js';
import { readGapQueueInputs } from '../src/core/fleet/job-gaps.js';
import { gapLaneRoom } from '../src/core/fleet/gap-lane-room.js';
import type { PaceVerdict } from '../src/core/fleet/pace-verdict.js';

const now = Date.parse('2026-11-21T20:00:00Z');
let root: string;
const lane = { lane: 'claude', target: 20, running: 4, queued: 2, held: false, remainingPct: 97 };
const candidate = (id: string) => ({ id, family: id.replace(/\d+$/, '*'), source: 'bet' as const, repo: 'phantom', goal: id, acceptance: 'works', why: 'plain' });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'floor-')); await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('feeds the router floor, counts pending rows, and leaves dry runs unchanged', async () => {
  const options = { runsDir: root, root, apply: true, now: () => now, entries: [], readLanes: async () => ({ lanes: [lane] }),
    readOff: async () => false, readPace: async () => new Map<string, PaceVerdict>(),
    fill: async () => planAutofill({ ...lane, min: 8, existing: [], proposed: { proposals: [], droppedGoals: [] }, first: Array.from({ length: 8 }, (_, i) => candidate(`plain${i}`)) }) };
  expect((await runSupplyFloor({ ...options, apply: false }, await options.readLanes()))[0]?.added).toBe(0);
  await expect(readFile(join(root, 'queue/router-queue.md'))).rejects.toThrow();
  const report = await runSupplyFloor(options, await options.readLanes());
  expect(report[0]).toMatchObject({ added: 6, line: expect.stringContaining('supply: claude +6 (gap 16') });
  expect((await readFile(join(root, 'queue/router-queue.md'), 'utf8')).match(/- READY/g)).toHaveLength(6);
  expect(JSON.parse(await readFile(join(root, 'queue/planner-candidates.json'), 'utf8')).rankedJobs).toHaveLength(6);
  await writeFile(join(root, 'queue/planner-candidates.json'), 'declared');
  expect(await runSupplyFloor(options, await options.readLanes())).toEqual([]);
  expect(await readFile(join(root, 'queue/planner-candidates.json'), 'utf8')).toBe('declared');
  const over = new Map([['claude', { verdict: 'over' } as PaceVerdict]]);
  expect(await runSupplyFloor({ ...options, readPace: async () => over }, { lanes: [{ ...lane, lane: 'claude', queued: 0 }] })).toEqual([]);
});

it('counts lane-open ready rows toward each lane\'s waiting supply', async () => {
  // The fill seam sees the credited queue depth, like runQueueAutofill does.
  const fill = async (o: { lane: string; counts: { running: number | null; target: number | null; queued: number | null }; min?: number }) =>
    planAutofill({ lane: o.lane, min: o.min ?? 8, running: o.counts.running, target: o.counts.target, queued: o.counts.queued,
      existing: [], proposed: { proposals: [], droppedGoals: [] }, first: Array.from({ length: 8 }, (_, i) => candidate(`open${i}`)) });
  const options = { runsDir: root, root, apply: true, now: () => now, entries: [], readOff: async () => false, readPace: async () => new Map<string, PaceVerdict>(), fill };
  // claude: target 20, running 4 → gap 16, floor min 8; queued 2 + 6 lane-open = 8 → nothing to add.
  const covered = { ...options, readLanes: async () => ({ lanes: [{ ...lane }], openRows: 6 }) };
  expect(await runSupplyFloor(covered, await covered.readLanes())).toEqual([]);
  await expect(readFile(join(root, 'queue/router-queue.md'), 'utf8')).rejects.toThrow();
  // Three lane-open rows cover part of the gap: the floor tops up only the rest.
  const partial = { ...options, readLanes: async () => ({ lanes: [{ ...lane }], openRows: 3 }) };
  const report = await runSupplyFloor(partial, await partial.readLanes());
  expect(report[0]).toMatchObject({ lane: 'claude', added: 3 });
  expect((await readFile(join(root, 'queue/router-queue.md'), 'utf8')).match(/- READY/g)).toHaveLength(3);
});

it('credits no open supply when the count is unknown', async () => {
  const options = { runsDir: root, root, apply: true, now: () => now, entries: [], readOff: async () => false, readPace: async () => new Map<string, PaceVerdict>(),
    fill: async () => planAutofill({ ...lane, min: 8, existing: [], proposed: { proposals: [], droppedGoals: [] }, first: Array.from({ length: 8 }, (_, i) => candidate(`plain${i}`)) }) };
  // queued 2 of min 8 with openRows null tops up exactly as before the field existed.
  const view = { lanes: [{ ...lane }], openRows: null };
  const report = await runSupplyFloor({ ...options, readLanes: async () => view }, view);
  expect(report[0]).toMatchObject({ lane: 'claude', added: 6 });
});

it('ranks measured PR yield, stops weak families, respects stops and retirement, and excludes old launches', async () => {
  const events = ['good', 'weak', 'edge', 'old'].flatMap(name => Array.from({ length: 4 }, (_, i) => {
    const job = `${name}${i}`, ts = new Date(now - (name === 'old' ? 25 : 1) * 3600000).toISOString();
    return [JSON.stringify({ event: 'launch', job, ts }), ...(name === 'good' || name === 'edge' && i === 0 ? [JSON.stringify({ event: 'publish', class: 'pr', job, ts, pr: i + 1 })] : [])];
  }).flat());
  await writeFile(join(root, 'metrics/jobs.jsonl'), events.join('\n'));
  await writeFile(join(root, 'queue/family-stop.tsv'), `^stop\t${now / 1000 + 100}\tplain\n`);
  await writeFile(join(root, 'queue/RETIRED'), 'retired\n');
  const rank = await readSupplyRank(root, now);
  expect(rank(candidate('good5'))).toBe(1); expect(rank(candidate('edge5'))).toBe(0.25);
  expect(rank(candidate('weak5'))).toBeNull(); expect(rank(candidate('stop'))).toBeNull(); expect(rank(candidate('retired'))).toBeNull();
  expect(rank(candidate('old5'))).toBe(-1);
  const plan = planAutofill({ ...lane, queued: 0, min: 8, existing: [], proposed: { proposals: [], droppedGoals: [] }, candidateRank: rank,
    first: ['weak5', 'old5', 'stop', 'retired', 'edge5', 'good5'].map(candidate) });
  expect(plan.drafted.map(d => d.id)).toEqual(['good5', 'edge5', 'old5']);
  expect(plan.trace?.filter(t => t.event === 'rejected')).toHaveLength(3);
});

it('ignores ready rows for dead pools when deciding whether the queue is full', async () => {
  await writeFile(join(root, 'queue/ready.tsv'), Array.from({ length: 40 }, (_, i) => `plain${i}\tphantom\tdead\twork\tplain`).join('\n'));
  expect(await readGapQueueInputs(root, gapLaneRoom([lane], now))).toMatchObject({ readyRows: 40, launchableRows: 0, full: false });
  expect(await readGapQueueInputs(root, null)).toMatchObject({ readyRows: 40, full: true });
});
