import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { explainRoutes } from '../src/core/queue/route-explain.js';
import { buildFleetEvalReport } from '../src/core/fleet/eval-report.js';

it('counts only accepted moves in the trailing hour and reports unavailable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'route-explain-'));
  try {
    expect((await explainRoutes(root, 10000))['route-moves-per-hour']).toBeNull();
    expect((await explainRoutes(root, 10000)).laneQuality).toBeNull();
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/route-state.json'), JSON.stringify({ job: {
      pool: 'claude', decided_at: 9999, waste_reason: 'use-it-all high waste risk: work -> frontier', moves: [6400, 6401, 9999, 10001],
    } }));
    const report = await explainRoutes(root, 10000);
    expect(report['route-moves-per-hour']).toBe(2);
    expect(report.lines[0]['route-moves-per-hour']).toBe(2);
    expect(report.lines[0].wasteReason).toBe('use-it-all high waste risk: work -> frontier');
    await writeFile(join(root, 'queue/route-state.json'), '{');
    expect((await explainRoutes(root)).available).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('feeds real eval-report outcome fixtures into bounded controller targets and explains the receipt', async () => {
  const nowMs = Date.parse('2026-11-15T12:00:00Z');
  const mergedAt = '2026-11-10T00:00:00Z';
  const outcomes = Array.from({ length: 20 }, (_, i) => ({
    job: `RQ-QUALITY-${i}`, url: `https://github.com/ashlrai/phantom/pull/${i + 1}`,
    mergeCommit: (i + 1).toString(16).padStart(40, '0'), event: 'outcome', state: 'MERGED', ts: mergedAt,
  }));
  const report = buildFleetEvalReport({
    jobsText: outcomes.flatMap(row => [
      JSON.stringify({ event: 'launch', job: row.job, lane: 'codex-personal', tier: 'work', ts: '2026-11-09T23:00:00Z' }),
      JSON.stringify(row),
    ]).join('\n'), nowMs,
    prsTexts: [JSON.stringify(outcomes.map(row => ({ url: row.url, mergedAt, state: 'MERGED',
      mergeCommit: { oid: row.mergeCommit }, title: `Implement ${row.job}`, files: [],
    })))],
    observations: { sourceState: 'healthy', rows: outcomes.slice(16).map(row => ({
      mergeCommit: row.mergeCommit, outcome: 'reverted', confidence: 'deterministic',
    })) },
  });
  expect(report.merges).toMatchObject({ resolved: 20, stable: 16, reverted: 4 });
  // Exercise the actual Python consumer rather than restating the scoring math in TS.
  const result = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'contrib/mac')
import fleet_controller as fc
report = json.load(sys.stdin)
weights, state, receipts = fc.outcome_quality(report, None, ${nowMs / 1000}, ['codex-personal'])
view = {'codex-personal': dict(desired=32, floor=10, bound=32, held=False)}
plan = fc.plan({}, view, 0, outcome_weights=weights)
print(json.dumps(dict(plan=plan, quality_receipts=receipts, outcome_quality=state)))
`], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 }));
  expect(result.plan.lanes['codex-personal'].target).toBe(24);
  expect(result.quality_receipts[0]).toMatchObject({
    schema: 'route.quality.v1', score: 0.8, resolved: 20, from: 1, to: 0.75, reason: 'quality_adjustment',
  });
  const root = await mkdtemp(join(tmpdir(), 'quality-explain-'));
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/fleet-controller.json'), JSON.stringify(result));
    const explanation = await explainRoutes(root, nowMs / 1000);
    expect(explanation.laneQuality).toEqual(result.quality_receipts);
    expect(explanation['route-moves-per-hour']).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
