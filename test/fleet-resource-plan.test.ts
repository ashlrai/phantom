import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NodeRow } from '../src/core/fleet/nodes-view.js';
import { buildFleetResourcePlan, writeFleetResourceAdvice } from '../src/core/usage/resource-live/fleet-plan.js';

const now = Date.parse('2030-01-01T00:00:00Z');
const hr = 3_600_000, iso = (ms: number) => new Date(ms).toISOString();
const lanes = ['codex-personal', 'agy'];
const deadline = iso(now + 2 * hr);
const node: NodeRow = { name: 'fixture', isSelf: true, reachable: true, lastSeen: iso(now), heartbeatAgeSeconds: 0,
  phantom: 'running', freeMemoryBytes: 8_000_000_000, freeMemoryPercent: 60, load: 1, cpuHeadroomPercent: 75,
  lanes, jobsRunning: ['current'], freeSlots: 2, stateCode: 'ready', state: 'ready', joined: true, joinCommand: null };
const status = (last_tick = iso(now)) => ({ schema: 'dispatchd.status.v1', last_tick, lanes: Object.fromEntries(lanes.map(lane =>
  [lane, { running: 1, ceiling: 3, hard_cap: 2, held: false, queued: 10 }])) });
const readings = [{ id: 'codex-personal', used: 18 }, { id: 'antigravity', used: 20 }].map(row =>
  ({ ...row, verified: true, unit: 'percent', limit: 100, reset_at: deadline, expires_at: null, source: 'fixture', source_tier: 'official',
    observed_at: iso(now), confidence: 'high' }));
const live = { schema: 'resource-live.v1', generated_at: iso(now), readings, history: Object.fromEntries(readings.map(row =>
  [row.id, [{ observed_at: iso(now - hr), used: row.used - 10, reset_at: deadline },
    { observed_at: iso(now), used: row.used, reset_at: deadline }]])) };
const ledger = { missing: false, truncated: false, text: lanes.flatMap(lane => [4000, 8000].map((tokens_total, i) =>
  JSON.stringify({ event: 'finish', lane, ts: iso(now - (i + 1) * hr / 4), wall_s: 1200, tokens_total }))).join('\n') };

describe('fleet resource plan', () => {
  it('joins measured quota and job throughput with each lane cap and shared machine slots', async () => {
    const plan = buildFleetResourcePlan(live, [node], status(), ledger, now);
    expect(plan.machines).toEqual([{ name: 'fixture', lanes, cpu_headroom_pct: 75, memory_headroom_pct: 60,
      max_concurrency: 3, available_slots: 2 }]);
    for (const lane of lanes) expect(plan.lanes.find(row => row.lane === lane)).toMatchObject({
      running: 1, max_concurrency: 2, target_concurrency: 2, minutes_per_job: 20, tokens_per_job: 6000, additional_slots: 1,
    });
    expect(plan.allowances.find(row => row.id === 'codex-personal')).toMatchObject({ remaining: 82, deadline_at: deadline,
      estimated_quota_per_job: 5, estimate_basis: 'observed-quota-per-token', projected_jobs: 6, projected_waste_at_deadline: 52 });
    expect(plan.allowances.find(row => row.id === 'antigravity')?.projected_waste_at_deadline).toBe(50);
    const dir = await mkdtemp(join(tmpdir(), 'phantom-fleet-plan-'));
    try {
      await mkdir(join(dir, 'queue'));
      writeFleetResourceAdvice(dir, plan);
      expect(JSON.parse(await readFile(join(dir, 'queue/resource-capacity-advice.json'), 'utf8')))
        .toEqual({ schema: 'phantom.fleet-resource-plan.v1', generated_at: iso(now), targets: { 'codex-personal': 2, agy: 2 } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not double count shared slots and distinguishes unknown from known zero', () => {
    const plan = buildFleetResourcePlan(live, [{ ...node, freeSlots: 1 }], status(), ledger, now);
    expect(plan.lanes.find(row => row.lane === 'codex-personal')?.additional_slots).toBe(1);
    expect(plan.lanes.find(row => row.lane === 'agy')?.additional_slots).toBe(0);
    expect(plan.allowances.find(row => row.id === 'antigravity')?.projected_waste_at_deadline).toBe(80);
    const noEvidence = buildFleetResourcePlan(live, [{ ...node, cpuHeadroomPercent: 'unknown' }], status(),
      { missing: true, text: null, truncated: false }, now);
    expect(noEvidence.lanes.find(row => row.lane === 'agy')).toMatchObject({ target_concurrency: null, minutes_per_job: null, tokens_per_job: null });
    expect(noEvidence.allowances.find(row => row.id === 'antigravity')?.projected_waste_at_deadline).toBeNull();
    expect(buildFleetResourcePlan(live, [node], status(iso(now - hr)), ledger, now).lanes.every(row => row.target_concurrency === null)).toBe(true);
    expect(buildFleetResourcePlan(null, [], null, ledger, now).allowances.find(row => row.id === 'codex-personal')?.remaining).toBeNull();
  });

  it('includes an expiring reset proposal only when the allowance and bank evidence support it', () => {
    const reading = { ...readings[0]!, used: 95, source: 'codex-budget-overrides-weekly' };
    const weekly = { ...live, readings: [reading], history: { [reading.id]: [
      { observed_at: iso(now - hr), used: 90, reset_at: deadline },
      { observed_at: iso(now), used: 95, reset_at: deadline },
    ] } };
    const grant = { count: 1, kind: 'full', source: 'owner-screenshot', expires_at: iso(now + hr / 2) } as const;
    const bank = { observed_at: iso(now), grants: [grant], queued: 3 };
    const plan = (evidence: typeof bank) => buildFleetResourcePlan(weekly, [node], status(), ledger, now, [], evidence);
    expect(plan(bank).reset_proposal).toMatchObject({
      action: 'use-reset-now', requires_explicit_request: true, grant, window: 'weekly', queued_jobs: 3,
    });
    expect(plan({ ...bank, queued: 0 }).reset_proposal).toBeNull();
  });
});
