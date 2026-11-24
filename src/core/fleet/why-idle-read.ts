import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { whyIdle, type WhyIdleBrief } from './why-idle.js';
import { scrubSecrets } from '../util/scrub.js';

/** Reuse the leader's bounded snapshot; expired or absent evidence explains nothing. */
export async function readWhyIdle(runsDir = defaultRunsDir(), now = Date.now()): Promise<string[]> {
  try {
    const source = await readSource(join(runsDir, 'queue/leader-brief.json'), 8192, false);
    if (source.state !== 'healthy') return [];
    const b = JSON.parse(source.text) as WhyIdleBrief & { schema: string };
    if (!b || typeof b !== 'object' || typeof b.at !== 'string') return [];
    const age = now - Date.parse(b.at);
    if (b.schema !== 'leader.compact-brief.v1' || !(age >= 0 && age <= 120_000)) return [];
    const row = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
    const count = (v: unknown) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (b.lanes !== undefined && (!Array.isArray(b.lanes) || !b.lanes.every(l => row(l) && typeof l.lane === 'string' && count(l.running) && count(l.target) && (l.held == null || typeof l.held === 'boolean') && count(l.pause_new_until) && count(l.queuedReady)))) return [];
    if (b.pools !== undefined && (!Array.isArray(b.pools) || !b.pools.every(p => row(p) && typeof p.pool === 'string' && typeof p.verdict === 'string' && count(p.usedPct)))) return [];
    if (b.attention !== undefined && (!Array.isArray(b.attention) || !b.attention.every(j => row(j) && typeof j.lane === 'string' && typeof j.status === 'string'))) return [];
    if (b.admission != null && (!row(b.admission) || (b.admission.lastWhy != null && typeof b.admission.lastWhy !== 'string') || !count(b.admission.settleSeconds) || !count(b.admission.startsPerHour))) return [];
    return whyIdle({ ...b, pools: [] }).map(scrubSecrets);

  } catch { return []; }
}
