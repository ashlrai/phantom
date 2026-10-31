import { useEffect, useRef } from 'react';
import { StatTile } from '../../../components/charts/StatTile.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { opsRunsQuery } from './ops-runs-queries.js';
import { ageText, countText, newest, relativeText } from './ops-runs-model.js';
import styles from './ops.module.css';
import runs from './ops-runs.module.css';

export function OpsRuns() {
  const read = useQuery(opsRunsQuery, { freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const visible = useSectionVisible();
  const wasVisible = useRef(visible);
  const data = read.data;
  useEffect(() => {
    if (visible && !wasVisible.current && data === null) refetch();
    wasVisible.current = visible;
  }, [visible, data, refetch]);
  usePollWhileVisible(refetch, 5_000, { enabled: data !== null });
  if (data === null) return <p>Live runs are not in this build yet.</p>;
  if (!data) return <p role="status">{read.status === 'error' ? 'Live runs are unavailable.' : 'Reading live runs…'}</p>;
  const now = Date.now();
  const codex = data.codexPersonal;
  const tiles = [
    ['Real workers', String(data.workers.length)],
    ['Merges last hour', countText(data.mergesLastHour.count)],
    ['Personal Codex used', codex?.usedPct == null ? '—' : `${codex.usedPct} %`],
    ['Leader passes', String(data.leaders.length)],
  ];
  return <section className={`${styles.panel} ${runs.root}`} aria-label="Live runs">
    <div className={runs.tiles}>{tiles.map(([label, value]) => <div key={label} role="group" aria-label={`${label}: ${value}`}>
      <StatTile label={label} value={value} caption={label === 'Personal Codex used' && codex?.resetsAt ? `resets ${relativeText(codex.resetsAt, now)}` : undefined} />
    </div>)}</div>
    {read.status === 'error' ? <p role="status">Live runs could not refresh. Showing the last reading.</p> : null}
    {data.switches.length > 0 ? <p>Switches on: {data.switches.map((s) => <span key={s} className={styles.chip} data-tone="bad">{s} </span>)}</p> : null}
    {data.claudeLane?.startsWith('down') ? <p>Claude lane: {data.claudeLane}</p> : null}
    {data.paused === true ? <p>Dispatcher paused</p> : null}
    <p className={styles.note}>{[
      data.lastTick === null ? null : `Dispatcher tick ${relativeText(data.lastTick, now)}`,
      data.diskFreeGb === null ? null : `disk free ${data.diskFreeGb} GB`,
      data.memFreePct === null ? null : `memory free ${data.memFreePct} %`,
    ].filter(Boolean).join(' · ')}</p>
    <h3 className={styles.groupTitle}>Lanes</h3>
    <table className={runs.table} aria-label="Lanes"><thead><tr>{['Lane', 'Running/Target', 'Queued', 'Held', 'Tokens 1h', 'Merged 24h (merge rate %)'].map((s) => <th key={s} scope="col">{s}</th>)}</tr></thead>
      <tbody>{data.lanes.map((l) => <tr key={l.lane} title={l.heldReason ?? undefined}>
        <th scope="row">{l.lane}</th>
        <td aria-label={`${countText(l.running)} running / ${countText(l.target)} target`}>{countText(l.running)}/{countText(l.target)}</td>
        <td aria-label={`${countText(l.queued)} queued`}>{countText(l.queued)}</td>
        <td title={l.heldReason ?? undefined} aria-label={`${l.lane} ${l.held ? 'held' : 'not held'}${l.heldReason ? `: ${l.heldReason}` : ''}`}>{l.held ? 'Held' : 'No'}</td>
        <td aria-label={`${countText(l.tokensLastHour)} tokens last hour`}>{countText(l.tokensLastHour)}</td>
        <td aria-label={`${countText(l.merged24h)} merged in 24 hours, ${countText(l.mergeRate24h)} percent merge rate`}>{countText(l.merged24h)} ({countText(l.mergeRate24h)} %)</td>
      </tr>)}</tbody></table>
    <h3 className={styles.groupTitle}>Workers</h3>
    {data.workers.length === 0 ? <p>No workers running.</p> : <table className={runs.table} aria-label="Workers">
      <thead><tr>{['Job', 'Repo', 'Lane', 'Tier', 'Age'].map((s) => <th key={s} scope="col">{s}</th>)}</tr></thead>
      <tbody>{data.workers.map((w, i) => <tr key={`${w.job}:${i}`}>
        <th scope="row">{w.job}</th><td>{w.repo}</td><td>{w.lane}</td><td>{w.tier}</td>
        <td aria-label={`Worker age ${w.ageSeconds === null ? 'unknown' : `${w.ageSeconds} seconds`}`}>{ageText(w.ageSeconds)}</td>
      </tr>)}</tbody>
    </table>}
    <h3 className={styles.groupTitle}>Merged last hour</h3>
    <ul className={styles.compact}>{data.mergesLastHour.items.map((m) => <li key={`${m.repo}:${m.number}`} aria-label={`${m.repo} pull request ${m.number}: ${m.title}`}>{m.repo} #{m.number} {m.title}</li>)}</ul>
    <h3 className={styles.groupTitle}>Publishes last hour</h3>
    <ul className={styles.compact}>{data.publishesLastHour.map((p, i) => <li key={i}>
      {p.job} → {p.url?.startsWith('https://github.com/')
        ? <a href={p.url} target="_blank" rel="noreferrer" aria-label={`Pull request for ${p.job}`}>{p.url}</a>
        : <span>{p.url ?? 'PR unavailable'}</span>}
    </li>)}</ul>
    <h3 className={styles.groupTitle}>Events</h3>
    <ul className={`${styles.compact} ${runs.events}`}>{newest(data.events, 40).map((e, i) => <li key={i}>{e.at} {e.kind} {e.text}</li>)}</ul>
    <h3 className={styles.groupTitle}>Latest in MASON-INBOX.md</h3>
    <ul className={styles.compact}>{newest(data.inbox, 5).map((e, i) => <li key={i}><span>{e.at} · {e.source}</span><p className={styles.messageText}>{e.text}</p></li>)}</ul>
  </section>;
}
