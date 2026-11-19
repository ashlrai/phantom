import { useCallback, useEffect, useRef, useState } from 'react';
// Types only: the reader behind them uses node:fs and must stay out of the browser bundle.
import type { UsageProducer, UsageProducersReport } from '../../../../core/fleet/usage-producers.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './RunwayStrip.module.css';

/** An older host or a proxy may answer with another shape: say unknown rather than draw it. */
const isReport = (value: unknown): value is UsageProducersReport =>
  typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === 'fleet.usage-producers.v1'
  && Array.isArray((value as { producers?: unknown }).producers) && Array.isArray((value as { gaps?: unknown }).gaps);

/** "12 jobs · claude-sonnet · 95 m · 9 published · 4 merged" — every number, or the word unknown. */
function facts(p: UsageProducer): string {
  const models = Array.isArray(p.models) ? p.models.join(', ') : 'model unknown';
  const wall = p.wall_minutes === 'unknown' ? 'wall unknown' : `${Math.round(p.wall_minutes)} m`;
  return `${p.jobs_started} jobs · ${models} · ${wall} · ${p.prs_published} published · ${p.prs_merged} merged`;
}

/**
 * Who is spending the plans: one line per dispatcher lane and outside loop over the last 6 hours.
 * Same report as `phm usage producers --json`.
 */
export function ProducersCard() {
  const [data, setData] = useState<UsageProducersReport | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setFailed(false);
    void apiGet<unknown>('/api/verse/fleet/usage/producers', request.signal).then(value => {
      if (request.signal.aborted) return;
      if (isReport(value)) setData(value); else { setData(null); setFailed(true); }
    }).catch(() => { if (!request.signal.aborted) { setData(null); setFailed(true); } });
  }, []);
  useEffect(() => { refresh(); return () => pending.current?.abort(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  return <section className={styles.strip} aria-labelledby="verse-usage-producers">
    <h3 id="verse-usage-producers" className={styles.title}>Who is spending</h3>
    {!data ? <p className={styles.note}>{failed ? 'unknown (status unavailable)' : 'Reading producers…'}</p> : <>
      <p className={styles.headline} role="status">{data.headline}</p>
      <ul className={styles.list}>
        {data.producers.map(p => <li key={`${p.kind}:${p.producer}`} className={styles.row} data-state="unknown" aria-label={`${p.producer} ${p.jobs_started} jobs`}>
          <span className={styles.pool}>{p.producer}</span>
          <span className={styles.facts}>{facts(p)}</span>
        </li>)}
        {data.gaps.map(g => <li key={`gap:${g.producer}`} className={styles.row}>
          <span className={styles.pool}>{g.producer}</span>
          <span className={styles.advice}>no record: {g.reason}</span>
        </li>)}
      </ul>
    </>}
  </section>;
}
