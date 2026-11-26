import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { capServesLane, defaultNodesViewDeps, readNodesView, type NodeRow } from '../../fleet/nodes-view.js';
import { readJobsTail, type JobsTailRead } from '../../fleet/report-ledger.js';
import { readResourceQueue } from '../../fleet/resource-queue.js';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { ANTIGRAVITY_EXHAUSTION, antigravityQuota } from './antigravity-quota.js';
import { planBurnDown } from './burn-down.js';
import { codexResetBankUpgradeHint, planBankedReset, readBankedResets } from './banked-resets.js';
import { readCustomResources } from './custom.js';
import { parseResourceLiveSidecar, readPrivateJson, readResourceLiveFile, unverified } from './store.js';
import { RESOURCE_LIVE_ALLOWANCES, type ResourceLiveAllowance } from './types.js';

export const FLEET_RESOURCE_PLAN_SCHEMA = 'phantom.fleet-resource-plan.v1';
const MINUTE = 60_000;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) ? number(value) : null;
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
const round = (n: number): number => Number(n.toFixed(3));

interface Finish { lane: string; at: number; minutes: number; tokens: number | null; fable: boolean }
function finishes(ledger: JobsTailRead, now: number): Finish[] {
  const out: Finish[] = [];
  for (const line of ledger.text?.split('\n') ?? []) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(line)); } catch { continue; }
    const at = time(row['ts']), seconds = number(row['wall_s']);
    if (row['event'] !== 'finish' || typeof row['lane'] !== 'string' || !Number.isFinite(at) ||
      at > now || at < now - 7 * 1440 * MINUTE || seconds === null || seconds === 0) continue;
    out.push({ lane: row['lane'], at, minutes: seconds / 60, tokens: number(row['tokens_total']), fable: row['sublane'] === 'fable' });
  }
  return out;
}

function machine(node: NodeRow) {
  const cpu = number(node.cpuHeadroomPercent), memory = number(node.freeMemoryPercent);
  const free = count(node.freeSlots), running = Array.isArray(node.jobsRunning) ? node.jobsRunning.length : null;
  const additional = node.stateCode === 'offline' || node.stateCode === 'held' || node.phantom === 'not-running' ||
    (node.reachable === true && (cpu === 0 || memory === 0 || free === 0)) ? 0
    : node.stateCode === 'ready' && cpu !== null && memory !== null ? free : null;
  return { name: node.name, lanes: Array.isArray(node.lanes) ? node.lanes : null, cpu_headroom_pct: cpu,
    memory_headroom_pct: memory, max_concurrency: free === null || running === null ? null : free + running,
    available_slots: additional };
}

