/** Home's Yield card: merged PRs per launch for every lane, best first, from the same report as `phm fleet yield --by lane`.
 * The server does all the counting and wording; this only draws it. One bar per lane with the merged count and empty rate as text;
 * a lane that merged nothing from 3 or more launches says "not paying off". On a phone (`compact`) the bars give way to the first line
 * and the top three lanes as sentences. Unknown stays unknown: an unreadable ledger says so, it never draws zero bars. */
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { LANE_YIELD_SCHEMA, type LaneYieldReport, type LaneYieldRow } from '../../../../core/fleet/lane-yield-board.js';
import styles from './home.module.css';
import bar from './lane-yield-card.module.css';

export const laneYieldQuery: QueryDef<LaneYieldReport> = { key: 'home-lane-yield', fetch: async signal => {
  const raw = await apiGet<Partial<LaneYieldReport> | null>('/api/fleet/lane-yield', signal);
  if (raw?.schema !== LANE_YIELD_SCHEMA || !Array.isArray(raw.lanes) || typeof raw.summary !== 'string') throw new Error('Lane yield unavailable.');
  return raw as LaneYieldReport;
} };

const TOP_ON_PHONE = 3;
/** Bar length as a share of the best lane, so the best lane fills the track. A lane with nothing merged has no bar. */
export const barPercent = (row: LaneYieldRow, best: number): number => best > 0 ? Math.round((row.merged_per_launch / best) * 100) : 0;
const rowText = (row: LaneYieldRow): string => `${row.merged} merged of ${row.launches} launches${row.empty_rate === null ? '' : `, ${Math.round(row.empty_rate * 100)}% empty`}`;

export function LaneYieldCard({ visible = true, compact = false }: { visible?: boolean; compact?: boolean }) {
  const read = useQuery(laneYieldQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(laneYieldQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = read.status !== 'error' && read.data?.schema === LANE_YIELD_SCHEMA ? read.data : null;
  const best = report?.lanes.reduce((max, row) => Math.max(max, row.merged_per_launch), 0) ?? 0;
  return <section className={styles.card} aria-label="Yield"><h3>Yield</h3>
    {report === null ? <p role="status">{read.status === 'error' ? 'Lane yield unknown (the report could not be read).' : 'Reading lane yield…'}</p>
      : !report.known ? <p>{report.summary}</p>
        : <>
          <p className={bar.summary}>{report.summary}</p>
          {compact ? <ul className={bar.sentences}>{report.lanes.slice(0, TOP_ON_PHONE).map(row => <li key={row.lane}>{row.sentence}</li>)}</ul>
            : <ul className={bar.rows}>{report.lanes.map(row => <li key={row.lane} className={bar.row} data-paying={!row.not_paying_off || undefined}>
              <span className={bar.lane}>{row.lane}</span>
              <span className={bar.track} role="img" aria-label={`${row.lane}: ${row.merged_per_launch.toFixed(2)} merged per launch`}>
                <span className={bar.fill} style={{ inlineSize: `${barPercent(row, best)}%` }} /></span>
              <span className={bar.figure}>{row.merged_per_launch.toFixed(2)}</span>
              <span className={bar.detail}>{rowText(row)}{row.not_paying_off ? <strong className={bar.warn}> · not paying off</strong> : null}</span>
            </li>)}</ul>}
        </>}
  </section>;
}
