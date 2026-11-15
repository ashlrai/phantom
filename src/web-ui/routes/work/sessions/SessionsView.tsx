/**
 * routes/work/sessions/SessionsView.tsx — fleet.sessions.v1: the unified
 * dispatchd agent-session list (GET /api/fleet/sessions → getFleetSessions).
 *
 * One row per live session — queued, parked, launching, running, publishing,
 * exited or stale — plus a bounded "recently finished" tail. This is the
 * read-only counterpart to Devin/Claude Code's session lists: job id, repo,
 * lane/provider, tier, status, elapsed time and (when the ledger covered the
 * finish) token/diff totals. The backend projection is value-blind — prompt
 * paths, env contents and secrets never reach this view, so nothing here
 * renders them either.
 *
 * Honesty rules (same as LanesPanel): null cells render "—", never invented
 * zeros; per-source health is always visible so "empty" stays distinguishable
 * from "unreadable"; elapsed time ticks client-side from the server's
 * generatedAt so the column stays live between SSE invalidations.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fleetSessionsQuery } from '../../../data/queries.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { readFailureReason } from '../../../data/client.js';
import type { FleetSessionV1, FleetSessionsV1 } from '../../../data/api-types.js';
import { formatDateTime } from '../../../components/format/locale-format.js';
import styles from './SessionsView.module.css';

/** Live clock for elapsed columns; re-renders once per second while mounted. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** RunStreamPanel's convention, extended for multi-hour sessions. */
function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatAgo(iso: string | null, now: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Math.max(0, Math.round((now - ms) / 1000));
  if (diff < 60) return `${diff}s ago`;
  return `${formatElapsedSeconds(diff)} ago`;
}

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateTime(d, undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const dash = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

/** Elapsed ticks from the snapshot's generatedAt so the column stays live
 *  between fetches; finished sessions show their recorded duration instead. */
function elapsedLabel(session: FleetSessionV1, snap: FleetSessionsV1, now: number): string {
  if (session.status === 'finished') {
    return session.durationSeconds === null ? '—' : formatElapsedSeconds(session.durationSeconds);
  }
  if (session.elapsedSeconds === null) return '—';
  const anchor = Date.parse(snap.generatedAt);
  const drift = Number.isFinite(anchor) ? Math.max(0, Math.round((now - anchor) / 1000)) : 0;
  return formatElapsedSeconds(session.elapsedSeconds + drift);
}

function sourceSummary(snap: FleetSessionsV1): string {
  const order = ['runDir', 'ready', 'claimed', 'precheck', 'status', 'metrics', 'live'] as const;
  const labels: Record<(typeof order)[number], string> = {
    runDir: 'run markers', ready: 'ready.tsv', claimed: 'claimed.tsv',
    precheck: 'precheck', status: 'status.json', metrics: 'jobs.jsonl', live: 'ps',
  };
  return order.map(k => `${labels[k]} ${snap.sources[k]}`).join(' · ');
}

function countSummary(snap: FleetSessionsV1): string {
  const c = snap.counts;
  const parts = [
    c.running > 0 ? `${c.running} running` : null,
    c.launching > 0 ? `${c.launching} launching` : null,
    c.publishing > 0 ? `${c.publishing} publishing` : null,
    c.exited > 0 ? `${c.exited} exited` : null,
    c.stale > 0 ? `${c.stale} stale` : null,
    c.queued > 0 ? `${c.queued} queued` : null,
    c.parked > 0 ? `${c.parked} parked` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'no active sessions';
}

function SessionRow({ session, snap, now }: { session: FleetSessionV1; snap: FleetSessionsV1; now: number }) {
  return (
    <tr>
      <th scope="row" className={styles.job} title={session.job}>{session.job}</th>
      <td className={styles.mono}>{dash(session.repo)}</td>
      <td className={styles.mono}>{dash(session.lane)}</td>
      <td className={styles.mono}>{dash(session.tier)}</td>
      <td>
        <StatusBadge status={session.status} />
        {session.timedOut ? <small className={styles.flag}> timed out</small> : null}
        {session.status === 'parked' ? <small className={styles.flag}> gated</small> : null}
      </td>
      <td className={styles.numeric} title={session.status === 'queued' || session.status === 'parked' ? 'waiting since enqueue' : 'since session start'}>
        {elapsedLabel(session, snap, now)}
      </td>
      <td className={styles.mono}>{dash(session.model)}</td>
      <td className={styles.numeric} title={session.live === 'unknown' ? 'process table unavailable' : undefined}>
        {session.pid ?? '—'}
        {session.live === 'unknown' ? <small className={styles.flag}> unverified</small> : null}
      </td>
      <td className={styles.date}>{formatClock(session.startedAt)}</td>
    </tr>
  );
}

function RecentRow({ session, now }: { session: FleetSessionV1; now: number }) {
  return (
    <tr>
      <th scope="row" className={styles.job} title={session.job}>{session.job}</th>
      <td className={styles.mono}>{dash(session.repo)}</td>
      <td className={styles.mono}>{dash(session.lane)}</td>
      <td>
        <StatusBadge status={session.outcome ?? session.status} />
      </td>
      <td className={styles.numeric}>
        {session.durationSeconds === null ? '—' : formatElapsedSeconds(session.durationSeconds)}
      </td>
      <td className={styles.numeric}>{session.tokensTotal === null ? '—' : session.tokensTotal.toLocaleString()}</td>
      <td className={styles.numeric}>{session.diffLines === null ? '—' : `${session.diffLines > 0 ? '+' : ''}${session.diffLines}`}</td>
      <td className={styles.date}>{formatAgo(session.finishedAt, now)}</td>
      <td>
        {session.prUrl ? (
          <a className={styles.prLink} href={session.prUrl} target="_blank" rel="noreferrer">PR</a>
        ) : '—'}
      </td>
    </tr>
  );
}

export function SessionsView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/work/sessions', containerRef);
  const now = useNow();
  const query = useQuery(fleetSessionsQuery);
  const refresh = useRefresh(fleetSessionsQuery);
  const snap = query.data;

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const sessions = useMemo(() => snap?.sessions ?? [], [snap]);
  const recent = useMemo(() => snap?.recent ?? [], [snap]);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) set.add(s.status);
    for (const s of recent) set.add(s.status);
    return Array.from(set).sort();
  }, [sessions, recent]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (!q) return true;
      return [s.job, s.repo, s.lane, s.tier, s.model].some(v => v?.toLowerCase().includes(q));
    });
  }, [sessions, statusFilter, search]);

  const filteredRecent = useMemo(() => {
    if (statusFilter === 'all') return recent;
    return recent.filter(s => s.status === statusFilter);
  }, [recent, statusFilter]);

  const dispatcherNote = useMemo(() => {
    if (!snap?.dispatcher) return null;
    const d = snap.dispatcher;
    if (d.paused === true) return 'dispatcher paused';
    if (d.paused === null) return null;
    return d.tickAgeSeconds === null ? 'dispatcher running' : `dispatcher tick ${formatElapsedSeconds(d.tickAgeSeconds)} ago`;
  }, [snap]);

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Sessions</h1>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
          <span className={styles.count}>
            {snap ? `${countSummary(snap)} · updated ${formatAgo(snap.generatedAt, now)}` : ''}
          </span>
        </div>
      </header>

      {query.status === 'loading' && !snap ? (
        <div className={styles.tableWrap}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : query.status === 'error' && !snap ? (
        <div className={styles.error} role="alert">
          {readFailureReason(query.error)}
        </div>
      ) : snap ? (
        <>
          {snap.sourceState !== 'healthy' ? (
            <p className={styles.degraded} role="status">
              session sources {snap.sourceState}
              {snap.malformed > 0 ? ` · ${snap.malformed} malformed row${snap.malformed === 1 ? '' : 's'} dropped` : ''}
              {snap.truncated ? ' · results truncated' : ''}
            </p>
          ) : null}
          {dispatcherNote ? <p className={styles.dispatcher}>{dispatcherNote}</p> : null}
          {!snap.runsDirPresent ? (
            <p className={styles.empty}>No runs directory found — dispatchd state is absent on this host.</p>
          ) : null}

          <form className={styles.filters} role="search" aria-label="Filter sessions" onSubmit={(e) => e.preventDefault()}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Search</span>
              <input
                type="text"
                className={styles.input}
                placeholder="job, repo, lane, tier or model"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Status</span>
              <select className={styles.select} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            {(statusFilter !== 'all' || search) && (
              <button
                type="button"
                className={styles.clear}
                onClick={() => { setSearch(''); setStatusFilter('all'); }}
              >
                Clear filters
              </button>
            )}
          </form>

          <section className={styles.section} aria-label="Active sessions">
            <h2 className={styles.sectionTitle}>
              Active sessions
              <span className={styles.sectionCount}>{filtered.length}</span>
            </h2>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.caption}>
                  Dispatchd sessions from the local runs dir. Elapsed is live for active rows and
                  records total duration for finished ones; "—" means the source did not record it.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Repo</th>
                    <th scope="col">Lane</th>
                    <th scope="col">Tier</th>
                    <th scope="col">Status</th>
                    <th scope="col">Elapsed</th>
                    <th scope="col">Model</th>
                    <th scope="col">PID</th>
                    <th scope="col">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={9} className={styles.empty}>
                        {sessions.length === 0
                          ? 'No active sessions — the queue is empty and nothing is running.'
                          : 'No sessions match the current filters.'}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((s) => <SessionRow key={s.job} session={s} snap={snap} now={now} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.section} aria-label="Recently finished sessions">
            <h2 className={styles.sectionTitle}>
              Recently finished
              <span className={styles.sectionCount}>{filteredRecent.length}</span>
            </h2>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.caption}>
                  Bounded tail of finished sessions, newest first.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Repo</th>
                    <th scope="col">Lane</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Diff</th>
                    <th scope="col">Finished</th>
                    <th scope="col">PR</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecent.length === 0 ? (
                    <tr>
                      <td colSpan={9} className={styles.empty}>
                        {recent.length === 0 ? 'No finished sessions recorded yet.' : 'No finished sessions match the current filters.'}
                      </td>
                    </tr>
                  ) : (
                    filteredRecent.map((s) => <RecentRow key={s.job} session={s} now={now} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className={styles.sources}>sources: {sourceSummary(snap)}</p>
        </>
      ) : null}
    </div>
  );
}