export function buildFleetResourcePlan(raw: unknown, nodes: NodeRow[], status: unknown, ledger: JobsTailRead, now: number,
  custom: readonly ResourceLiveAllowance[] = [], resets?: Awaited<ReturnType<typeof readBankedResets>>,
  demand?: ReadonlyMap<string, readonly string[]>) {
  const sidecar = parseResourceLiveSidecar(raw, custom);
  const measured = new Map<string, typeof sidecar.readings[number]>(sidecar.readings.map(row => [row.id, row]));
  const readings = new Map([...RESOURCE_LIVE_ALLOWANCES, ...custom]
    .map(row => [row.id, measured.get(row.id) ?? unverified(row, 'source-returned-nothing')]));
  const plan = planBurnDown([...readings.values()], sidecar.history, now);
  const machines = nodes.map(machine);
  const slots = machines.map(row => row.available_slots);
  const jobs = finishes(ledger, now);
  const dispatch = object(status);
  const age = now - time(dispatch['last_tick']);
  const statusLanes = dispatch['schema'] === 'dispatchd.status.v1' && age >= 0 && age < 5 * MINUTE ? object(dispatch['lanes']) : {};
  const antigravity = antigravityQuota(measured.get('antigravity'), now);
  const laneNames = [...new Set([...plan.allowances.flatMap(row => row.lane ? [row.lane] : []), ...Object.keys(statusLanes)])];
  const lanes = laneNames.map(lane => {
    const row = object(statusLanes[lane]);
    const running = count(row['running']), ceiling = count(row['ceiling']), hard = count(row['hard_cap']);
    const cap = ceiling === null || hard === null ? null : Math.min(ceiling, hard);
    const held = typeof row['held'] === 'boolean' ? row['held'] || Boolean(dispatch['paused']) : null;
    const queued = demand?.get(lane)?.length ?? count(row['queued']);
    const recent = jobs.filter(job => job.lane === lane);
    const tokenJobs = recent.filter(job => job.tokens !== null);
    const exhaustedUntil = (lane === 'agy' || lane === 'agy-neon') ? antigravity.reset_at : null;
    return { lane, running, held, max_concurrency: cap, queued_jobs: queued,
      jobs_sampled: ledger.text === null ? null : recent.length,
      token_jobs_sampled: ledger.text === null ? null : tokenJobs.length,
      minutes_per_job: recent.length ? recent.reduce((sum, job) => sum + job.minutes, 0) / recent.length : null,
      tokens_per_job: tokenJobs.length ? tokenJobs.reduce((sum, job) => sum + job.tokens!, 0) / tokenJobs.length : null,
      target_concurrency: exhaustedUntil ? 0 : null as number | null, additional_slots: exhaustedUntil ? 0 : null as number | null,
      ...(exhaustedUntil ? { reason: ANTIGRAVITY_EXHAUSTION, reset_at: exhaustedUntil } : {}) };
  });
  const laneByName = new Map(lanes.map(lane => [lane.lane, lane]));
  const allowances = plan.allowances.map(row => {
    const reading = readings.get(row.id)!;
    const lane = row.lane ? laneByName.get(row.lane) : undefined;
    const deadline = time(row.deadline_at);
    const minutes = Number.isFinite(deadline) ? (deadline - now) / MINUTE : null;
    const points = (sidecar.history[row.id] ?? []).filter(point => point.reset_at === reading.reset_at &&
      time(point.observed_at) <= now).sort((a, b) => time(a.observed_at) - time(b.observed_at));
    const first = points[0], last = points.at(-1);
    const measured = first && last && time(first.observed_at) < time(last.observed_at) &&
      (!ledger.truncated || jobs.some(job => job.at <= time(first.observed_at)))
      ? jobs.filter(job => job.lane === row.lane && (row.id !== 'claude-fable' || job.fable) &&
        job.at > time(first.observed_at) && job.at <= time(last.observed_at)) : [];
    const spent = first && last ? last.used - first.used : null;
    const tokens = measured.every(job => job.tokens !== null) ? measured.reduce((sum, job) => sum + job.tokens!, 0) : 0;
    const tokenFit = tokens > 0 && lane?.tokens_per_job != null && lane.tokens_per_job > 0;
    const perJob = measured.length && spent !== null && spent > 0 && reading.unit !== 'models'
      ? tokenFit ? spent / tokens * lane!.tokens_per_job! : spent / measured.length : null;
    const jobsPerSlot = minutes === null || lane?.minutes_per_job == null ? null : Math.floor(minutes / lane.minutes_per_job);
    return { id: row.id, label: reading.label, class: reading.class, lane: row.lane, unit: row.unit, remaining: row.remaining, deadline_at: row.deadline_at,
      jobs_per_slot: jobsPerSlot, measured_jobs_for_quota: ledger.text === null ? null : measured.length,
      estimated_quota_per_job: perJob, estimate_basis: perJob === null ? null : tokenFit ? 'observed-quota-per-token' : 'observed-quota-per-finish',
      projected_jobs: null as number | null, projected_waste_at_deadline: null as number | null,
      action: row.action };
  });
  const resetProposal = resets ? planBankedReset({ ...resets, queued: demand?.get('codex-personal')?.length ?? resets.queued },
    plan.allowances, new Map([...readings].map(([id, row]) => [id, row.source])), now).proposal : null;
  const deadlines = new Map<string, number>();
  for (const row of allowances) {
    if (!row.lane || (row.class !== 'included' && row.class !== 'expiring') || row.action !== 'burn' ||
        row.jobs_per_slot === null || row.jobs_per_slot <= 0 || row.estimated_quota_per_job === null) continue;
    deadlines.set(row.lane, Math.min(time(row.deadline_at), deadlines.get(row.lane) ?? Infinity));
  }
  if (resetProposal) deadlines.set('codex-personal', Math.min(time(resetProposal.grant.expires_at), deadlines.get('codex-personal') ?? Infinity));
  const ordered = [...new Set([...plan.lane_order, ...laneNames])]
    .sort((a, b) => (deadlines.get(a) ?? Infinity) - (deadlines.get(b) ?? Infinity));
  const reserved = new Set<string>(), plannedJobs = new Map<string, number>();
  for (const name of ordered) {
    const lane = laneByName.get(name)!;
    if (lane.reason === ANTIGRAVITY_EXHAUSTION) continue;
    const candidates = allowances.filter(row => row.lane === name);
    const active = candidates.filter(row => row.action === 'burn' && row.remaining !== null && row.jobs_per_slot !== null &&
      row.jobs_per_slot > 0 && row.estimated_quota_per_job !== null);
    const eligible = machines.flatMap((row, index) => row.lanes?.some(cap => capServesLane(cap, name)) ? [index] : []);
    if (lane.running === null || lane.max_concurrency === null || lane.queued_jobs === null || lane.held === null) continue;
    if (lane.held || lane.queued_jobs === 0 || lane.running >= lane.max_concurrency || candidates.some(row => row.action === 'hold')) {
      lane.target_concurrency = lane.running;
      lane.additional_slots = 0;
      continue;
    }
    if (!active.length || !eligible.length || eligible.some(index => slots[index] === null)) continue;
    const need = Math.max(...active.map(row => Math.ceil(row.remaining! / row.estimated_quota_per_job! / row.jobs_per_slot!)));
    const total = eligible.reduce((sum, index) => sum + slots[index]!, 0);
    const available = demand?.get(name)?.filter(job => !reserved.has(job));
    const additional = Math.min(need, total, available?.length ?? lane.queued_jobs, Math.max(0, lane.max_concurrency - lane.running));
    if (available) {
      for (const job of available.slice(0, additional)) reserved.add(job);
      plannedJobs.set(name, additional);
    }
    lane.target_concurrency = lane.running + additional;
    lane.additional_slots = additional;
    let take = additional;
    for (const index of eligible.sort((a, b) => machines[a]!.lanes!.length - machines[b]!.lanes!.length)) {
      const used = Math.min(take, slots[index]!);
      slots[index] = slots[index]! - used;
      take -= used;
    }
  }
  for (const name of ordered) {
    const assigned = plannedJobs.get(name);
    const additional = laneByName.get(name)?.additional_slots;
    if (assigned === undefined || !additional) continue;
    const horizon = Math.max(1, ...allowances.filter(row => row.lane === name).map(row => row.jobs_per_slot ?? 0));
    const more = demand!.get(name)!.filter(job => !reserved.has(job)).slice(0, Math.max(0, additional * horizon - assigned));
    for (const job of more) reserved.add(job);
    plannedJobs.set(name, assigned + more.length);
  }
  for (const row of allowances) {
    const lane = row.lane ? laneByName.get(row.lane) : undefined;
    if (row.deadline_at === null || row.remaining === null) continue;
    if (row.remaining === 0) { row.projected_waste_at_deadline = 0; continue; }
    if (lane?.additional_slots === 0 || row.jobs_per_slot === 0) {
      row.projected_jobs = 0;
      row.projected_waste_at_deadline = row.remaining;
      continue;
    }
    if (lane?.additional_slots == null || lane.queued_jobs === null || row.jobs_per_slot === null || row.estimated_quota_per_job === null) continue;
    row.projected_jobs = Math.min(plannedJobs.get(lane.lane) ?? lane.queued_jobs, lane.additional_slots * row.jobs_per_slot);
    row.projected_waste_at_deadline = round(Math.max(0, row.remaining - row.projected_jobs * row.estimated_quota_per_job));
  }
  const resetReason = resets?.unknown_reason;
  const resetHint = codexResetBankUpgradeHint(resetReason);
  return { schema: FLEET_RESOURCE_PLAN_SCHEMA, generated_at: new Date(now).toISOString(),
    antigravity,
    ...(resetReason ? { codex_reset_bank: { count: null, unknown_reason: resetReason, ...(resetHint ? { hint: resetHint } : {}) } } : {}),
    reset_bank_deadlines: resets?.grants?.map(({ expires_at, count, kind }) => ({ expires_at, count, kind })) ?? null,
    reset_proposal: resetProposal,
    ledger_truncated: ledger.text === null ? null : ledger.truncated, machines,
    lanes: lanes.map(row => ({ ...row, minutes_per_job: row.minutes_per_job === null ? null : round(row.minutes_per_job),
      tokens_per_job: row.tokens_per_job === null ? null : round(row.tokens_per_job) })),
    allowances: allowances.map(row => ({ ...row,
      estimated_quota_per_job: row.estimated_quota_per_job === null ? null : round(row.estimated_quota_per_job) })) };
}

