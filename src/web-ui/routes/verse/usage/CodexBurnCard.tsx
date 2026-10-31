import { useEffect, useState } from 'react';
import { StatTile } from '../../../components/charts/StatTile.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { useDocumentVisible, useSectionVisible } from '../shell/section-visibility.js';
import { pacePerHour, readings, recordReading, requiredPacePerHour, stall, stallText, verdict, type PersonalReading } from './codex-burn-model.js';
import { personalReader } from './codex-burn-queries.js';
import styles from './codex-burn.module.css';

function relative(iso: string | null, now: number): string {
  if (iso === null) return '—';
  const minutes = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(minutes)) return '—';
  if (minutes <= 0) return 'Reset due';
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
const rate = (n: number | null): string => n === null ? '—' : `${n.toFixed(1)} pts/h`;

export function CodexBurnCard({ now }: { now: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const [reading, setReading] = useState<PersonalReading | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sourceState, setSourceState] = useState<string | null>(null);
  const [history, setHistory] = useState(readings);
  // The reader lives for one section visit; hiding the browser window does not reset its 404.
  const [reader, setReader] = useState(personalReader);
  useEffect(() => {
    if (!sectionVisible) { setReader(() => personalReader()); setMissing(false); }
  }, [sectionVisible]);
  useEffect(() => {
    if (!sectionVisible || !documentVisible || missing) return;
    const controller = new AbortController();
    let pending = false;
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const result = await reader(controller.signal);
        if (controller.signal.aborted) return;
        setMissing(result.missing);
        setSourceState(result.sourceState);
        setFailed(!result.missing && result.reading === null);
        if (result.reading) {
          setReading(result.reading);
          recordReading(result.reading, Date.now());
          setHistory(readings());
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally { pending = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sectionVisible, documentVisible, missing, reader]);
  if (missing) return <p className={styles.note}>Personal Codex reading is not in this build yet.</p>;
  const pace = pacePerHour(history, now);
  const needed = requiredPacePerHour(reading?.usedPct ?? null, reading?.resetsAt ?? null, now);
  const stalled = stallText(stall(history, now));
  return (
    <section className={styles.card} aria-labelledby="personal-codex-burn">
      <div className={styles.heading}>
        <h3 id="personal-codex-burn">Personal Codex burn</h3>
        {sourceState && sourceState !== 'healthy' ? <StatusBadge status={sourceState} tone="warning">reading {sourceState}</StatusBadge> : null}
      </div>
      {failed ? <p className={styles.note}>Personal Codex reading unavailable.</p> : null}
      <Meter label="Used" value={reading?.usedPct ?? null} max={100} valueText={reading?.usedPct == null ? '—' : `${reading.usedPct}% used`} {...{ 'aria-valuetext': reading?.usedPct == null ? 'unknown' : `${reading.usedPct}% used` }} />
      <div className={styles.tiles}>
        <StatTile label="Resets in" value={relative(reading?.resetsAt ?? null, now)} />
        <StatTile label="Pace" value={rate(pace)} />
        <StatTile label="Needed" value={rate(needed)} />
      </div>
      <p>{verdict(pace, needed).text}</p>
      {stalled ? <p>{stalled}</p> : null}
      {history.length >= 2 ? <Sparkline points={history.map(r => r.usedPct)} width="fill" ariaLabel="Personal Codex usage history" /> : null}
      <p className={styles.note}>From this Mac's personal Codex session logs; the CMP account is not read.</p>
    </section>
  );
}
