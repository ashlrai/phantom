import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ComputeNode } from '../../../../core/fleet/compute-view.js';
import type { MapSession } from '../../../../core/fleet/sessions-view.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { fleetComputeQuery, fleetMessageGraphQuery, fleetNodesPlanQuery, fleetSessionMapQuery } from './fleet-map-queries.js';
import { age, bytes, cpuPercent, elapsed, fresh, number, prLink } from './fleet-map-model.js';
import styles from './FleetMap.module.css';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function NodeMetrics({ node, cpu, now }: { node: ComputeNode; cpu: number | null; now: number }) {
  const stats = fresh(node.stats?.sampledAtMs, now) ? node.stats : null;
  const measured = node.state === 'ready' && fresh(node.heartbeatAt, now);
  return <dl className={styles.metrics}>
    <div><dt>CPU</dt><dd>{number(stats ? cpu : null, '%')}</dd></div>
    <div><dt>Load · 1 / 5 / 15m</dt><dd>{[0, 1, 2].map(i => number(stats?.load[i])).join(' / ')}</dd></div>
    <div><dt>RAM used / total</dt><dd>{bytes(stats?.ramUsed)} / {bytes(stats?.ramTotal)}</dd></div>
    <div><dt>Disk free</dt><dd>{bytes(stats?.diskFree)}</dd></div>
    <div><dt>Claimed / measured slots</dt><dd>{measured ? node.jobs.length : 'unknown'} / {number(measured ? node.slots : null)}</dd></div>
    <div><dt>RAM-derived slot ceiling</dt><dd>{number(stats ? node.ramSlots : null)}</dd></div>
  </dl>;
}

