/**
 * Cross-fleet facts from observe.human.v1. Each Fleet pane shows one slice.
 * The Observe pane shows the full set, including resource coordination.
 */
import { useState, useSyncExternalStore } from 'react';
import { apiGet } from '../../../data/client.js';
import { getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import type { ObserveSnapshot, SessionDetail } from '../../../../core/observe/types.js';
import { observeQuery } from './observe-queries.js';
import styles from './observe-facts.module.css';

export type ObservePart = 'resources' | 'usage' | 'releases' | 'merges' | 'graph' | 'timeline' | 'capacity' | 'bus' | 'all';

const show = (value: number | null | undefined) => value === null || value === undefined ? 'unknown' : String(value);

function ready(snapshot: ObserveSnapshot | undefined): snapshot is ObserveSnapshot {
  return snapshot?.schema === 'observe.human.v1' && snapshot.resources?.counts !== undefined;
}

function sentence(snapshot: ObserveSnapshot | undefined, part: ObservePart, failed: boolean): string | null {
  if (!ready(snapshot)) return failed || snapshot ? 'This observe reading is unknown.' : null;
  const counts = snapshot.resources.counts;
  if (part === 'resources' || part === 'capacity') {
    return `Resources: ${show(counts.coordinated)} coordinated, ${show(counts.idle)} idle, ${show(counts.duplicated)} duplicated, ${show(counts.unknown)} unknown`;
  }
  if (part === 'usage') {
    const fresh = snapshot.usage.windows.filter((window) => window.status === 'fresh').length;
    const unknown = snapshot.usage.windows.filter((window) => window.headroom === null).length;
    return snapshot.usage.state === 'live'
      ? `Sensor headroom: ${fresh} fresh, ${unknown} unknown`
      : 'Sensor headroom is unknown';
  }
  if (part === 'merges') {
    const repo = snapshot.pulls.repos[0];
    if (!repo || repo.mergedPerDay === null) return 'Merged pulls per day: unknown. Change-failure rate: unknown';
    const rate = repo.changeFailureRate === null ? 'unknown' : `${Math.round(repo.changeFailureRate * 100)}%`;
    return `${repo.repo}: ${repo.mergedPerDay.toFixed(2)} merged per day, change-failure rate ${rate}`;
  }
  if (part === 'graph') {
    if (snapshot.bottlenecks.top.length === 0) return 'Top bottlenecks: unknown';
    return `Top bottlenecks: ${snapshot.bottlenecks.top.map((item) => `${item.metric} ${item.value} ${item.unit}`).join('; ')}`;
  }
  if (part === 'timeline') {
    return snapshot.humans.stepsRemaining === null
      ? 'Human steps remaining: unknown'
      : `Human steps remaining: ${snapshot.humans.stepsRemaining}`;
  }
  if (part === 'bus') {
    return snapshot.resources.claims === 'available' || snapshot.resources.claims === 'missing'
      ? `Bus claims: ${snapshot.resources.claims}`
      : 'Bus claims: unknown';
  }
  if (part === 'releases') {
    const update = snapshot.graph.stages.find((stage) => stage.id === 'update_check');
    return update?.detail ?? 'Release pipeline: update check unknown';
  }
  return null;
}

export function ObserveSlice({ part }: { visible?: boolean; part: Exclude<ObservePart, 'all'> }) {
  const read = useSyncExternalStore(
    (listener) => subscribeQuery(observeQuery.key, listener),
    () => getQuerySnapshot<ObserveSnapshot>(observeQuery.key),
    () => getQuerySnapshot<ObserveSnapshot>(observeQuery.key),
  );
  const text = sentence(read.data, part, false);
  if (!text) return null;
  return <p className={styles.slice} role="status">{text}</p>;
}

export function ObserveFacts({ visible }: { visible: boolean }) {
  const read = useQuery(observeQuery, { enabled: visible, freshMs: 0 });
  const snapshot = ready(read.data) ? read.data : undefined;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  if (!snapshot) {
    return <p className={styles.quiet} role="status">{read.status === 'error' ? 'The observe snapshot is unknown.' : 'Reading observe…'}</p>;
  }
  const counts = snapshot.resources.counts;
  const open = (id: string) => {
    void apiGet<SessionDetail>(`/api/verse/observe/session?id=${encodeURIComponent(id)}`)
      .then(setDetail)
      .catch(() => setDetail({ schema: 'observe.human.v1', state: 'unknown', reason: 'The session could not be read.', sessionId: id, provider: null, task: null, status: null, transcript: null }));
  };
  return <div className={styles.root}>
    <section className={styles.region} aria-label="Resources">
      <h3 className={styles.title}>Resources</h3>
      <ul className={styles.counts}>
        <li><span className={styles.count}>{show(counts.coordinated)}</span> coordinated</li>
        <li><span className={styles.count}>{show(counts.idle)}</span> idle</li>
        <li><span className={styles.count}>{show(counts.duplicated)}</span> duplicated</li>
        <li><span className={styles.count}>{show(counts.unknown)}</span> unknown</li>
      </ul>
      <ul className={styles.list}>{snapshot.resources.items.map((item) =>
        <li key={item.id} className={styles.row} data-state={item.state}>{item.label}: {item.state}. {item.reason}</li>)}</ul>
    </section>
    <section className={styles.region} aria-label="Headlines">
      <h3 className={styles.title}>Headlines</h3>
      {snapshot.pulls.repos.length === 0 ? <p className={styles.quiet}>Merged pulls per day and change-failure rate are unknown.</p> : <ul className={styles.list}>{snapshot.pulls.repos.map((repo) =>
        <li key={repo.repo}>
          <span>{repo.repo}: {repo.mergedPerDay === null ? 'unknown' : repo.mergedPerDay.toFixed(2)} merged per day ({repo.trend.mergedPerDay}). Change-failure rate {repo.changeFailureRate === null ? 'unknown' : `${Math.round(repo.changeFailureRate * 100)}%`} ({repo.trend.changeFailureRate}).</span>
          {repo.trend.days.length > 0 && <span className={styles.bars} aria-label={`${repo.repo} merged pulls by day`}>{repo.trend.days.map((day) =>
            <span key={day.date} className={styles.bar} style={{ height: `${Math.max(2, (day.merged ?? 0) * 8)}px` }} title={`${day.date}: ${day.merged ?? 'unknown'} merged`} />)}</span>}
        </li>)}</ul>}
    </section>
    <section className={styles.region} aria-label="Top 3 measured bottlenecks">
      <h3 className={styles.title}>Top 3 measured bottlenecks</h3>
      {snapshot.bottlenecks.top.length === 0 ? <p className={styles.quiet}>Unknown. Eng Ops has not published bottlenecks.v1.</p> : <ol className={styles.list}>{snapshot.bottlenecks.top.map((item) =>
        <li key={item.id}>{item.metric}: {item.value} {item.unit}. Owner {item.owner}. Before {item.before === null ? 'unknown' : item.before}, after {item.after === null ? 'unknown' : item.after}{item.verifiedAt ? `, verified ${item.verifiedAt}` : ''}.</li>)}</ol>}
    </section>
    <section className={styles.region} aria-label="Human steps">
      <h3 className={styles.title}>Human steps</h3>
      <p className={styles.quiet}>{snapshot.humans.stepsRemaining === null ? 'Steps remaining: unknown' : `${snapshot.humans.stepsRemaining} steps remaining`}</p>
      <ul className={styles.list}>{snapshot.humans.decisions.map((decision) =>
        <li key={decision.id}>{decision.at}: {decision.kind} {decision.title} ({decision.status})</li>)}</ul>
    </section>
    <section className={styles.region} aria-label="Roster">
      <h3 className={styles.title}>Roster</h3>
      {snapshot.roster.sessions.length === 0 ? <p className={styles.quiet}>{snapshot.roster.reason ?? 'No roster sessions.'}</p> : <ul className={styles.list}>{snapshot.roster.sessions.map((session) =>
        <li key={`${session.provider}:${session.sessionId}`}>
          <button type="button" className={styles.job} onClick={() => open(session.sessionId)}>{session.sessionId}</button>
          {` ${session.provider} · ${session.status} · task ${session.task ?? 'unknown'} · claim ${session.claim ?? 'unknown'} · model ${session.model ?? 'unknown'}`}
        </li>)}</ul>}
      {detail && <p className={styles.quiet} role="status">{detail.sessionId}: {detail.state}. {detail.reason} Transcript: {detail.transcript ?? 'unknown'}.</p>}
    </section>
    <section className={styles.region} aria-label="Release pipeline">
      <h3 className={styles.title}>Release pipeline</h3>
      <ol className={styles.pipeline}>{snapshot.graph.stages.map((stage) =>
        <li key={stage.id} className={styles.stage} data-state={stage.state === 'blocked' ? 'blocked' : stage.state}>{stage.label}: {stage.detail ?? stage.state}</li>)}</ol>
      {snapshot.graph.bottleneck && <p className={styles.quiet}>Bottleneck: {snapshot.graph.bottleneck.reason}</p>}
    </section>
  </div>;
}
