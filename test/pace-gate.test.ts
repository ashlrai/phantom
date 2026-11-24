import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetPace } from '../src/cli/fleet-pace.js';
import { readJobGaps } from '../src/core/fleet/job-gaps.js';
import { buildFleetPace, PACE_SCHEMA, paceVerdict, type PaceInput, type PaceVerdict } from '../src/core/fleet/pace-verdict.js';
import { runAutofillTick } from '../src/core/fleet/autofill-run.js';
import type { LaneFacts } from '../src/core/fleet/autofill-lanes.js';

const NOW = Date.parse('2026-11-21T08:40:00Z');
const RESET = new Date(NOW + 158 * 3_600_000).toISOString();
const pool = (id: string, usedPct: number | null, hoursLeft: number | null, burn: number | null): PaceInput =>
  ({ id, usedPct, hoursLeft, burnPctPerHour: burn, resetAt: hoursLeft === null ? null : new Date(NOW + hoursLeft * 3_600_000).toISOString() });

describe('paceVerdict', () => {
  it('is ahead when the recent rate empties the pool over 24 h early', () => {
    const v = paceVerdict(pool('claude', 64, 158, 6), NOW);
    expect(v).toMatchObject({ state: 'ahead', usedPct: 64, hoursToReset: 158, recentPerHour: 6, evenPacePerHour: 0.23 });
    expect(Date.parse(v.emptyAt!)).toBe(NOW + 6 * 3_600_000);
  });
  it('is behind when the pool would end with room left, on pace when it lands near empty', () => {
    expect(paceVerdict(pool('codex-personal', 10, 100, 0.2), NOW).state).toBe('behind');
    expect(paceVerdict(pool('codex-personal', 10, 100, 0), NOW)).toMatchObject({ state: 'behind', emptyAt: null });
    expect(paceVerdict(pool('claude', 40, 100, 0.55), NOW).state).toBe('on-pace');
    // Empty only 10 h early is not "ahead".
    expect(paceVerdict(pool('claude', 40, 100, 60 / 90), NOW).state).toBe('on-pace');
  });
  it('is unknown without a reading, a burn rate or time left', () => {
    for (const p of [pool('x', null, 10, 1), pool('x', 10, null, 1), pool('x', 10, 10, null), pool('x', 10, 0, 1)]) {
      expect(paceVerdict(p, NOW)).toMatchObject({ state: 'unknown', emptyAt: null });
    }
  });
});

const lane = (name: string, over: Partial<LaneFacts> = {}): LaneFacts =>
  ({ lane: name, running: 0, target: 3, queued: 0, held: false, remainingPct: 50, ...over });
const LANES = [lane('claude'), lane('codex-local'), lane('codex-personal')];
const verdict = (id: string, state: PaceVerdict['state']): PaceVerdict =>
  ({ pool: id, state, usedPct: 64, hoursToReset: 158, emptyAt: state === 'ahead' ? new Date(NOW + 6 * 3_600_000).toISOString() : null, evenPacePerHour: 0.2, recentPerHour: 6, resetAt: RESET });

