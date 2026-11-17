import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LaneAllowanceRow, LaneAllowanceSnapshot } from '../../../../core/usage/lane-allowance.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useCapacityClock } from '../seat-subscription.js';
import { BurnSparkline } from './BurnSparkline.js';
import styles from './LaneAllowanceCards.module.css';

function postureText(row: LaneAllowanceRow): string {
  if (row.posture === 'burn') return row.projectedUnusedPct === null ? 'Burning: prioritizing expiring allowance.' : `Burning: ~${Math.round(row.projectedUnusedPct)}% would go unused at reset.`;
  if (row.posture === 'preserve') return 'Preserving: protecting allowance for higher-priority work.';
  if (row.posture === 'balanced') return 'Balanced: routing work at a sustainable pace.';
  return 'Unknown: no router posture has been recorded.';
}
const number = (n: number | null) => n === null ? 'unknown' : String(Number(n.toFixed(1)));
const postureLabels = { burn: 'Burning', balanced: 'Balanced', preserve: 'Preserving', unknown: 'Unknown' };
const costLabels = { included: 'Included', metered: 'Metered', 'api-credit': 'API credit', unknown: 'Cost unknown' };
const reasonLabels: Record<string, string> = {
  'reading-stale': 'Last reading is stale', 'reading-missing': 'Not measured yet',
  'reset-unknown': 'Reset time unknown', 'reading-incomplete': 'Reading is incomplete',
  'reset-passed': 'Recorded reset has passed', 'posture-unmeasured': 'Router posture not recorded',
};
const countdownText = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

export function LaneAllowanceCard({ row, now }: { row: LaneAllowanceRow; now: number }) {
  const description = useId();
  const age = row.measuredAt ? Math.max(0, Math.floor((now - Date.parse(row.measuredAt)) / 60_000)) : null;
  const stale = row.freshness === 'stale' || (row.measuredAt !== null && now - Date.parse(row.measuredAt) > 15 * 60_000);
  const countdown = (at: string) => countdownText(Date.parse(at) - now);
  const history = row.history;
  const preview = row.devin?.preview;
  const expired = preview && (preview.expired || now >= Date.parse(preview.expiresAt));
  const reason = row.reason ?? (row.postureReason === 'posture-unmeasured' ? row.postureReason : null);
  return <li className={styles.card} data-posture={row.posture} data-freshness={stale ? 'stale' : row.freshness} aria-label={row.label}>
    <header className={styles.header}><strong>{row.label}</strong>
      <span className={styles.chips}><span className={styles.chip} data-posture={row.posture} title={postureText(row)} aria-describedby={description}>{postureLabels[row.posture]}</span>
      <span className={styles.tag}>{costLabels[row.costClass]}</span></span></header>
    <span id={description} className={styles.hidden}>{postureText(row)}</span>
    <p>{row.usedPct === null ? 'unknown — not measured' : row.unit === 'percent' ? `${Math.round(row.usedPct)}% used · ${number(row.left)}% left` : `${number(row.used)} / ${number(row.limit)} ${row.unit === 'acu' ? 'ACU' : row.unit === 'usd' ? 'USD' : row.unit ?? ''} · ${number(row.left)} left`}</p>
    <div className={styles.track} data-unknown={row.usedPct === null} role="img" aria-label={row.usedPct === null ? 'Usage unknown' : `${Math.round(row.usedPct)}% used`}>
      {row.usedPct !== null ? <span style={{ width: `${Math.max(0, Math.min(100, row.usedPct))}%` }} /> : null}
    </div>
    <div className={styles.meta}><span>{row.resetAt ? `Resets in ${countdown(row.resetAt)}` : 'Reset unknown'}</span>
      <span>{age === null ? 'Not measured' : `measured ${age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`} ago`}{stale ? ' · stale' : ''}</span></div>
    {history && history.points.length >= 2 ? <BurnSparkline now={now} history={{ points: history.points.map(p => ({ t: Date.parse(p.observedAt), fraction: p.limit > 0 ? p.used / p.limit : 0, gapBefore: p.gapBefore })), burnPerHour: history.burn?.perHour ?? null, exhaustAt: history.exhaustAt, resetAt: history.resetAt }} /> : null}
    {row.devin ? <div className={styles.details}>
      <span>Weekly ACUs: {number(row.devin.weeklyUsedAcu)} / {number(row.devin.weeklyAllowanceAcu)}</span>
      <span>In-flight reservations: {number(row.devin.inFlightReservations)}</span>
      {preview ? <span>{expired ? 'Preview expired' : `${preview.free === true ? 'Free preview' : 'Preview (free status unknown)'} ends in ${countdown(preview.expiresAt)}`}</span> : null}
    </div> : null}
    {reason ? <small className={styles.reason} data-reason={reason}>{reasonLabels[reason] ?? 'Reading unavailable'}</small> : null}
  </li>;
}

export function LaneAllowanceCards() {
  const [data, setData] = useState<LaneAllowanceSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const now = useCapacityClock(undefined, []);
  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController(); pending.current = request;
    setData(null); setFailed(false);
    void apiGet<LaneAllowanceSnapshot>('/api/usage/lanes', request.signal).then(value => {
      if (!request.signal.aborted) setData(value);
    }).catch(() => { if (!request.signal.aborted) setFailed(true); });
  }, []);
  useEffect(() => { refresh(); return () => pending.current?.abort(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  return <section className={styles.section} aria-label="Lane allowances"><h3>Lane allowances</h3>
    {!data ? <p role="status">{failed ? 'unknown — allowance readings unavailable' : 'Reading lane allowances…'}</p>
      : !data.lanes.length ? <p>No lane readings yet.</p> : <ul className={styles.grid}>{data.lanes.map(row => <LaneAllowanceCard key={row.lane} row={row} now={now} />)}</ul>}
  </section>;
}