export async function readFleetResourcePlan(runsDir: string, now = Date.now()) {
  const [live, status, ledger, custom, resets] = await Promise.all([readResourceLiveFile(runsDir),
    readPrivateJson(join(runsDir, 'queue', 'status.json'), 1024 * 1024), readJobsTail(join(runsDir, 'metrics', 'jobs.jsonl')),
    readCustomResources(), readBankedResets(runsDir, now)]);
  const queue = await readResourceQueue(runsDir, now, status);
  const demand = queue && new Map([...queue.lanes.keys()].map(lane => [
    lane, queue.rows.filter(({ row, spec }) => (row.hint === lane || spec !== null) && queue.eligible(row, lane, false))
      .sort((a, b) => Number(b.row.hint === lane) - Number(a.row.hint === lane)).map(({ row }) => row.id),
  ] as const).filter(([lane]) => queue.lanes.get(lane)?.costClass === 'included'));
  return buildFleetResourcePlan(live, readNodesView(defaultNodesViewDeps()).nodes, status, ledger, now, custom, resets, demand ?? undefined);
}

export function writeFleetResourceAdvice(runsDir: string, plan: Awaited<ReturnType<typeof readFleetResourcePlan>>): void {
  const path = join(runsDir, 'queue', 'resource-capacity-advice.json');
  const document = { schema: FLEET_RESOURCE_PLAN_SCHEMA, generated_at: plan.generated_at,
    targets: Object.fromEntries(plan.lanes.filter(row => row.additional_slots !== null && row.additional_slots > 0)
      .map(row => [row.lane, row.target_concurrency])) };
  writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, JSON.stringify(document) + '\n',
    { anchorPath: runsDir, label: 'fleet resource advice' });
}
