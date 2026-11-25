/** RQ-PSEL-3-GRADER wiring — syncPickGrades folds the jobs ledger into pick grades, weights and friction closes. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  foldPickGradeEvidence, selectorPickRecords, syncPickGrades,
} from '../src/core/fleet/pick-grade-sync.js';
import { pickGraderPaths, realizedScore } from '../src/core/fleet/pick-grader.js';
import { frictionLedgerPath, readFrictionLedger, upsertFrictionItems, type FrictionItem } from '../src/core/fleet/friction-ledger.js';
import { cmdSelect } from '../src/cli/select.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const PICKED = NOW - 8 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pick-grade-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pickRow = (id: string, at = PICKED, extra: Record<string, unknown> = {}) => JSON.stringify({
  at: iso(at), rank: 1, id, repo: 'phantom', jobType: 'work', score: 1.2,
  predictedValue: 0.7, mergeRate: 0.6, minutes: 30, usage: 0.3, basis: 'default', ...extra,
});

const ledgerRow = (row: Record<string, unknown>) => JSON.stringify(row);

describe('foldPickGradeEvidence', () => {
  it('collects merge, revert and used stamps per job with a coverage bound', () => {
    const text = [
      ledgerRow({ event: 'launch', job: 'RQ-OLD', ts: iso(PICKED - DAY) }),
      ledgerRow({ event: 'launch', job: 'RQ-P1', ts: iso(PICKED + H) }),
      ledgerRow({ event: 'publish', job: 'RQ-P1', class: 'pr', url: 'https://github.com/ashlrai/phantom/pull/9', ts: iso(PICKED + 2 * H) }),
      ledgerRow({ event: 'outcome', job: 'RQ-P1', phase: 'MERGED', mergedAt: iso(PICKED + 3 * H), ts: iso(PICKED + 3 * H + 60_000) }),
      ledgerRow({ event: 'finish', job: 'RQ-P2', empty: true, ts: iso(PICKED + H) }),
      ledgerRow({ schema: 'fleet.session-pool.v1', job: 'RQ-P3', jobId: 'RQ-P3:x', event: 'launch', ts: iso(PICKED + H) }),
      'not json',
    ].join('\n');
    const fold = foldPickGradeEvidence(text, NOW);
    expect(fold.coverageStartMs).toBe(PICKED - DAY);
    expect(fold.malformed).toBe(1);
    const ev = fold.evidence.get('RQ-P1')!;
    expect(ev.merges).toEqual([PICKED + 3 * H]);
    // The outcome row carries no PR link here, so only the publish row is used evidence.
    expect(ev.used).toEqual([PICKED + 2 * H]);
    // An empty finish and a node-pool launch record no grade evidence.
    expect(fold.evidence.has('RQ-P2')).toBe(false);
    expect(fold.evidence.has('RQ-P3')).toBe(false);
  });

  it('ignores future-dated rows for evidence and coverage', () => {
    const fold = foldPickGradeEvidence([
      ledgerRow({ event: 'launch', job: 'RQ-F', ts: iso(NOW + DAY) }),
      ledgerRow({ event: 'launch', job: 'RQ-G', ts: iso(PICKED) }),
    ].join('\n'), NOW);
    expect(fold.coverageStartMs).toBe(PICKED);
    expect(fold.evidence.size).toBe(0);
  });
});

describe('selectorPickRecords', () => {
  it('maps journal rows to grader picks and skips ungradable rows', () => {
    const { picks, skipped } = selectorPickRecords([
      pickRow('RQ-A', PICKED, { frictionId: 'needs-you:x' }),
      pickRow('RQ-B', PICKED, { friction_id: 'merge.queue.stall' }),
      JSON.stringify({ at: 'not-a-date', id: 'RQ-C', mergeRate: 0.5 }),
      JSON.stringify({ at: iso(PICKED), id: 'RQ-D' }),
      'garbage',
    ].join('\n'));
    expect(picks).toHaveLength(2);
    expect(picks[0]).toMatchObject({ id: 'RQ-A', pickedAt: PICKED, features: { mergeRate: 0.6 }, frictionId: 'needs-you:x' });
    expect(picks[1]!.frictionId).toBe('merge.queue.stall');
    expect(skipped).toBe(3);
  });
});

describe('realizedScore null signals', () => {
  it('renormalizes over measured components instead of recording zeros', () => {
    expect(realizedScore({ merged: true, used: true, stars: null, installs: null })).toBe(1);
    expect(realizedScore({ merged: false, used: true, stars: null, installs: null })).toBeCloseTo(0.3 / 0.7);
    expect(realizedScore({ merged: false, used: false, stars: null, installs: null })).toBe(0);
    expect(realizedScore({ merged: true, used: false, stars: 100, installs: null })).toBeCloseTo((0.4 + 0.15) / 0.85);
  });
});

describe('syncPickGrades', () => {
  function seed(runs: string, jobs: string[], picks: string[] = [pickRow('RQ-P1', PICKED, { frictionId: 'needs-you:x' })]) {
    mkdirSync(join(runs, 'selector'), { recursive: true });
    mkdirSync(join(runs, 'metrics'), { recursive: true });
    writeFileSync(join(runs, 'selector', 'picks.jsonl'), picks.map((p) => `${p}\n`).join(''));
    writeFileSync(join(runs, 'metrics', 'jobs.jsonl'), jobs.map((j) => `${j}\n`).join(''));
  }
  const mergeEvidence = (job: string, at: number) => [
    ledgerRow({ event: 'launch', job, ts: iso(at - 2 * H) }),
    ledgerRow({ event: 'publish', job, class: 'pr', url: `https://github.com/ashlrai/phantom/pull/${job === 'RQ-P1' ? 9 : 10}`, ts: iso(at - H) }),
    ledgerRow({ event: 'outcome', job, phase: 'MERGED', mergedAt: iso(at), ts: iso(at + 60_000), url: `https://github.com/ashlrai/phantom/pull/${job === 'RQ-P1' ? 9 : 10}` }),
  ];

  it('grades elapsed windows, persists grades and weights, and closes the friction item on a 7d hit', async () => {
    const home = tmp(); const runs = join(tmp(), 'runs');
    const frictionPath = frictionLedgerPath(home);
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    upsertFrictionItems(frictionPath, [{
      id: 'needs-you:x', title: 'Fix it', detail: 'd', score: 5, repo: 'phantom',
      source: 'test', status: 'open', openedAt: iso(NOW - 30 * DAY),
    } satisfies FrictionItem], iso(NOW - 30 * DAY));
    seed(runs, [
      ledgerRow({ event: 'launch', job: 'RQ-OLD', ts: iso(PICKED - DAY) }),
      ...mergeEvidence('RQ-P1', PICKED + 3 * H),
    ]);
    const run = await syncPickGrades({ runsDir: runs, home, frictionPath, now: () => new Date(NOW) });
    expect(run).toMatchObject({ state: 'read', picks: 1, picksSkipped: 0, newGrades: 2, frictionClosed: ['needs-you:x'] });
    expect(run.line).toContain('24h');
    const paths = pickGraderPaths(home);
    const grades = readFileSync(paths.grades, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(grades.map((g: { window: string }) => g.window).sort()).toEqual(['24h', '7d']);
    expect(grades.every((g: { realized: number }) => g.realized === 1)).toBe(true);
    expect(JSON.parse(readFileSync(paths.weights, 'utf8'))).toMatchObject({ mergeRate: expect.any(Number) });
    expect(readFrictionLedger(frictionPath).items.find((i) => i.id === 'needs-you:x')).toMatchObject({ status: 'closed', closeReason: 'grader-7d' });
    // A second pass never double-grades.
    const again = await syncPickGrades({ runsDir: runs, home, frictionPath, now: () => new Date(NOW) });
    expect(again.newGrades).toBe(0);
    expect(again.frictionClosed).toEqual([]);
  });

  it('anchors windows at pickedAt: a 30h merge misses 24h but hits 7d', async () => {
    const home = tmp(); const runs = join(tmp(), 'runs');
    seed(runs, [
      ledgerRow({ event: 'launch', job: 'RQ-OLD', ts: iso(PICKED - DAY) }),
      ledgerRow({ event: 'publish', job: 'RQ-P1', class: 'pr', url: 'https://github.com/ashlrai/phantom/pull/9', ts: iso(PICKED + 2 * H) }),
      ledgerRow({ event: 'outcome', job: 'RQ-P1', phase: 'MERGED', mergedAt: iso(PICKED + 30 * H), ts: iso(PICKED + 30 * H + 60_000) }),
    ]);
    const run = await syncPickGrades({ runsDir: runs, home, now: () => new Date(NOW) });
    expect(run.newGrades).toBe(2);
    const grades = readFileSync(join(home, '.ashlr', 'picks', 'grades.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const byWindow = Object.fromEntries(grades.map((g: { window: string; realized: number }) => [g.window, g.realized]));
    // 24h saw the publish but not the merge: used-only renormalizes to 0.3/0.7.
    expect(byWindow['24h']).toBeCloseTo(0.3 / 0.7);
    expect(byWindow['7d']).toBe(1);
  });

  it('a revert newer than the merge discounts it; a published-unmerged pick scores used-only', async () => {
    const home = tmp(); const runs = join(tmp(), 'runs');
    seed(runs, [
      ledgerRow({ event: 'launch', job: 'RQ-OLD', ts: iso(PICKED - DAY) }),
      ...mergeEvidence('RQ-P1', PICKED + 3 * H),
      ledgerRow({ event: 'reverted', job: 'RQ-P1', reverted: true, ts: iso(PICKED + 4 * H) }),
    ]);
    const run = await syncPickGrades({ runsDir: runs, home, now: () => new Date(NOW) });
    expect(run.newGrades).toBe(2);
    const grades = readFileSync(join(home, '.ashlr', 'picks', 'grades.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(grades.every((g: { realized: number }) => Math.abs(g.realized - 0.3 / 0.7) < 1e-9)).toBe(true);
  });

  it('defers picks whose window starts before the retained jobs coverage', async () => {
    const home = tmp(); const runs = join(tmp(), 'runs');
    // First dated row is after the pick: early-window evidence may be cut.
    seed(runs, [
      ledgerRow({ event: 'launch', job: 'RQ-P1', ts: iso(PICKED + 2 * H) }),
      ...mergeEvidence('RQ-P1', PICKED + 3 * H),
    ]);
    const run = await syncPickGrades({ runsDir: runs, home, now: () => new Date(NOW) });
    expect(run.state).toBe('read');
    expect(run.newGrades).toBe(0);
    expect(run.line).toBe('picks: no graded picks yet');
  });

  it('reports missing journals without throwing and grades nothing', async () => {
    const home = tmp(); const runs = join(tmp(), 'runs');
    mkdirSync(join(runs, 'selector'), { recursive: true });
    writeFileSync(join(runs, 'selector', 'picks.jsonl'), `${pickRow('RQ-P1', PICKED)}\n`);
    const run = await syncPickGrades({ runsDir: runs, home, now: () => new Date(NOW) });
    expect(run.state).toBe('missing');
    expect(run.newGrades).toBe(0);
  });
});

describe('phm select grading pass', () => {
  it('runs syncPickGrades on real passes and reports it in --json; dry runs skip it', async () => {
    const home = tmp(); const runs = join(tmp(), 'runs');
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    mkdirSync(join(runs, 'selector'), { recursive: true });
    mkdirSync(join(runs, 'metrics'), { recursive: true });
    writeFileSync(join(runs, 'selector', 'candidates.jsonl'), '');
    writeFileSync(join(runs, 'selector', 'picks.jsonl'), `${pickRow('RQ-P1', NOW - 8 * DAY)}\n`);
    writeFileSync(join(runs, 'metrics', 'jobs.jsonl'), [
      ledgerRow({ event: 'launch', job: 'RQ-OLD', ts: iso(NOW - 9 * DAY) }),
      ...mergeEvidenceFor('RQ-P1', NOW - 8 * DAY + 3 * H),
    ].join('\n') + '\n');
    const frictionPath = frictionLedgerPath(home);
    const out: string[] = []; const err: string[] = [];
    const deps = {
      now: () => new Date(NOW), out: (t: string) => out.push(t), err: (t: string) => err.push(t),
      bus: { root: join(tmp(), 'bus') },
    };
    const args = ['--json', '--runs-dir', runs, '--friction', frictionPath];
    expect(await cmdSelect([...args, '--dry-run'], deps)).toBe(0);
    expect(JSON.parse(out.pop()!).grading).toBeNull();
    expect(await cmdSelect(args, deps)).toBe(0);
    const json = JSON.parse(out.pop()!);
    expect(json.grading).toMatchObject({ state: 'read', newGrades: 2 });
    expect(json.grading.line).toContain('24h');
  });
});

function mergeEvidenceFor(job: string, at: number) {
  return [
    ledgerRow({ event: 'launch', job, ts: iso(at - 2 * H) }),
    ledgerRow({ event: 'publish', job, class: 'pr', url: 'https://github.com/ashlrai/phantom/pull/9', ts: iso(at - H) }),
    ledgerRow({ event: 'outcome', job, phase: 'MERGED', mergedAt: iso(at), ts: iso(at + 60_000), url: 'https://github.com/ashlrai/phantom/pull/9' }),
  ];
}
