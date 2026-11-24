import { poolSentence, queuedText, slotsText, SPENDDOWN_SCHEMA, type SpendDownRow, type SpendDownV1 } from '../../../../core/fleet/pools-spenddown.js';
import { PACE_SCHEMA, paceSentence, paceWord, type FleetPaceV1 } from '../../../../core/fleet/pace-verdict.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './SpendDownChart.module.css';

/** GET /api/app/pools/spenddown as a cached query, shared by the desktop usage panel and the phone Home card. */
export const spendDownQuery: QueryDef<SpendDownV1> = {
  key: 'app-pools-spenddown',
  fetch: async signal => {
    const data = await apiGet<SpendDownV1>('/api/app/pools/spenddown', signal);
    // A drifted payload is loud, not a blank chart.
    if (data?.schema !== SPENDDOWN_SCHEMA || !Array.isArray(data.pools)) throw new Error(`Expected ${SPENDDOWN_SCHEMA}`);
    return data;
  },
};

/** GET /api/fleet/pace (`phm fleet pace --json`): the ahead / behind / on pace verdict per pool. */
export const paceQuery: QueryDef<FleetPaceV1> = {
  key: 'fleet-pace',
  fetch: async signal => {
    const data = await apiGet<FleetPaceV1>('/api/fleet/pace', signal);
    if (data?.schema !== PACE_SCHEMA || !Array.isArray(data.pools)) throw new Error(`Expected ${PACE_SCHEMA}`);
    return data;
  },
};

const pct = (frac: number | null): string => frac === null ? 'unknown' : `${Math.round(frac * 100)}%`;
const left = (frac: number): string => `${Math.min(100, Math.max(0, frac * 100))}%`;

function describe(row: SpendDownRow): string {
  if (row.used_frac === null) return `${row.label}: ${row.verdict}`;
  return `${row.label}: ${pct(row.used_frac)} used, even pace ${pct(row.even_pace_frac)}, ends near ${pct(row.projected_at_reset)} at reset. ${row.verdict}`;
}

/** Reads only pools.spenddown.v1: nothing is derived here, an unknown share draws no fill, tick or marker. */
export function SpendDownChart({ data, pace }: { data: SpendDownV1; pace?: FleetPaceV1 | null }) {
  if (data.pools.length === 0) return null;
  return <div className={styles.chart} data-testid="spenddown-chart">
    {data.pools.map(row => { const verdict = pace?.pools.find(p => p.pool === row.id); return <div className={styles.row} key={row.id} data-state={row.state}>
      <div className={styles.head}><span className={styles.label} data-testid="spenddown-sentence">{row.sentence ?? poolSentence(row)}</span>
        {row.state === 'idle' || row.blocked ? <span className={styles.verdict}>{row.verdict}</span> : null}</div>
      {verdict ? <span className={styles.pace_line} data-testid="pace-sentence" data-pace={verdict.state} data-over={verdict.verdict === 'over' || undefined}><strong>{verdict.verdict ?? paceWord(verdict.state)}</strong>{' '}{verdict.line ?? paceSentence(verdict)}</span> : null}
      {row.blocked_fix ? <span className={styles.reset} data-testid="spenddown-blocked">{row.blocked_fix}</span> : null}
      {row.running !== undefined ? <span className={styles.reset} data-testid="spenddown-slots">{slotsText(row.running, row.target ?? null, row.queued_rows ?? null)}</span> : null}
      {row.queued_hours !== undefined ? <span className={styles.reset} data-testid="spenddown-queued">{queuedText(row.queued_hours)}</span> : null}
      <div className={styles.track} role="img" aria-label={describe(row)}>
        {row.used_frac !== null ? <span className={styles.used} style={{ width: left(row.used_frac) }} /> : null}
        {row.used_frac !== null && row.even_pace_frac !== null ? <span className={styles.pace} data-mark="even-pace" style={{ left: left(row.even_pace_frac) }} /> : null}
        {row.used_frac !== null && row.projected_at_reset !== null ? <span className={styles.projected} data-mark="projected" style={{ left: left(row.projected_at_reset) }} /> : null}
      </div>
    </div>; })}
    <p className={styles.key}>Bar: share of the plan used. Line: where an even pace would be by now. Diamond: where it ends at reset. Running: jobs on the lane now, of its slots. Queued: rows waiting for it.</p>
  </div>;
}
