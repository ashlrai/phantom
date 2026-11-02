import type { GrokUltraRunway as Runway } from '../../../../core/fleet/grok-ultra-types.js';
import { useEffect, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { optionalQuery } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import styles from './GrokUltraRunway.module.css';

const WINDOWS = ['h1', 'h6', 'h24'] as const;
const WINDOW_LABELS = { h1: '1 hour', h6: '6 hours', h24: '24 hours' };
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Withhold malformed readings, rather than allowing NaN or partial forecasts into the tile. */
export function narrowGrokUltraRunway(raw: unknown): Runway | null {
  if (!record(raw) || raw.v !== 1 || !['manual-required', 'current', 'stale', 'unavailable'].includes(String(raw.state))
    || !instant(raw.checkedAt) || !instant(raw.targetAt) || !record(raw.collection)
    || raw.collection.mode !== 'manual' || raw.collection.reason !== 'safe-local-source-unavailable'
    || !record(raw.burnPointsPerHour) || !record(raw.projectedRemainingPoints)
    || raw.idealPointsPerHour !== null && (!finite(raw.idealPointsPerHour) || raw.idealPointsPerHour < 0)) return null;
  const burn = raw.burnPointsPerHour;
  const projected = raw.projectedRemainingPoints;
  if (!WINDOWS.every((key) => burn[key] === null || finite(burn[key]) && Number(burn[key]) >= 0)
    || !WINDOWS.every((key) => projected[key] === null || finite(projected[key]))) return null;
  if (raw.latest !== null) {
    if (!record(raw.latest) || !['manual', 'app-local'].includes(String(raw.latest.source)) || !instant(raw.latest.timestamp)
      || !finite(raw.latest.remainingPoints) || !finite(raw.latest.totalPoints) || raw.latest.remainingPoints < 0
      || raw.latest.totalPoints <= 0 || raw.latest.remainingPoints > raw.latest.totalPoints) return null;
  } else if (raw.state === 'current' || raw.state === 'stale' || raw.idealPointsPerHour !== null
    || WINDOWS.some((key) => burn[key] !== null || projected[key] !== null)) return null;
  return raw as unknown as Runway;
}

const runwayQuery = optionalQuery('verse-grok-ultra-runway', '/api/verse/fleet/grok-ultra', 'Grok Ultra runway', narrowGrokUltraRunway);

function Forecast({ value, state }: { value: number | null; state: Runway['state'] }) {
  if (value === null || state !== 'current') return <>Unknown</>;
  return <>{number(Math.abs(value))} points {value < 0 ? 'short' : 'remaining'}</>;
}

export function GrokUltraRunway() {
  const query = useQuery(runwayQuery, { freshMs: 30_000 });
  const refetch = useRefetch(runwayQuery);
  usePollWhileVisible(refetch, 30_000);
  const now = useNow(15_000);
  const [lastReading, setLastReading] = useState<Runway | null>(null);
  useEffect(() => {
    if (query.data?.value) setLastReading(query.data.value);
  }, [query.data?.value]);
  const value = query.data?.value ?? lastReading;
  const latest = value?.latest;
  const failed = query.status === 'error' || query.data?.value === null;
  // A cached "current" response cannot stay current during a failed or stalled refresh.
  const expired = latest != null && (now - Date.parse(latest.timestamp) > 20 * 60_000 || now < Date.parse(latest.timestamp));
  const stale = value?.state === 'stale' || failed || expired;
  const current = value?.state === 'current' && !stale;
  return <section className={styles.panel} aria-label="Grok Ultra runway">
    <h3 className={styles.title}>Grok Ultra runway</h3>
    {!value ? <p className={styles.note}>{query.data?.reason ?? (failed ? 'Usage reading unavailable.' : 'Reading usage history…')}</p> : <>
      <p className={styles.note}>Manual readings · safe local usage source unavailable.</p>
      {!latest ? <p className={styles.note}>{value.state === 'unavailable' ? 'Usage history is unavailable.' : 'Add a manual reading to measure runway.'} Remaining points and burn are unknown.</p> : <>
        <p className={styles.remaining}>{number(latest.remainingPoints)} <span>of {number(latest.totalPoints)} points remaining</span></p>
        <p className={styles.note}>{latest.source === 'manual' ? 'Manual reading' : 'App-local reading'} · <time dateTime={latest.timestamp}>{new Date(latest.timestamp).toLocaleString()}</time></p>
        {stale ? <p className={styles.note} role="status">Reading is stale. Burn, ideal pace and projections are unknown until a fresh reading arrives.</p> : null}
      </>}
      <p className={styles.note}>Landing: Sun Nov 1, 2026, 8:21 PM ET</p>
      <dl className={styles.pace}><dt>Ideal pace to landing</dt><dd>{value.idealPointsPerHour === null || !current ? 'Unknown' : `${number(value.idealPointsPerHour)} points/hour`}</dd></dl>
      <div className={styles.windows}>
        {WINDOWS.map((key) => <div key={key} className={styles.window}>
          <h4>Last {WINDOW_LABELS[key]}</h4>
          <dl><dt>Burn</dt><dd>{value.burnPointsPerHour[key] === null || !current ? 'Unknown' : `${number(value.burnPointsPerHour[key]!)} points/hour`}</dd>
            <dt>Projected landing</dt><dd><Forecast value={value.projectedRemainingPoints[key]} state={current ? 'current' : 'unavailable'} /></dd></dl>
        </div>)}
      </div>
      <p className={styles.note}>Projections assume the observed pace continues. Unknown means insufficient history or a stale reading.</p>
    </>}
  </section>;
}
