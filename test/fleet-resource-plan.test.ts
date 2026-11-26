import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as nodesView from '../src/core/fleet/nodes-view.js';
import { buildFleetResourcePlan, readFleetResourcePlan, writeFleetResourceAdvice } from '../src/core/usage/resource-live/fleet-plan.js';
import { resourceLivePath } from '../src/core/usage/resource-live/store.js';
import { routeExpiringCapacity } from '../src/core/fleet/resource-queue-route.js';
import { readUnfedReport } from '../src/core/fleet/unfed-read.js';
import { recordLeaderBoard } from '../src/core/fleet/leader-board.js';
import { readFleetBoard } from '../src/core/fleet/leader-journal.js';

const now = Date.parse('2030-01-01T00:00:00Z');
const hr = 3_600_000, iso = (ms: number) => new Date(ms).toISOString();
const lanes = ['codex-personal', 'agy'];
const deadline = iso(now + 2 * hr);
const node: nodesView.NodeRow = { name: 'fixture', isSelf: true, reachable: true, lastSeen: iso(now), heartbeatAgeSeconds: 0,
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
  it('suggests upgrading an old Codex CLI without reporting an empty bank', () => {
    const plan = buildFleetResourcePlan(live, [node], status(), ledger, now, [], {
      observed_at: null, grants: null, queued: null, unknown_reason: 'codex-cli-too-old (<0.172.0)',
    });
    expect(plan.codex_reset_bank).toEqual({ count: null, unknown_reason: 'codex-cli-too-old (<0.172.0)',
      hint: 'Upgrade codex-cli to 0.172.0 or newer to read the reset bank.' });
    expect(plan.reset_proposal).toBeNull();
  });

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

  it('excludes bundle and member finishes from standalone throughput and mixed quota estimates', () => {
    const batch = { event: 'finish', lane: 'codex-personal', ts: iso(now - hr / 8) };
    for (const bundled of [
      { ...batch, batch_size: 4, wall_s: null, tokens_total: 24000 },
      { ...batch, bundle: 'B1', wall_s: 10, tokens_total: 24000 },
    ]) {
      const plan = buildFleetResourcePlan(live, [node], status(), {
        ...ledger, text: `${ledger.text}\n${JSON.stringify(bundled)}`,
      }, now);
      expect(plan.lanes.find(row => row.lane === batch.lane)).toMatchObject({
        jobs_sampled: 2, token_jobs_sampled: 2, minutes_per_job: 20, tokens_per_job: 6000, additional_slots: null,
      });
      expect(plan.allowances.find(row => row.id === batch.lane)).toMatchObject({
        measured_jobs_for_quota: 2, estimated_quota_per_job: null, projected_waste_at_deadline: null,
      });
      expect(plan.allowances.find(row => row.id === 'antigravity')?.estimated_quota_per_job).toBe(5);
    }

    const olderBatch = { ...batch, ts: iso(now - 2 * hr), batch_size: 4, wall_s: 600 };
    const plan = buildFleetResourcePlan(live, [node], status(), {
      ...ledger, text: `${JSON.stringify(olderBatch)}\n${ledger.text}`,
    }, now);
    expect(plan.allowances.find(row => row.id === batch.lane)?.estimated_quota_per_job).toBe(5);
  });

  it('keeps advisory unfed slots unknown when only the dispatcher total is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-unfed-ready-'));
    try {
      await mkdir(join(dir, 'queue'));
      const snapshot = status();
      const plan = buildFleetResourcePlan(live, [node], snapshot, ledger, now);
      await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
        ...snapshot,
        lanes: { agy: { ...snapshot.lanes['agy'], target: 2 } },
        unfed_capacity: { waiting: 2, lanes: { agy: { waiting_elsewhere: 1 } } },
      }));
      const options = { runsDir: dir, now: () => now, readCapacity: async () => plan };
      const missing = await readUnfedReport(options);
      expect(missing).toMatchObject({ source: 'dispatcher', waiting: 2, unfedSlots: 1 });
      expect(missing.resourcePlan).toContainEqual({ lane: 'agy', running: 1, target: 2, unfedSlots: null });

      await writeFile(join(dir, 'queue/ready.tsv'), '');
      const empty = await readUnfedReport(options);
      expect(empty).toMatchObject({ source: 'dispatcher', waiting: 2, unfedSlots: 1 });
      expect(empty.resourcePlan).toContainEqual({ lane: 'agy', running: 1, target: 2, unfedSlots: 0 });

      await writeFile(join(dir, 'queue/ready.tsv'), 'example\tphantom\tcodex-personal\twork\tfixture.md\n');
      const observed = await readUnfedReport(options);
      expect(observed.resourcePlan).toContainEqual({ lane: 'agy', running: 1, target: 2, unfedSlots: 1 });
    } finally { await rm(dir, { recursive: true, force: true }); }
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

  it('reroutes eligible rows once toward the earliest included deadline and shares the plan with readers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-capacity-route-'));
    const nodes = vi.spyOn(nodesView, 'readNodesView').mockReturnValue({ nodes: [node] } as nodesView.NodesView);
    try {
      await Promise.all(['queue', 'metrics', 'state'].map(path => mkdir(join(dir, path))));
      const write = (path: string, value: unknown) => writeFile(join(dir, path), JSON.stringify(value));
      const dispatch = { ...status(), paused: null, admission: { admit: true, decision: 'admit' },
        lanes: Object.fromEntries(lanes.map(lane => [lane, { ...status().lanes[lane], target: 2, queued: 0 }])) };
      await write('queue/status.json', dispatch);
      await write('queue/slots.json', {
        agy: { cost_class: 'included', capabilities: ['git'], tiers: ['work'], data_class: 'internal' },
        'codex-personal': { cost_class: 'included', capabilities: ['git'], tiers: ['work'], data_class: 'internal' },
      });
      const row = (id: string, spec: object, tier = 'work') => `${id}\tphantom\t\t${tier}\tfixture.md\t${JSON.stringify(spec)}\n`;
      const spec = { needs: ['git'], data_class: 'internal', min_tier: 'work', exclusive: false };
      const ineligible = row('cap', { needs: ['missing'] }) + row('private', { data_class: 'restricted' }) +
        row('alone', { exclusive: true }) + row('tier', {}, 'frontier') +
        row('PARKED-dep', {}) + row('retired', {}) + row('held', {});
      const ready = '# original\n' + ineligible + row('first', spec) + row('second', spec);
      await writeFile(join(dir, 'queue/ready.tsv'), ready);
      await writeFile(join(dir, 'queue/RETIRED'), 'retired\n');
      await writeFile(join(dir, 'queue/router-queue.md'), '- HOLD-SECURITY held (tier=work): needs review\n');
      await writeFile(join(dir, 'metrics/jobs.jsonl'), ledger.text + '\n');
      const sooner = iso(now + hr);
      await writeFile(resourceLivePath(dir), JSON.stringify({
        ...live,
        readings: readings.map(row => row.id === 'antigravity' ? { ...row, reset_at: sooner } : row),
        history: { ...live.history, antigravity: live.history.antigravity!.map(row => ({ ...row, reset_at: sooner })) },
      }));
      const plan = await readFleetResourcePlan(dir, now);
      expect(plan.lanes.filter(lane => lanes.includes(lane.lane)).map(lane => [lane.queued_jobs, lane.additional_slots])).toEqual([[2, 1], [2, 1]]);
      const readCapacity = async () => plan;
      const unfed = await readUnfedReport({ runsDir: dir, now: () => now, readCapacity });
      expect(unfed.resourcePlan).toContainEqual({ lane: 'agy', running: 1, target: 2, unfedSlots: 1 });
      const board = await recordLeaderBoard({ runsDir: dir, nowMs: now, readCapacity });
      expect(board).toMatchObject({ wrote: true, board: { resourcePlan: { lanes: expect.arrayContaining([
        { lane: 'agy', running: 1, target_concurrency: 2 },
      ]), deadlines: expect.arrayContaining([expect.objectContaining({ lane: 'agy', projected_waste_at_deadline: 75 })]) } } });
      expect((await readFleetBoard({ runsDir: dir })).board?.resourcePlan).toEqual(board.wrote && board.board.resourcePlan);
      const busy = async () => ({ quiet: false, release: async () => {} });
      const quiet = async () => ({ quiet: true, release: async () => {} });
      expect(await routeExpiringCapacity(dir, plan, () => now, busy)).toEqual([]);
      await writeFile(join(dir, 'PAUSE'), '');
      expect(await routeExpiringCapacity(dir, plan, () => now, quiet)).toEqual([]);
      await rm(join(dir, 'PAUSE'));
      const receipts = await routeExpiringCapacity(dir, plan, () => now, quiet);
      expect(receipts.map(r => [r.job, r.target_lane])).toEqual([['first', 'agy'], ['second', 'codex-personal']]);
      expect(receipts[0]).toMatchObject({ schema: 'work-market.v1', event: 'queue_reroute',
        reason_codes: ['resource_plan_under_target', 'expiring_included_quota'], deadline_at: iso(now + hr) });
      expect(await readFile(join(dir, 'metrics/work-market.jsonl'), 'utf8')).toBe(receipts.map(r => JSON.stringify(r) + '\n').join(''));
      expect(await readFile(join(dir, 'queue/ready.tsv.bak'), 'utf8')).toBe(ready);
      const updated = await readFile(join(dir, 'queue/ready.tsv'), 'utf8');
      expect(updated).toContain(ineligible);
      expect(updated).toContain(`first\tphantom\tagy\twork\tfixture.md\t${JSON.stringify({ ...spec, preferred_lane: 'agy', max_cost_class: 'included' })}`);
      expect(await routeExpiringCapacity(dir, plan, () => now, quiet)).toEqual([]);
    } finally { nodes.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
});
