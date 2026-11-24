import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdRoute } from '../src/cli/route.js';
import { execFileSync } from 'node:child_process';
import { explainRoutes } from '../src/core/queue/route-explain.js';
import { recordFailover } from '../src/core/router/fallback.js';
import { buildFleetEvalReport } from '../src/core/fleet/eval-report.js';

it('explains bounded posture evidence, falls back to routing inputs, and keeps invalid evidence unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'posture-explain-'));
  try {
    await mkdir(join(root, 'metrics'));
    const path = join(root, 'metrics/work-market.jsonl');
    expect(await explainRoutes(root)).toMatchObject({ posture: null, fallback_chain: null, fallback_used: null });
    const lane = { posture: 'burn', posture_reason: 'spend_down_projected_unused',
      projected_unused_pct: 70, hours_to_reset: 2 };
    const snapshot = { schema: 'work-market.v1', event: 'posture', lanes: { claude: lane } };
    const route = { schema: 'work-market.v1', event: 'route_decision', ranking_inputs: {
      claude: { posture: 'balanced', posture_reason: 'host_declared', spend_down: {
        projected_unused_pct: 5, hours_to_reset: 1 } } } };
    await writeFile(path, `${'x'.repeat(300_000)}\n${JSON.stringify(snapshot)}\n${JSON.stringify(route)}\n{`);
    expect((await explainRoutes(root)).posture).toEqual({ lanes: { claude: {
      posture: 'burn', postureReason: 'spend_down_projected_unused', projectedUnusedPct: 70, hoursToReset: 2 } } });
    await writeFile(path, JSON.stringify(route));
    expect((await explainRoutes(root)).posture?.lanes.claude).toEqual({
      posture: 'balanced', postureReason: 'host_declared', projectedUnusedPct: 5, hoursToReset: 1 });
    for (const text of ['{', JSON.stringify({ ...snapshot, lanes: {} }),
      JSON.stringify({ ...snapshot, lanes: { claude: { ...lane, posture: 'invalid' } } }),
      JSON.stringify({ ...snapshot, lanes: { claude: { ...lane, hours_to_reset: -1 } } })]) {
      await writeFile(path, text);
      expect((await explainRoutes(root)).posture).toBeNull();
    }
    await writeFile(join(root, 'evidence'), JSON.stringify(snapshot));
    await rm(path);
    await symlink(join(root, 'evidence'), path);
    expect((await explainRoutes(root)).posture).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('explains a job mode and its spending evidence through the real JSON CLI without model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-explain-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'models.json'), JSON.stringify({ seat: 'gpt-6.1-sol' }));
    await writeFile(join(root, 'queue/slots.json'), JSON.stringify({ seat: { target: 1, hard_cap: 1 } }));
    await writeFile(join(root, 'queue/admission.json'), '{"admit":true}');
    await writeFile(join(root, 'queue/route-capacity.json'), JSON.stringify({ seat: { resetAt: null, remainingPercent: null, costPerMTok: 0 } }));
    const request = { job: 'example', task_class: 'bug-fix', repo: 'phantom', tier_hint: 'work', mode: 'normal',
      lane_candidates: ['seat'], quota_state: { seat: 'available' }, machine_state: { admit: true, running_by_lane: { seat: 0 } } };
    await writeFile(join(root, 'queue/route-request.json'), JSON.stringify(request));
    expect(await cmdRoute(['explain', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ fallback_chain: { primary: 'seat', live: false }, fallback_used: null });
    await recordFailover(root, { job: 'example', failed_lane: 'seat', lane: null, failure: 'timeout' }, 1000);
    await writeFile(join(root, 'queue/route-state.json'), '{}');
    expect(await explainRoutes(root)).toMatchObject({ available: true, fallback_chain: { primary: 'seat' },
      fallback_used: [{ event: 'failover_refused', job: 'example' }] });
    expect(JSON.parse(log.mock.calls.at(-1)![0]).decision).toMatchObject({ requested_mode: 'normal', mode_tier: 'normal',
      lane: 'seat', capacity: { costPerMTok: 0 }, reason_codes: ['mode-tier', 'free-capacity'] });
    await writeFile(join(root, 'queue/route-request.json'), JSON.stringify({ ...request, mode: 'fusion' }));
    expect((await explainRoutes(root)).decision).toMatchObject({ schema: 'route.pairing.v1', mode_tier: 'fusion',
      lead: null, sidekick: { lane: 'seat', mode_tier: 'normal' }, reason_codes: expect.arrayContaining(['no-frontier-lane']) });
    expect((await explainRoutes(root)).fallback_chain).toBeNull();
    await writeFile(join(root, 'queue/route-request.json'), '{"mode":"invalid"}');
    expect((await explainRoutes(root)).decision).toBeNull();
  } finally { vi.unstubAllEnvs(); log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it('surfaces real Devin cost reason codes and nullable ACU evidence in route explain JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devin-cost-explain-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  try {
    await mkdir(join(root, 'metrics'));
    const receipt = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'contrib/mac')
import work_market as m
v = m.lane_view(['devin'], {'devin': {}}, {'devin': 0}, {'devin': 1}, set(), {}, {}, [], now=10000,
  allowance={'devin': {'weekly_acu': dict(used=None, limit=50, reset_at=13600)}})
r, _ = m.choose('RQ-DEVIN', dict(needs=[], max_cost_class='included'), 'work', v, None, 10000, None)
print(json.dumps(r))
`], { encoding: 'utf8' }));
    const file = join(root, 'metrics/work-market.jsonl');
    for (const row of [receipt, { schema: 'work-market.v1', event: 'posture', lanes: {
      devin: { ...receipt.ranking_inputs.devin, projected_unused_pct: null, hours_to_reset: null } } }]) {
      await writeFile(file, JSON.stringify(row));
      expect(await cmdRoute(['explain', '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).posture.lanes.devin).toMatchObject({
        costClass: 'metered', costClassReason: 'devin_usage_unknown', zeroCost: false,
        allowance: { used: null, limit: 50, in_flight: null, reserve: null, session_cap: null, headroom: null },
      });
    }
    receipt.ranking_inputs.devin.allowance.headroom = -5;
    await writeFile(file, JSON.stringify(receipt));
    expect((await explainRoutes(root)).posture?.lanes.devin.allowance?.headroom).toBe(-5);
  } finally { vi.unstubAllEnvs(); log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it('counts only accepted moves in the trailing hour and reports unavailable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'route-explain-'));
  try {
    expect((await explainRoutes(root, 10000))['route-moves-per-hour']).toBeNull();
    expect((await explainRoutes(root, 10000)).laneQuality).toBeNull();
    expect((await explainRoutes(root, 10000)).pairing).toBeNull();
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/pairing-lanes.json'), JSON.stringify({ lanes: [
      { lane: 'lead', laneClass: 'frontier', available: true,
        pool: { pool: 'lead', resetAt: new Date(10001 * 1000).toISOString(), remainingPercent: 80 } },
    ] }));
    expect((await explainRoutes(root, 10000)).pairing).toMatchObject({ lead: { lane: 'lead', pacePerHour: 280800 } });
    await writeFile(join(root, 'queue/pairing-lanes.json'), JSON.stringify({ lanes: [{}] }));
    expect((await explainRoutes(root, 10000)).pairing).toBeNull();
    await writeFile(join(root, 'queue/pairing-lanes.json'), '{');
    expect((await explainRoutes(root, 10000)).pairing).toBeNull();
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
