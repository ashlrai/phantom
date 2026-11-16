/**
 * components/stream/LiveSessionCards.tsx — "who is working right now":
 * one card per running run, with the engine/model badge, a ticking elapsed
 * clock, the current phase (the in-flight task), the last recorded step,
 * and a one-click expand into the live stream (<RunStreamPanel/> inside
 * the shared focus-managed Dialog).
 *
 * Data is the shared `runs` query (GET /api/runs, SSE-refreshed on the
 * 'runs' event) — no new backend surface. Renders nothing when no run is
 * live, so callers mount it unconditionally.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../../data/hooks.js';
import { runsQuery } from '../../data/queries.js';
import { Dialog } from '../primitives/Dialog.js';
import { ProviderLogo, providerEngine } from '../primitives/ProviderLogo.js';
import { formatMetric } from '../charts/format-metric.js';
import { RunStreamPanel } from './RunStreamPanel.js';
import { buildLiveSessions, formatElapsedMs, formatQuietLabel, type LiveSession } from './live-session.js';
import styles from './LiveSessionCards.module.css';

/** One shared tick drives every card's elapsed/quiet labels. */
const TICK_MS = 1_000;
/** A persisted-update gap past this earns an honest "quiet" tag on the card. */
const QUIET_AFTER_MS = 60_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SessionCard({ session, onWatch }: { session: LiveSession; onWatch: (runId: string) => void }) {
  const quiet = formatQuietLabel(session.quietMs, QUIET_AFTER_MS);
  const mark = providerEngine(session.engine) ?? providerEngine(session.provider);
  return (
    <li className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.pulse} aria-hidden="true" />
        <span className={styles.engine}>
          {mark ? <ProviderLogo engine={mark} size={14} /> : null}
          {session.engine}
        </span>
        <span className={styles.model} title={session.engineModel ?? session.provider}>
          {session.engineModel ?? session.provider}
        </span>
        <span className={styles.elapsed} title={`Started ${new Date(Date.now() - session.elapsedMs).toLocaleString()}`}>
          {formatElapsedMs(session.elapsedMs)}
        </span>
      </div>
      <p className={styles.goal} title={session.goal}>
        {session.goal}
      </p>
      <div className={styles.fact}>
        <span className={styles.factLabel}>Phase</span>
        <span className={styles.factValue}>{session.phase}</span>
      </div>
      <div className={styles.fact}>
        <span className={styles.factLabel}>Last event</span>
        <span className={styles.factValue}>
          {session.lastEvent ? (
            <>
              <span className={styles.stepKind}>{session.lastEvent.kindLabel}</span> {session.lastEvent.summary}
            </>
          ) : (
            'No steps recorded yet'
          )}
        </span>
      </div>
      <div className={styles.meta}>
        {session.tasksTotal > 0 ? (
          <span>
            {session.tasksDone}/{session.tasksTotal} tasks
          </span>
        ) : null}
        <span>{formatMetric(session.tokensIn + session.tokensOut)} accounted tok</span>
        {quiet ? <span className={styles.quiet}>{quiet}</span> : null}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.watch}
          onClick={() => onWatch(session.id)}
          data-focus-key={`watch-${session.id}`}
        >
          Watch live
        </button>
        <Link to={`/work/runs/${session.id}`} className={styles.open}>
          Open run →
        </Link>
      </div>
    </li>
  );
}

export function LiveSessionCards({ limit = 12 }: { limit?: number }) {
  const runs = useQuery(runsQuery);
  const now = useNow(TICK_MS);
  const [watching, setWatching] = useState<string | null>(null);
  const sessions = useMemo(() => buildLiveSessions(runs.data, now, limit), [runs.data, now, limit]);

  // Keep the dialog mounted for a run that just finished — the stream
  // drains its captured output instead of vanishing mid-watch.
  if (sessions.length === 0 && watching === null) return null;

  return (
    <section className={styles.section} aria-label="Live sessions">
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Live now</span>
        <span className={styles.sectionCount}>
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className={styles.grid}>
        {sessions.map((session) => (
          <SessionCard key={session.id} session={session} onWatch={setWatching} />
        ))}
      </ul>
      <Dialog
        open={watching !== null}
        onClose={() => setWatching(null)}
        titleId="live-session-watch-title"
        title="Watching live"
        widthClassName={styles.dialogWidth}
      >
        {watching ? <RunStreamPanel runId={watching} /> : null}
      </Dialog>
    </section>
  );
}
