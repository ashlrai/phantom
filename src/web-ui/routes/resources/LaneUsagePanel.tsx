import { useEffect, useMemo, useState } from 'react';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { buildLaneCards, formatCountdown, type LaneCardModel } from './fleet-usage-model.js';
import { fleetUsageQuery } from './fleet-usage-source.js';
import styles from './LaneUsagePanel.module.css';

export const LANE_USAGE_POLL_MS = 15_000;

const RISK_TONE = { high: 'danger', medium: 'warning', low: 'success', unknown: 'unknown' } as const;
const slot = (value: number | null) => value === null ? '?' : String(value);

function Countdown({ resetAt }: { resetAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const text = formatCountdown(resetAt, now);
  return <time dateTime={resetAt ?? undefined} title={resetAt ? new Date(resetAt).toLocaleString() : undefined}>{text}</time>;
}

function LaneCard({ card }: { card: LaneCardModel }) {
  const { lane, remainingPct, risk, stale } = card;
  const name = lane.lane;
  const known = lane.usedPct !== null;
  return <li className={styles.card} data-risk={risk.level} data-held={lane.held || undefined} data-stale={stale || undefined} aria-label={`${name} lane`}>
    <div className={styles.head}>
      <h3>{name}</h3>
      <span className={styles.chips}>
        {lane.held ? <StatusBadge status="held" tone="warning">Held{lane.heldReason ? `: ${lane.heldReason}` : ''}</StatusBadge> : null}
        <StatusBadge status={`waste-${risk.level}`} tone={RISK_TONE[risk.level]}>{risk.label}</StatusBadge>
      </span>
    </div>
    {stale ? <p className={styles.stale}>Stale source: this reading is out of date and may not reflect current usage.</p> : null}
    <div className={styles.usage}>
      {known ? <meter className={styles.meter} min={0} max={100} value={lane.usedPct!} aria-label={`${name} used`}>{lane.usedPct}%</meter>
        : <div className={styles.unknownBar} role="img" aria-label={`${name} usage unknown`} />}
      <p className={styles.numbers}>{known
        ? <><strong>{Math.round(lane.usedPct!)}% used</strong> · {Math.round(remainingPct!)}% remaining</>
        : <strong>Usage unknown</strong>}</p>
    </div>
    <dl className={styles.facts}>
      <div><dt>Resets in</dt><dd><Countdown resetAt={lane.resetAt} /></dd></div>
      <div><dt>Slots</dt><dd aria-label={`${slot(lane.running)} running, ${slot(lane.target)} target, ${slot(lane.ceiling)} ceiling`}>
        {slot(lane.running)} / {slot(lane.target)} / {slot(lane.ceiling)}<small>running / target / ceiling</small></dd></div>
      <div><dt>Queued</dt><dd>{slot(lane.queued)}</dd></div>
    </dl>
  </li>;
}

/** Polls the lane usage feed every 15s and ranks lanes by projected waste at reset. */
export function LaneUsagePanel() {
  const query = useQuery(fleetUsageQuery);
  const refetch = useRefetch(fleetUsageQuery);
  useEffect(() => {
    const timer = window.setInterval(refetch, LANE_USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);
  const feed = query.data;
  // Rank at data arrival, not every second, so cards do not reshuffle under the pointer.
  const cards = useMemo(() => feed ? buildLaneCards(feed, Date.now()) : [], [feed]);
  return <section className={styles.panel} aria-labelledby="lane-usage-title">
    <div className={styles.heading}><div><h2 id="lane-usage-title">Lane usage</h2>
      <p>Most at-risk of unused quota first. Unknown readings are never counted as spare capacity.</p></div>
      <button type="button" className={styles.refresh} onClick={refetch} aria-label="Refresh lane usage">Refresh</button></div>
    {query.status === 'error' ? <p role="alert" className={styles.alert}>Lane usage unavailable. {feed ? 'Showing the last reading, which is not current.' : 'No reading yet.'}</p> : null}
    {!feed ? query.status === 'error' ? null : <p className={styles.muted}>Loading lane usage...</p>
      : cards.length === 0 ? <p className={styles.muted}>No lanes reported.</p>
        : <ul className={styles.grid} aria-label="Lane usage cards">{cards.map(card => <LaneCard key={card.lane.lane} card={card} />)}</ul>}
  </section>;
}