function SessionTokens({ sessions, select }: { sessions: MapSession[]; select: (job: string) => void }) {
  return <ul className={styles.sessions}>{sessions.map(s => <li key={s.job}>
    <button type="button" className={styles.token} data-state={s.mapState} onClick={() => select(s.job)} aria-label={`Inspect session ${s.job}`}>
      <strong>{s.job}</strong><span>{s.lane ?? 'unknown'} · {s.model ?? 'unknown'}</span>
      <span>{s.status} · elapsed {elapsed(s.elapsedSeconds)}</span>
      <span className={styles.activity}>{s.activity ?? 'Activity unknown'}</span>
      {s.branch ? <span>Branch {s.branch}</span> : null}
      {prLink(s.prUrl) ? <span>PR #{s.prUrl!.split('/').at(-1)}</span> : null}
    </button>
  </li>)}</ul>;
}

/** Only GET queries; selections and links change browser navigation, never fleet state. */
export function FleetMap() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [started, setStarted] = useState(visible);
  const [now, setNow] = useState(Date.now);
  const compute = useQuery(fleetComputeQuery, { enabled: started, freshMs: 0 });
  const sessions = useQuery(fleetSessionMapQuery, { enabled: started, freshMs: 0 });
  const messages = useQuery(fleetMessageGraphQuery, { enabled: started, freshMs: 0 });
  // Badges are a plan, not a live reading: read once and again after 30 s, not on the 4 s tick (the read runs tailscale).
  const badges = useQuery(fleetNodesPlanQuery, { enabled: started, freshMs: 30_000 }).data ?? null;
  const refreshCompute = useRefetch(fleetComputeQuery), refreshSessions = useRefetch(fleetSessionMapQuery), refreshMessages = useRefetch(fleetMessageGraphQuery);
  const [params, setParams] = useSearchParams();
  const [samples, setSamples] = useState(new Map<string, { stats: ComputeNode['stats']; cpu: number | null }>());
  useEffect(() => {
    const visibility = () => {
      const shown = document.visibilityState !== 'hidden';
      setVisible(shown); setNow(Date.now());
      if (shown) { setStarted(true); refreshCompute(); refreshSessions(); refreshMessages(); }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now()); refreshCompute(); refreshSessions(); refreshMessages();
    }, 4000);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [refreshCompute, refreshSessions, refreshMessages]);
  useEffect(() => {
    if (!compute.data) return;
    const nodes = compute.data.nodes;
    setSamples(previous => new Map(nodes.map(node => {
      const old = previous.get(node.id);
      return [node.id, old && old.stats?.sampledAtMs === node.stats?.sampledAtMs ? old :
        { stats: node.stats, cpu: cpuPercent(old?.stats ?? null, node.stats) }];
    })));
  }, [compute.data]);
  const nodes = compute.data?.nodes ?? [];
  const active = sessions.data?.mapSessions ?? [], recent = sessions.data?.mapRecent ?? [];
  const byNode = new Map(nodes.map(n => [n.id, [] as MapSession[]]));
  const unplaced: MapSession[] = [];
  for (const s of active) {
    const group = s.nodeId === null || s.placement === 'conflict' ? undefined : byNode.get(s.nodeId);
    (group ?? unplaced).push(s);
  }
  const selectedJob = params.get('mapSession'), selectedNode = params.get('mapNode');
  const session = [...active, ...recent].find(s => s.job === selectedJob);
  const node = nodes.find(n => n.id === selectedNode);
  const select = (key: 'mapSession' | 'mapNode', id: string) => {
    const next = new URLSearchParams(params); next.delete('mapSession'); next.delete('mapNode'); next.set(key, id); setParams(next, { replace: true });
  };
  const close = () => { const next = new URLSearchParams(params); next.delete('mapSession'); next.delete('mapNode'); setParams(next, { replace: true }); };
  return <section className={styles.map} aria-labelledby="fleet-map-title">
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>LIVE TOPOLOGY · READ ONLY</p><h2 id="fleet-map-title">Fleet map</h2></div>
      <p className={styles.caption}>{visible ? 'Refreshes every 4s' : 'Updates paused'} · Compute updated {age(compute.data?.generatedAt, now)} · Sessions updated {age(sessions.data?.generatedAt, now)}</p>
    </header>
    <p className={styles.caption}>Heat = claimed slots / measured ceiling. Dashed zones have unknown capacity. CPU needs two fresh samples.</p>
    {([['Compute', compute], ['Sessions', sessions], ['Messages', messages]] as const).map(([label, query]) => query.status === 'error' ?
      <p key={label} role="alert">{label} unavailable{query.data ? ' · showing last reading' : ''}.</p> : !query.data ? <p key={label}>Loading {label.toLowerCase()}…</p> : null)}
    {compute.data ? <p className={styles.caption}>Compute sources: {Object.entries(compute.data.sources).map(([key, state]) => `${key} ${state}`).join(' · ')}</p> : null}
    {sessions.data ? <p className={styles.caption}>Sessions source {sessions.data.sourceState} · Placement observed {age(sessions.data.computeAt, now)}</p> : null}
    {compute.data?.truncated || sessions.data?.truncated ? <p role="status">Partial fleet: the source limit was reached.</p> : null}
    {compute.data && nodes.length === 0 ? <p>No machines observed.</p> : null}
    <div className={styles.grid}>{nodes.map(n => {
      const measured = n.state === 'ready' && fresh(n.heartbeatAt, now) && n.slots != null;
      const heat = measured && n.slots! > 0 ? n.jobs.length / n.slots! : null;
      return <section key={n.id} className={styles.node} data-capacity={measured ? 'measured' : 'unknown'} aria-label={`Machine ${n.id}`} style={{ '--heat': `${heat === null ? 0 : Math.min(1, heat) * 24}%` } as CSSProperties}>
        <div className={styles.header}><h3><button type="button" className={styles.nodeButton} onClick={() => select('mapNode', n.id)}>{n.id}</button></h3><span>{n.local ? 'local · ' : ''}{n.state}</span>{(() => {
          const badge = badges?.find(b => b.name.toLowerCase() === n.id.toLowerCase());
          return badge ? <span className={styles.badge} data-online={String(badge.online)} title={badge.why} aria-label={`Plan: ${badge.online === true ? 'online' : badge.online === false ? 'offline' : 'online unknown'}, ${badge.slots === 'unknown' ? 'slots unknown' : `${badge.slots} suggested ${badge.slots === 1 ? 'slot' : 'slots'}`}`}><span className={styles.dot} aria-hidden="true" />{badge.slots === 'unknown' ? '? slots' : `${badge.slots} ${badge.slots === 1 ? 'slot' : 'slots'}`}{!n.local && typeof badge.running === 'number' && badge.running > 0 ? <span className={styles.runningOn}> · Running on {n.id}</span> : null}</span> : null;
        })()}</div>
        <NodeMetrics node={n} cpu={samples.get(n.id)?.cpu ?? null} now={now} />
        <p className={styles.caption}>Telemetry {age(n.stats ? new Date(n.stats.sampledAtMs).toISOString() : null, now)}</p>
        {heat === null ? <p className={styles.caption}>{measured && n.slots === 0 ? 'Measured ceiling 0 · utilization undefined' : 'Capacity unknown'}</p> :
          <div className={styles.track} role="meter" aria-label={`${n.id} slot utilization`} aria-valuemin={0} aria-valuemax={Math.max(100, heat * 100)} aria-valuenow={heat * 100} aria-valuetext={`${n.jobs.length} of ${n.slots} measured slots`}><span style={{ width: `${Math.min(1, heat) * 100}%` }} /></div>}
        <SessionTokens sessions={byNode.get(n.id)!} select={job => select('mapSession', job)} />
        {!byNode.get(n.id)!.length ? <p className={styles.caption}>{sessions.data ? 'No sessions placed here.' : 'Sessions unknown.'}</p> : null}
      </section>;
    })}</div>
    {unplaced.length ? <section className={styles.unplaced} aria-label="Unplaced sessions"><h3>Machine unknown · {unplaced.length} sessions</h3><p className={styles.caption}>Placement is missing, conflicting, or outside the current machine snapshot.</p><SessionTokens sessions={unplaced} select={job => select('mapSession', job)} /></section> : null}
    {sessions.data && active.length === 0 ? <p>No active sessions observed{sessions.data.sourceState !== 'healthy' ? ' · session inventory incomplete' : ''}.</p> : null}
    {recent.length ? <details><summary>Recently finished · {recent.length}</summary><SessionTokens sessions={recent} select={job => select('mapSession', job)} /></details> : null}
    {messages.data ? <section className={styles.messages} aria-label="Agent messages">
      <h3>Messages · {plural(messages.data.messages ?? 0, 'message')} since {age(messages.data.since, now)}</h3>
      <p className={styles.caption}>Who messaged whom, grouped by the organization behind each agent. Names and counts only.</p>
      {messages.data.groups.length === 0 ? <p>No agent messages in this window.</p> : <ul className={styles.sessions}>{messages.data.groups.map(group => <li key={group.id}>
        <strong>{group.from} → {group.to}</strong> · {plural(group.count, 'message')} · last {age(group.lastAt, now)}
        <ul className={styles.caption}>{group.edges.map(edge => <li key={edge.id}>{edge.from} → {edge.to} · {edge.count}</li>)}</ul>
      </li>)}</ul>}
    </section> : null}
    <Sheet open={selectedJob !== null || selectedNode !== null} onClose={close} titleId="fleet-map-detail" title={selectedJob ?? selectedNode}>
      {session ? <>
        <p className={styles.detailActivity}>{session.activity ?? 'Activity unknown'}</p>
        <dl className={styles.details}>{Object.entries({ Callsign: 'unknown', Lane: session.lane, Model: session.model, Status: session.status, Machine: session.nodeId,
          Placement: session.placement, Elapsed: elapsed(session.elapsedSeconds), Branch: session.branch, Worktree: session.worktree, 'Owned files': 'unknown', Outcome: session.outcome,
        }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'unknown'}</dd></div>)}</dl>
        <p><Link to={`?mapSession=${encodeURIComponent(session.job)}`}>Job permalink</Link></p>
        {prLink(session.prUrl) ? <p><a href={prLink(session.prUrl)!} target="_blank" rel="noreferrer">Open PR</a></p> : <p>PR unknown</p>}
      </> : node ? <>
        <NodeMetrics node={node} cpu={samples.get(node.id)?.cpu ?? null} now={now} />
        <dl className={styles.details}><dt>Owners</dt><dd>{node.owners.join(', ') || 'unknown'}</dd><dt>Memory pressure</dt><dd>{node.pressure ?? 'unknown'}</dd><dt>Memory guard paused</dt><dd>{node.memguardPaused === null ? 'unknown' : String(node.memguardPaused)}</dd></dl>
        <SessionTokens sessions={byNode.get(node.id)!} select={job => select('mapSession', job)} />
      </> : <p>This selection is no longer in the current snapshot.</p>}
    </Sheet>
  </section>;
}
