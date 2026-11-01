/** Bounded, allowlisted queue and planner projection shared by status replies. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseReadyTsv, type FleetLaneQueueRow } from '../fleet/lane-console.js';
import { readPlannerHealth, type PlannerHealth } from '../fleet/planner-failover.js';
import { readSource } from '../fleet/runs-parked-queue.js';

export interface StatusSupply {
  v: 1;
  sourceState: 'healthy' | 'missing' | 'degraded';
  lanes: { lane: string; phxReady: number; fillerReady: number }[];
  planner: {
    status: 'ok' | 'failing' | 'unknown';
    lastGoodPassAt: string | null;
    reason: string | null;
    /** Failure streak start, distinct from the last successful pass. */
    failingSince?: string | null;
  };
}

const LANES = ['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local'] as const;
const FAIL_REASONS = ['usage-limit', 'auth-rejected', 'executor-fail'] as const;
const UNKNOWN_REASONS = ['missing-events-log', 'unreadable-events-log', 'no-leader-rows', 'unavailable'] as const;
const unknownPlanner: StatusSupply['planner'] = { status: 'unknown', lastGoodPassAt: null, reason: 'unavailable' };

export function summarizeStatusSupply(rows: FleetLaneQueueRow[], health: PlannerHealth, sourceState: StatusSupply['sourceState']): StatusSupply {
  const lanes: StatusSupply['lanes'] = [];
  for (const lane of LANES) {
    let phxReady = 0;
    let fillerReady = 0;
    for (const row of rows) {
      // Some queues encode a parked status in the pool cell itself.
      if (row.status !== 'READY' || /^PARKED[^.]*\./i.test(row.pool) || row.pool !== lane) continue;
      if (row.id?.startsWith('RQ-PHX-')) phxReady++;
      else fillerReady++;
    }
    if (phxReady || fillerReady) lanes.push({ lane, phxReady, fillerReady });
  }
  return {
    v: 1, sourceState, lanes,
    planner: { status: health.status, lastGoodPassAt: health.lastGoodPassAt, failingSince: health.failingSince, reason: health.reason },
  };
}

export async function readStatusSupply(runsDir: string | undefined, now: () => Date): Promise<StatusSupply> {
  try {
    const root = runsDir ?? join(homedir(), '.ashlr-runs');
    const [source, planner] = await Promise.all([
      readSource(join(root, 'queue', 'ready.tsv'), 2 * 1024 * 1024, false),
      readPlannerHealth(root, now().getTime()).catch(() => null),
    ]);
    const parsed = parseReadyTsv(source.text);
    const state = source.state === 'healthy' && parsed.dropped ? 'degraded' : source.state;
    return summarizeStatusSupply(parsed.rows, planner ?? { ...unknownPlanner, failingSince: null, resetAt: null }, state);
  } catch {
    return { v: 1, sourceState: 'degraded', lanes: [], planner: { ...unknownPlanner } };
  }
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Project again at the output boundary, including for injected readers. */
export function supplyLines(s: StatusSupply): [string, string] {
  let supply = 'Supply: unavailable';
  if (s?.sourceState === 'healthy' && Array.isArray(s.lanes)) {
    const items: string[] = [];
    for (const lane of LANES) {
      const entries = s.lanes.filter(item => item?.lane === lane);
      if (entries.length !== 1) continue;
      const item = entries[0]!;
      if (!Number.isSafeInteger(item.phxReady) || item.phxReady < 0 || !Number.isSafeInteger(item.fillerReady) || item.fillerReady < 0) continue;
      if (item.phxReady || item.fillerReady) items.push(`${lane} ${item.phxReady}${items.length ? '' : ' phantom'} / ${item.fillerReady}${items.length ? '' : ' filler'}`);
    }
    supply = items.length ? `Supply: ${items.join('; ')}` : 'Supply: none ready';
  }
  const planner = s?.planner;
  const good = iso(planner?.lastGoodPassAt);
  const since = iso(planner?.failingSince);
  let line = 'Planner: unknown (unavailable)';
  if (planner?.status === 'ok' && good) line = `Planner: last good pass ${good}`;
  else if (planner?.status === 'failing' && since && FAIL_REASONS.some(reason => reason === planner.reason)) line = `Planner: failing (${planner.reason}) since ${since}`;
  else if (planner?.status === 'unknown' && UNKNOWN_REASONS.some(reason => reason === planner.reason)) line = `Planner: unknown (${planner.reason})`;
  return [supply, line];
}
