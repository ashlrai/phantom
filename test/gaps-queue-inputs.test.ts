import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdJobsGaps, readGapsWhy } from '../src/cli/jobs-gaps.js';
import type { LaneFacts } from '../src/core/fleet/autofill-lanes.js';
import { readJobGaps } from '../src/core/fleet/job-gaps.js';
import { runAutofillTick } from '../src/core/fleet/autofill-run.js';

const NOW = Date.parse('2026-11-21T14:00:00Z');
const BACK = '2026-11-22T20:30:00Z';
let root: string, wt: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gapq-')); wt = join(root, 'wt'); await mkdir(join(root, 'queue', 'prompts'), { recursive: true }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const none = { openIdeas: async () => [], queuedWork: async () => [], mergedTitles: async () => [] };
async function seedGaps(n: number): Promise<void> {
  await mkdir(join(root, 'metrics'), { recursive: true });
  const jobs = Array.from({ length: n }, (_, i) => `JOB${i}`);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${jobs.map(job => JSON.stringify({ event: 'outcome', job, lane: 'claude', empty: true, repo: 'phantom', ts: new Date(NOW - 7_200_000).toISOString() })).join('\n')}\n`);
  for (const [i, job] of jobs.entries()) {
    await mkdir(join(wt, job), { recursive: true });
    await writeFile(join(wt, job, 'BRIDGE_NOTES.md'), `## Remaining gaps\n- ${['Teach the walrus to count lanterns', 'Polish cobalt kettle handles', 'Wire velvet compass readings', 'Sort meadow beacons alphabetically', 'Rename quartz harbor docks'][i]} in test/row${i}.test.ts\n`);
  }
}
async function readyRows(n: number, pool: string): Promise<void> {
  await writeFile(join(root, 'queue', 'ready.tsv'), Array.from({ length: n }, (_, i) => `RQ-RDY${i}\tphantom\t${pool}\twork\tplain row ${i}`).join('\n') + '\n');
}
async function oldPrompts(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, i) => writeFile(join(root, 'queue', 'prompts', `RQ-PHX-OLD${i}.md`), 'old\n')));
}
const dropped = async () => (await readdir(join(root, 'leader', 'drop', 'claude')).catch(() => [])).filter(f => f.startsWith('RQ-PHX-'));
const lane = (over: Partial<LaneFacts>): LaneFacts => ({ lane: 'claude', running: 0, target: 8, queued: 0, held: false, remainingPct: 80, ...over });
const lanes = [lane({}), lane({ lane: 'codex-personal', running: 0, target: 1, queued: 9, remainingPct: 0, resetAt: BACK })];

describe('gap queue count', () => {
  it('ignores 2,000 old prompt files and 9 ready rows parked on a spent pool', async () => {
    await seedGaps(4); await oldPrompts(2000); await readyRows(9, 'codex-personal');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, lanes, ...none });
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(3); // capped as today
    expect(report.parked).toBe(9);
    expect(report.queue).toMatchObject({ readyRows: 9, parkedRows: 9, launchableRows: 9 - 9, lanesSource: 'lane readings', full: false });
    expect(await dropped()).toHaveLength(3);
  });
  it('without lane readings, 9 ready rows are not "full"', async () => {
    await seedGaps(2); await oldPrompts(2000); await readyRows(9, 'codex-personal');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(report.queue).toMatchObject({ readyRows: 9, lanesSource: 'unavailable', full: false });
    expect(JSON.stringify(report.proposed)).not.toMatch(/queue is full/);
    expect(report.proposed!.some(p => p.queued)).toBe(true);
  });
  it('a real 40-row ready.tsv still reports full and writes nothing', async () => {
    await seedGaps(2); await readyRows(40, 'claude');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(report.queue).toMatchObject({ readyRows: 40, full: true });
    expect(report.proposed![0]!.skipped).toMatch(/the job queue is full \(40 launchable rows, limit 40\)/);
    expect(await dropped()).toEqual([]);
  });
  it('without propose (dry run) nothing is written', async () => {
    await seedGaps(2); await readyRows(1, 'claude');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, lanes, ...none });
    expect(report.proposed).toBeNull();
    expect(await dropped()).toEqual([]);
  });
});

describe('phm jobs gaps --why', () => {
  it('prints the count inputs as json and reads nothing but ready.tsv', async () => {
    await oldPrompts(50); await readyRows(9, 'codex-personal');
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const why = await readGapsWhy(async () => ({ lanes }), NOW);
    expect(why).toMatchObject({ schema: 'jobs.gaps-why.v1', readyRows: 9, parkedRows: 9, limit: 40, lanesSource: 'lane readings', full: false });
    expect(why.parkedNote).toMatch(/9 rows parked on codex-personal \(pool spent until/);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => { out.push(l); });
    expect(await cmdJobsGaps(['--why', '--json'], async () => readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, ...none }), async () => why)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ readyRows: 9, lanesSource: 'lane readings' });
    out.length = 0;
    const unread = await readGapsWhy(async () => { throw new Error('down'); }, NOW);
    expect(unread).toMatchObject({ lanesSource: 'unavailable', readyRows: 9, full: false });
  });
});

describe('self-tick gaps note', () => {
  const tick = (readLanes: () => Promise<{ lanes: LaneFacts[] } | null>) => runAutofillTick({
    runsDir: root, apply: true, now: () => NOW, root, entries: [], readLanes, readOff: async () => false, readPace: async () => new Map(), lastGapQueuedMs: async () => null,
    harvestGaps: async d => readJobGaps(24, { runsDir: d.runsDir, wtDir: wt, now: NOW, propose: true, ...(d.lanes ? { lanes: d.lanes } : {}), ...none }),
  });
  it('names the numbers it used, reading the lanes once', async () => {
    await seedGaps(4); await oldPrompts(2000); await readyRows(9, 'codex-personal');
    const readLanes = vi.fn(async () => ({ lanes }));
    const report = await tick(readLanes);
    expect(readLanes).toHaveBeenCalledTimes(1);
    expect(report.gaps).toMatchObject({ candidates: 4, queued: 3, parked: 9, unknown: false });
    expect(report.gapsNote).toMatch(/^4 gaps found, queued 3 for claude \(0 of 8 busy\); 9 rows parked on codex-personal \(pool spent until/);
  });
  it('says lane readings unavailable instead of full', async () => {
    await seedGaps(2); await oldPrompts(2000); await readyRows(9, 'codex-personal');
    const report = await tick(async () => null);
    expect(report.gapsNote).toMatch(/lane readings unavailable; 9 ready rows in queue\/ready.tsv \(limit 40\)/);
    expect(report.gapsNote).not.toMatch(/full/);
  });
});