let root: string, wt: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pace-')); wt = join(root, 'wt'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const NOTES = [
  '## Remaining gaps',
  '- Wire the digest into phm report weekly',
  '- Cover stale locks in test/report.test.ts',
  '- Run gh pr list in the nightly sweep',
  '',
].join('\n');
async function seed(): Promise<void> {
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ event: 'outcome', job: 'RQ-A', lane: 'claude', empty: true, repo: 'phantom', ts: new Date(NOW - 7_200_000).toISOString() })}\n`);
  await mkdir(join(wt, 'RQ-A'), { recursive: true });
  await writeFile(join(wt, 'RQ-A', 'BRIDGE_NOTES.md'), NOTES);
}
const none = { openIdeas: async () => [], queuedWork: async () => [], mergedTitles: async () => [], ingestedTitles: async () => [], proposedTitles: async () => [] };
async function propose(lanes: LaneFacts[], pace: Map<string, PaceVerdict>) {
  await seed();
  const written: { lane?: string; id: string }[] = [];
  const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, lanes, pace, ...none, write: async (_r, input) => { written.push(input as { lane?: string; id: string }); return { file: `${input.id}.md` }; } });
  return { report, lanes: Object.fromEntries(report.proposed!.map(p => [p.title, p.lane ?? null])) };
}

describe('gap proposals with pace', () => {
  it('sends rows off an ahead pool and says so in one line', async () => {
    const { report, lanes } = await propose(LANES, new Map([['claude', verdict('claude', 'ahead')]]));
    expect(lanes['Wire the digest into phm report weekly']).toBe('codex-local');
    expect(lanes['Run gh pr list in the nightly sweep']).toBe('codex-personal');
    expect(report.paceNotes).toHaveLength(1);
    expect(report.paceNotes![0]).toMatch(/^claude ahead of pace \(empty .+, reset .+\): sent 2 rows to codex-local instead$/);
  });
  it('prefers a behind pool', async () => {
    const { lanes, report } = await propose(LANES, new Map([['codex-local', verdict('codex-local', 'behind')]]));
    expect(lanes['Wire the digest into phm report weekly']).toBe('codex-local');
    expect(report.paceNotes!.join(' ')).toContain('codex-local is behind pace');
  });
  it('leaves routing unchanged when pace is unknown or missing', async () => {
    const { lanes, report } = await propose(LANES, new Map([['claude', verdict('claude', 'unknown')]]));
    expect(lanes['Wire the digest into phm report weekly']).toBe('claude');
    expect(report.paceNotes).toBeUndefined();
  });
  it('never sends a gh row to a lane without gh, and holds it with the reason', async () => {
    const { lanes, report } = await propose(LANES, new Map([['codex-personal', verdict('codex-personal', 'ahead')]]));
    expect(lanes['Run gh pr list in the nightly sweep']).toBeNull();
    expect(report.proposed!.find(p => p.title.startsWith('Run gh'))!.skipped).toMatch(/^held: codex-personal ahead of pace .* no other pool with room can take it$/);
    expect(report.paceNotes!.join(' ')).toContain('1 row held');
  });
  it('holds every row when each open pool is ahead', async () => {
    const all = new Map(LANES.map(l => [l.lane, verdict(l.lane, 'ahead')] as const));
    const { report } = await propose(LANES, all);
    expect(report.proposed!.every(p => !p.queued && p.skipped?.startsWith('held: '))).toBe(true);
  });
});

describe('autofill tick with pace', () => {
  const run = (pace: Map<string, PaceVerdict>, filled: string[]) => runAutofillTick({
    runsDir: root, apply: false, now: () => NOW, root, entries: [],
    readLanes: async () => ({ lanes: [lane('claude'), lane('codex-personal')] }), readOff: async () => false, readPace: async () => pace,
    harvestGaps: async () => ({ schema: 'jobs.gaps.v1', sinceHours: 24, known: true, unknownSources: [], jobsScanned: 0, publishedScanned: 0, bySource: { 'no-change': 0, published: 0 }, jobsWithoutGaps: [], candidates: [], dropped: [], proposed: [] }),
    fill: async o => { filled.push(o.lane); return { error: 'no-target' }; },
  });
  it('adds nothing for an ahead lane and feeds a behind lane first', async () => {
    const filled: string[] = [];
    const report = await run(new Map([['claude', verdict('claude', 'ahead')], ['codex-personal', verdict('codex-personal', 'behind')]]), filled);
    expect(filled).toEqual(['codex-personal']);
    expect(report.paceNotes![0]).toMatch(/^claude ahead of pace .*: rows go to codex-personal instead$/);
  });
  it('changes nothing for unknown pace', async () => {
    const filled: string[] = [];
    const report = await run(new Map(), filled);
    expect(filled).toEqual(['claude', 'codex-personal']);
    expect(report.paceNotes).toBeUndefined();
  });
});

describe('phm fleet pace', () => {
  const view = { generatedAt: new Date(NOW).toISOString(), pools: [pool('claude', 64, 158, 6), pool('gemini', null, null, null)] };
  it('prints one line per pool and unknown as unknown', async () => {
    const lines: string[] = [];
    const spy = (s: unknown) => { lines.push(String(s)); };
    const orig = console.log; console.log = spy;
    try { expect(await cmdFleetPace([], { read: async () => buildFleetPace(view, NOW) })).toBe(0); } finally { console.log = orig; }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Over pace');
    expect(lines[1]).toMatch(/unknown/);
  });
  it('--json carries a schema id', async () => {
    const lines: string[] = [];
    const orig = console.log; console.log = (s: unknown) => { lines.push(String(s)); };
    try { await cmdFleetPace(['--json'], { read: async () => buildFleetPace(view, NOW) }); } finally { console.log = orig; }
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: PACE_SCHEMA, pools: [{ pool: 'claude', state: 'ahead' }, { pool: 'gemini', state: 'unknown' }] });
  });
});
