/**
 * The Pulse strip, first thing on the desktop Home and the phone Home: four big numbers with a 24 hour sparkline each,
 * the things we optimize for. PRs merged per hour, median minutes from publish to merge, EMPTY %, jobs running of capacity.
 * Built only on `phm fleet pulse --lanes --json` (fleet.pulse.lanes.v1), its `totals`. Read-only. Unknown reads "unknown",
 * never 0; running vs capacity keeps no history, so it says so instead of drawing a line.
 */
import { PULSE_ALERTS_SCHEMA, type PulseAlertsV1 } from '../../../../core/fleet/pulse-alerts.js';
import { PULSE_LANES_SCHEMA, type PulseLanesV1 } from '../../../../core/fleet/pulse-lanes.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

export const PULSE_LANES_PATH = '/api/verse/fleet/runs/pulse/lanes';
export const pulseLanesQuery: QueryDef<PulseLanesV1> = { key: 'fleet-pulse-lanes', fetch: signal => apiGet(PULSE_LANES_PATH, signal) };

export const PULSE_ALERTS_PATH = '/api/verse/fleet/runs/pulse/alerts';
export const pulseAlertsQuery: QueryDef<PulseAlertsV1> = { key: 'fleet-pulse-alerts', fetch: signal => apiGet(PULSE_ALERTS_PATH, signal) };

/** Only a well-formed fleet.pulse.alerts.v1 payload is an alert list. */
export function alertsOf(data: unknown): PulseAlertsV1 | null {
  if (data === null || typeof data !== 'object') return null;
  const read = data as Partial<PulseAlertsV1>;
  return read.schema === PULSE_ALERTS_SCHEMA && read.v === 1 && Array.isArray(read.alerts) && Array.isArray(read.unknown) ? read as PulseAlertsV1 : null;
}

/** The red row under the strip: one line per active alert, each with its fix. Nothing is drawn when there are none;
 * checks that could not be made say so, because silence there would read as fine. */
export function PulseAlertsRow({ visible = true }: { visible?: boolean }) {
  const read = useQuery(pulseAlertsQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(pulseAlertsQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const pulse = alertsOf(read.data);
  if (!pulse || (!pulse.alerts.length && !pulse.unknown.length)) return null;
  return <div className={styles.alerts} aria-label="Pulse alerts">
    {pulse.alerts.length ? <ul role="alert" className={styles.alertList}>
      {pulse.alerts.map(a => <li key={`${a.kind}:${a.lane}`}><strong>{a.detail}</strong> <span>{a.fix_hint}</span></li>)}
    </ul> : null}
    {pulse.unknown.length ? <p className={styles.tileNote} data-unknown>Not checked: {pulse.unknown.join(' ')}</p> : null}
  </div>;
}

export interface StripTile { title: string; value: string; note: string; series: (number | null)[]; known: boolean }

const minutes = (s: number): string => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`;

/** Only a well-formed fleet.pulse.lanes.v1 payload is a pulse. */
export function lanesPulseOf(data: unknown): PulseLanesV1 | null {
  if (data === null || typeof data !== 'object') return null;
  const pulse = data as Partial<PulseLanesV1>;
  return pulse.schema === PULSE_LANES_SCHEMA && pulse.v === 1 && !!pulse.totals?.series && Array.isArray(pulse.lanes) ? pulse as PulseLanesV1 : null;
}

/** Pure: the four tiles for this pulse, in the order they are drawn. */
export function stripTiles(pulse: PulseLanesV1): StripTile[] {
  const { totals: t } = pulse;
  const readable = t.merged !== null;
  const gone = readable ? '' : 'The job metrics file could not be read.';
  const empty = t.finished === null ? gone : t.finished === 0 ? 'No job finished in this window.' : `${t.empty_rate === null ? 0 : Math.round(t.empty_rate * (t.finished))} of ${t.finished} finished jobs were EMPTY.`;
  return [
    { title: 'Merged per hour', value: t.merged_per_h === null ? 'unknown' : String(t.merged_per_h), series: t.series.merged_per_h, known: t.merged_per_h !== null,
      note: readable ? `${t.merged} PRs in ${pulse.window_h} hours.` : gone },
    { title: 'Minutes to merge', value: t.median_open_to_merge_s === null ? 'unknown' : minutes(t.median_open_to_merge_s), series: t.series.median_open_to_merge_s, known: t.median_open_to_merge_s !== null,
      note: readable ? (t.median_open_to_merge_s === null ? 'No merged PR with a known publish time.' : 'Half of PRs merge this fast after publishing.') : gone },
    { title: 'EMPTY', value: t.empty_rate === null ? 'unknown' : `${Math.round(t.empty_rate * 100)}%`, series: t.series.empty_rate, known: t.empty_rate !== null, note: empty },
    { title: 'Running of capacity', value: t.running === null ? 'unknown' : `${t.running} of ${t.capacity ?? 'unknown'}`, series: [], known: t.running !== null,
      note: 'Now. No history is kept for this one.' },
  ];
}

/** A line through the known hours; hours with no value leave a gap. */
export function StripSpark({ values, label }: { values: readonly (number | null)[]; label: string }) {
  const known = values.filter((v): v is number => v !== null);
  if (values.length < 2 || known.length < 2) return <span className={styles.tileNote}>{values.length < 2 ? '' : 'Not enough hours to draw.'}</span>;
  const max = Math.max(1, ...known);
  const runs: string[][] = [[]];
  values.forEach((v, i) => {
    if (v === null) { if (runs[runs.length - 1]!.length) runs.push([]); return; }
    runs[runs.length - 1]!.push(`${(i / (values.length - 1)) * 96 + 2},${22 - (v / max) * 20}`);
  });
  return <svg className={styles.spark} viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label={`${label} over 24 hours: ${values.map(v => v ?? 'unknown').join(', ')}`}>
    {runs.filter(run => run.length).map(run => <polyline key={run[0]} points={run.length === 1 ? `${run[0]} ${run[0]}` : run.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
  </svg>;
}

export function PulseStrip({ visible = true }: { visible?: boolean }) {
  const read = useQuery(pulseLanesQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(pulseLanesQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const pulse = lanesPulseOf(read.data);
  if (!pulse) {
    // Before the first read, or any other payload (an older server), the strip stays hidden.
    if (read.status !== 'error') return null;
    return <section className={styles.card} aria-label="Pulse strip"><p data-unknown>Unknown: the throughput numbers could not be read.</p></section>;
  }
  return <section aria-label="Pulse strip">
    <ul className={styles.strip}>
      {stripTiles(pulse).map(tile => <li key={tile.title} className={styles.tile} aria-label={tile.title}>
        <span className={styles.tileTitle}>{tile.title}</span>
        <span className={styles.tileValue}>{tile.known ? tile.value : <span data-unknown>unknown</span>}</span>
        {tile.series.length ? <StripSpark values={tile.series} label={tile.title} /> : null}
        <span className={styles.tileNote} data-unknown={tile.known ? undefined : true}>{tile.note}</span>
      </li>)}
    </ul>
    <PulseAlertsRow visible={visible} />
  </section>;
}
