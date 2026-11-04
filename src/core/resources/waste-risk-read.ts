/** Offline advisory evidence; no provider probes or dispatch authority. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultLaneTruthReaders, LANE_TRUTH_MAX_AGE_MS, type LaneState, type MeterSample } from '../fleet/lane-truth.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../fleet/runs-resource-ledger.js';
import { readLaneTargets } from '../fleet/runs-lane-targets.js';
import type { WasteRiskInput } from './waste-risk.js';

export interface WasteRiskFacts {
  lanes: readonly LaneState[];
  meters: readonly MeterSample[];
  ledger: ResourceLedgerV1;
  overageLanes?: readonly string[];
}
const sane = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function buildWasteRiskInputs(facts: WasteRiskFacts, nowIso: string): WasteRiskInput[] {
  const now = Date.parse(nowIso);
  return [...new Set([...facts.lanes.map(l => l.lane), ...facts.ledger.lanes.map(l => l.lane), ...facts.meters.map(m => m.provider)])].sort().map(lane => {
    const state = facts.lanes.find(l => l.lane === lane);
    const row = facts.ledger.lanes.find(l => l.lane === lane);
    const at = Date.parse(row?.observation?.asOf ?? facts.ledger.asOf ?? '');
    const fresh = at <= now && now - at <= LANE_TRUTH_MAX_AGE_MS;
    // The ledger labels these as weekly windows; percent units have limit 100.
    let used = fresh && row?.window === 'weekly' && sane(row.usedPct) && row.usedPct <= 100 ? row.usedPct : null;
    let reset = used !== null ? row?.resetAt ?? null : null;
    let start = reset && Number.isFinite(Date.parse(reset)) ? new Date(Date.parse(reset) - 7 * 86400_000).toISOString() : null;
    let burn: number | null = null;
    const samples = facts.meters.filter(m => m.provider === lane && sane(m.usedPercent) && m.usedPercent <= 100 && Date.parse(m.sampledAt) <= now)
      .sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt));
    const latest = samples[0];
    const minutes = Number(latest?.window.split(':')[1]);
    if (latest && now - Date.parse(latest.sampledAt) <= LANE_TRUTH_MAX_AGE_MS && minutes > 0 && latest.resetAt && Number.isFinite(Date.parse(latest.resetAt))) {
      used = latest.usedPercent;
      reset = latest.resetAt;
      start = new Date(Date.parse(reset) - minutes * 60_000).toISOString();
      const previous = samples.find(m => m.window === latest.window && m.resetAt === reset && Date.parse(m.sampledAt) < Date.parse(latest.sampledAt) && Date.parse(m.sampledAt) >= Date.parse(start!));
      if (previous && latest.usedPercent! >= previous.usedPercent!) burn = (latest.usedPercent! - previous.usedPercent!) / ((Date.parse(latest.sampledAt) - Date.parse(previous.sampledAt)) / 3600_000);
    }
    const paid = lane === 'claude-api' || row?.window === 'credits' || facts.overageLanes?.includes(lane) === true;
    return { lane, used, limit: used === null ? null : 100, window_start: start, reset_at: reset, now: nowIso,
      burn_per_hour: burn, per_job_cost: null, running: state?.running ?? 0,
      ceiling: state?.target ?? 0, held: state?.held !== false, credit_guard: null, overage_costs_money: paid };
  });
}

export async function readWasteRiskInputs(runsDir = join(homedir(), '.ashlr-runs'), nowIso = new Date().toISOString()): Promise<WasteRiskInput[]> {
  const readers = defaultLaneTruthReaders(homedir(), Date.parse(nowIso));
  const [ledger, meters, targets, localLanes] = await Promise.all([
    readResourceLedger({ runsDir, now: () => Date.parse(nowIso) }), readers.meters(),
    readLaneTargets({ runsDir }), runsDir === join(homedir(), '.ashlr-runs') ? readers.lanes() : Promise.resolve([]),
  ]);
  const lanes = runsDir === join(homedir(), '.ashlr-runs') ? localLanes : targets.lanes.map(l => ({ lane: l.lane, target: l.target, running: ledger.lanes.find(r => r.lane === l.lane)?.running ?? null, held: l.held, queued: null }));
  return buildWasteRiskInputs({ lanes, meters, ledger }, nowIso);
}
