/**
 * Lane allowances in the Resources drawer: a card per lane from `GET /api/usage/lanes`. Each card names the lane
 * beside its provider mark, states the measured share, and draws the shared usage-window bar (primitives/WindowBar):
 * used so far, what is on course to be used, what the router projects unused at the reset, and how far the
 * window's time has run. What each share may claim is decided in lane-allowance-model.ts. A lane with no usable
 * reading keeps its place with a hatched bar and the reason; it is never drawn as 0% used.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LaneAllowanceRow, LaneAllowanceSnapshot } from '../../../../core/usage/lane-allowance.js';
import { RESOURCE_LIVE_STALE_MS } from '../../../../core/usage/resource-live/types.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useCapacityClock } from '../seat-subscription.js';
import { BurnSparkline } from './BurnSparkline.js';
import { allowanceBar, barNeedsKey, laneReading } from './lane-allowance-model.js';
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
  'invalid-future': 'Clock skew / invalid timestamp',
};
const countdownText = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};
const localTime = (iso: string): string =>
  new Date(Date.parse(iso)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const poolBrand = (row: LaneAllowanceRow): string => row.resource?.provider
  ?? (row.lane === 'agy' || row.lane === 'google-workspace' ? 'gemini' : row.lane === 'dot' ? 'openai' : row.lane);
const sourceKinds = { official: 'Official', 'own-call': 'Derived', 'visible-window': 'Visible usage page', 'operator-entry': 'Operator / agent check' };
const sourceText = (row: LaneAllowanceRow) => row.resource?.source && row.resource.sourceTier
  ? `${sourceKinds[row.resource.sourceTier]} · ${row.resource.source}` : 'Source unknown';
const modelCount = (row: LaneAllowanceRow, invalid: boolean) => !invalid && row.unit === 'models' && row.limit !== null
  ? `${row.limit} ${row.limit === 1 ? 'model' : 'models'} available` : null;
const rateText = (row: LaneAllowanceRow) => row.resource?.burnPerHour == null ? 'Burn rate unknown'
  : `${number(row.resource.burnPerHour)} ${row.unit === 'percent' ? '%' : row.unit ?? ''}/h`;
const wasteText = (row: LaneAllowanceRow) => row.resource?.projectedUnused == null ? 'Projected waste unknown'
  : `${number(row.resource.projectedUnused)} ${row.unit === 'percent' ? '%' : row.unit ?? ''} projected unused`;

export function LaneAllowanceCard({ row, now }: { row: LaneAllowanceRow; now: number }) {
  const description = useId();
  const reading = laneReading(row, now);
  const { invalid, ageMinutes: age, stale, hasUsage } = reading;
  const countdown = (at: string) => countdownText(Date.parse(at) - now);
  const history = row.history;
  const preview = row.devin?.preview;
  const expired = preview && (preview.expired || now >= Date.parse(preview.expiresAt));
  const previewAt = preview?.evidence ? Date.parse(preview.evidence.observedAt) : NaN;
  const free = !invalid && preview?.free === true && !expired && Number.isFinite(Date.parse(preview.expiresAt))
    && preview.evidence?.accountId && preview.evidence.model && previewAt <= now && now - previewAt <= RESOURCE_LIVE_STALE_MS;
  const displayRow = { ...row, posture: hasUsage && !stale ? row.posture : 'unknown' as const };
  const cost = !invalid && (hasUsage || free) ? row.costClass : 'unknown';
  const reason = invalid ? 'invalid-future' : row.reason ?? (row.postureReason === 'posture-unmeasured' ? row.postureReason : null);
  const bar = allowanceBar(row, reading, now, localTime);
  const reset = row.resetAt ? Date.parse(row.resetAt) : NaN;
  return <li className={styles.card} data-posture={displayRow.posture} data-freshness={invalid ? 'invalid-future' : stale ? 'stale' : row.freshness} aria-label={row.label}>
    <header className={styles.header}><strong className={styles.name}><BrandMark brand={poolBrand(row)} size={14} />{row.label}</strong>
      <span className={styles.chips}><span className={styles.chip} data-posture={displayRow.posture} title={postureText(displayRow)} aria-describedby={description}>{postureLabels[displayRow.posture]}</span>
      <span className={styles.tag}>{costLabels[cost]}</span></span></header>
    <span id={description} className={styles.hidden}>{postureText(displayRow)}</span>
    <p className={styles.figure} data-unknown={!hasUsage || undefined}>{!hasUsage ? modelCount(row, invalid) ?? 'unknown — not measured' : row.unit === 'percent' ? `${Math.round(row.usedPct!)}% used · ${number(row.left)}% left` : `${number(row.used)} / ${number(row.limit)} ${row.unit === 'acu' ? 'ACU' : row.unit === 'usd' ? 'USD' : row.unit ?? ''} · ${number(row.left)} left`}</p>
    <WindowBar label={`${row.label} used`} valueText={bar.words} valueNow={bar.used} used={bar.used} more={bar.more} unused={bar.unused} elapsed={bar.elapsed} ending={bar.ending} />
    <div className={styles.meta}>
      <span className={styles.reset}><span>{!Number.isFinite(reset) ? 'Reset unknown' : reset <= now ? 'Reset time has passed' : `Resets in ${countdown(row.resetAt!)}`}</span>
        {Number.isFinite(reset) ? <time dateTime={row.resetAt!}>{localTime(row.resetAt!)}</time> : null}</span>
      <span>{invalid ? 'Timestamp rejected' : age === null ? 'Not measured' : `measured ${age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`} ago`}{stale ? ' · stale' : ''}</span></div>
    {row.resource ? <div className={styles.details}>
      {row.resource.expiresAt ? <span>{Date.parse(row.resource.expiresAt) > now ? 'Expires' : 'Expired'} <time dateTime={row.resource.expiresAt}>{localTime(row.resource.expiresAt)}</time></span> : null}
      <span>{sourceText(row)}</span>
      {!stale && !invalid && hasUsage ? <span>{rateText(row)} · {wasteText(row)}</span> : null}
    </div> : null}
    {bar.end ? <p className={styles.line} data-ending={bar.ending}>{bar.end}.</p> : null}
    {bar.pace ? <p className={styles.line} data-pace={bar.lead ?? 'unmeasured'}>{bar.pace}.</p> : null}
    {history && history.points.length >= 2 ? <BurnSparkline now={now} history={{ points: history.points.map(p => ({ t: Date.parse(p.observedAt), fraction: p.limit > 0 ? p.used / p.limit : 0, gapBefore: p.gapBefore })), burnPerHour: history.burn?.perHour ?? null, exhaustAt: history.exhaustAt, resetAt: history.resetAt }} /> : null}
    {row.devin ? <div className={styles.details}>
      <span>Weekly ACUs: {number(row.devin.weeklyUsedAcu)} / {number(row.devin.weeklyAllowanceAcu)}</span>
      <span>In-flight reservations: {number(row.devin.inFlightReservations)}</span>
      {preview ? <span>{expired ? 'Preview expired' : free ? `Free preview ends in ${countdown(preview.expiresAt)}` : 'Preview free status unknown'}</span> : null}
    </div> : null}
    {reason ? <small className={styles.reason} data-reason={reason}>{reasonLabels[reason] ?? 'Reading unavailable'}</small> : null}
  </li>;
}

export function PoolAllowanceBar({ expanded, lanes, now }: { expanded: boolean; lanes: readonly LaneAllowanceRow[]; now: number }) {
  return lanes.length ? <ul className={styles.poolBar} aria-label="Resource pool" data-expanded={expanded || undefined}>
    {lanes.map(row => {
      const reading = laneReading(row, now);
      const bar = allowanceBar(row, reading, now, localTime);
      const usage = reading.hasUsage ? `${number(row.used)} used · ${number(row.left)} left${row.unit ? ` (${row.unit})` : ''}`
        : modelCount(row, reading.invalid) ?? 'Usage unknown';
      const end = row.resource?.expiresAt ?? row.resetAt;
      const time = end ? `${row.resource?.expiresAt ? 'Expiry' : 'Reset'}: ${localTime(end)}` : 'Reset unknown';
      const freshness = reading.ageMinutes === null ? 'Not measured' : reading.stale ? 'Stale' : `Measured ${reading.ageMinutes}m ago`;
      const details = [time, reading.stale || reading.invalid ? null : rateText(row), reading.stale || reading.invalid ? null : wasteText(row),
        sourceText(row), freshness].filter(Boolean).join(' · ');
      return <li key={row.lane} title={`${row.label}: ${usage} · ${details}`} data-freshness={reading.stale ? 'stale' : row.freshness}>
        <span className={styles.poolName}><BrandMark brand={poolBrand(row)} size={14} /><span>{row.label}</span></span>
        <WindowBar label={`${row.label} used`} valueText={`${usage} · ${details}`} valueNow={bar.used} used={bar.used} more={bar.more} unused={bar.unused} />
        <span className={styles.poolDetail}>{usage} · {details}</span>
      </li>;
    })}
  </ul> : null;
}

export function LaneAllowanceCards() {
  const [data, setData] = useState<LaneAllowanceSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const now = useCapacityClock(undefined, []);
  // A refresh keeps the cards already on screen: they are replaced when the new read answers, and stay (with
  // a line saying so) when it fails. Each card ages its own reading, so a kept card can never pass as fresh.
  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController(); pending.current = request;
    void apiGet<LaneAllowanceSnapshot>('/api/usage/lanes', request.signal).then(value => {
      if (!request.signal.aborted) { setData(value); setFailed(false); }
    }).catch(() => { if (!request.signal.aborted) setFailed(true); });
  }, []);
  useEffect(() => { refresh(); return () => pending.current?.abort(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  const lanes = data?.lanes ?? [];
  const readings = lanes.map(row => laneReading(row, now));
  const measured = readings.filter(reading => reading.hasUsage).length;
  const keyed = lanes.some((row, index) => barNeedsKey(allowanceBar(row, readings[index]!, now, localTime)));
  return <section className={styles.section} aria-label="Lane allowances">
    <div className={styles.head}><h3>Lane allowances</h3>
      {lanes.length ? <span className={styles.count} data-allowance-count>{measured} of {lanes.length} measured</span> : null}</div>
    {!data ? <p role="status">{failed ? 'unknown — allowance readings unavailable' : 'Reading lane allowances…'}</p> : <>
      {failed ? <p role="status" className={styles.note} data-refresh="failed">The last refresh failed. Showing what was read <time dateTime={data.asOf}>{localTime(data.asOf)}</time>.</p> : null}
      {keyed ? <p className={styles.key} data-allowance-key>
        <span><WindowBarSwatch part="used" />used so far</span>
        <span><WindowBarSwatch part="more" />on course to be used</span>
        <span><WindowBarSwatch part="unused" />left unused at the reset</span>
        <span><WindowBarSwatch part="elapsed" />time gone in the window</span>
      </p> : null}
      {!lanes.length ? <p>No lane readings yet.</p> : <ul className={styles.grid}>{lanes.map(row => <LaneAllowanceCard key={row.lane} row={row} now={now} />)}</ul>}
    </>}
  </section>;
}
