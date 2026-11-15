import { useEffect, useMemo, useState } from 'react';
import type { ComputeNode, FleetCompute } from '../../../../core/fleet/compute-view.js';
import { apiGet } from '../../../data/client.js';
import { fleetLanesQuery, fleetSessionsQuery, type QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { jobDetailQuery } from '../fleet-job-log/worker-log-queries.js';
import { JobActivity } from '../fleet-job-log/JobActivity.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { openDockPane } from '../dock/dock-store.js';
import { agentBusPageQuery } from '../fleet-bus/agent-bus-queries.js';
import { advanceCores, family, isFleetCompute, placeSession, type CoreHistory, type MapSession } from './compute-model.js';
import { recordedAt, shown } from './company-model.js';
import styles from './compute.module.css';

export const computeQuery: QueryDef<FleetCompute> = {
  key: 'fleet-compute', fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/compute', signal);
    if (!isFleetCompute(value)) throw new Error('Unsupported compute observation');
    return value;
  },
};
const coordinationQuery = agentBusPageQuery(0, 100);
const gib = (v: number | null | undefined) => v == null ? 'unknown' : `${(v / 1024 ** 3).toFixed(1)} GiB`;
const fresh = (at: number | null | undefined, now: number) => at != null && at <= now && now - at <= 90_000;

function CoreSparks({ history, current }: { history?: CoreHistory; current: boolean }) {
  if (!history || !current) return <p>Per-core utilization unknown</p>;
  return <details><summary>Per-core utilization · last {history.samples.length} observations</summary>
    <div className={styles.cores}>{history.previous.cores.map((_, core) => {
      const value = history.samples.at(-1)?.[core];
      let pen = false;
      const d = history.samples.map((s, i) => {
        const v = s[core];
        if (v == null) { pen = false; return ''; }
        const segment = `${pen ? 'L' : 'M'}${i * 3},${30 - v * 0.3}`; pen = true; return segment;
      }).join(' ');
      return <div key={core}><small>CPU {core + 1}: {value == null ? 'unknown · awaiting delta' : `${value.toFixed(0)}%`}</small>
        <svg viewBox="0 0 96 32" role="img" aria-label={`CPU ${core + 1} history`}><path d={d} fill="none" stroke="currentColor" /></svg></div>;
    })}</div></details>;
}

function Token({ session, enabled, selected, choose }: { session: MapSession; enabled: boolean; selected: boolean; choose: () => void }) {
  const query = useMemo(() => jobDetailQuery(session.job), [session.job]);
  const active = enabled && session.status === 'running';
  const detail = useQuery(query, { enabled: active });
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 15_000, { enabled: active });
  const lastLine = detail.data?.log?.tail?.filter(line => line.trim()).at(-1);
  return <button type="button" className={styles.token} data-state={session.status} aria-pressed={selected} onClick={choose}>
    <strong>{session.job}</strong><span>{session.lane ?? 'lane unknown'} · {session.model ?? 'model unknown'}</span>
    <span>{session.status} · {session.elapsedSeconds === null ? 'age unknown' : `${Math.floor(session.elapsedSeconds / 60)}m elapsed`}</span>
    <small>{detail.status === 'error' ? 'Activity unavailable · last excerpt may be stale' : lastLine ? `Last log excerpt (time unknown): ${lastLine.slice(0, 160)}` : 'Activity unknown'}</small>
  </button>;
}

function AgentDetail({ session, node, enabled, openLog }: { session: MapSession; node?: ComputeNode; enabled: boolean; openLog: () => void }) {
  const query = useMemo(() => jobDetailQuery(session.job), [session.job]);
  const detail = useQuery(query, { enabled, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 5_000, { enabled });
  const bus = useQuery(coordinationQuery, { enabled });
  const refreshBus = useRefetch(coordinationQuery);
  usePollWhileVisible(refreshBus, 5_000, { enabled });
  const messages = bus.data?.messages.filter(row => {
    const body = row.envelope.body as { jobId?: unknown } | null;
    return body?.jobId === session.job || row.envelope.from === session.job || row.envelope.to === session.job;
  }) ?? [];
  const data = detail.data;
  return <section className={styles.detail} aria-label="Agent detail">
    <h3>{session.job}</h3><p>{session.lane ?? 'lane unknown'} · {session.model ?? 'model unknown'} · {session.status}</p>
    <p>Node: {node?.id ?? 'unassigned / placement unknown'} · Owner: {node?.jobs.find(j => j.job === session.job)?.owner ?? 'unknown'}</p>
    <p>Branch: {data?.branch ?? 'unknown'} · Worktree: {data?.branch ? 'recorded; changed files below' : 'unknown'}</p>
    <p>Outcome: {session.outcome ?? 'unknown'} · Merge state: {data?.publish?.autoMerge === true ? 'auto-merge enabled' : 'unknown'}</p>
    {(data?.publish?.prUrl ?? session.prUrl) && <a href={data?.publish?.prUrl ?? session.prUrl!} target="_blank" rel="noreferrer">Open recorded PR</a>}
    {detail.status === 'error' && <p role="alert">Job detail unavailable; retained details may be stale.</p>}
    <button type="button" onClick={openLog}>Open full job log</button>
    <h4>Claims & handoffs</h4><p>Matching records in the first 100 retained bus messages; this is a partial coordination window.</p>
    {bus.status === 'error' && <p role="alert">Coordination refresh failed; retained records may be stale.</p>}
    {messages.length ? <ul>{messages.map(row => {
      const kind = (row.envelope.body as { kind?: unknown } | null)?.kind;
      return <li key={row.envelope.id}>{row.envelope.from} → {row.envelope.to} · {typeof kind === 'string' ? kind.slice(0, 64) : 'message'} · {new Date(row.receivedAt).toISOString()}</li>;
    })}</ul> : <p>{bus.data ? 'No matching records in this window.' : 'Coordination unknown.'}</p>}
    <JobActivity job={session.job} enabled={enabled} pollMs={5_000} />
  </section>;
}

/** Both maps use the same observations, selection and detail pane. No seeded nodes or synthetic activity. */
export function ComputeMap({ visible, host }: Pick<PaneProps, 'visible'> & Partial<Pick<PaneProps, 'host'>>) {
  const sectionVisible = useSectionVisible(), documentVisible = useDocumentVisible();
  const enabled = visible && sectionVisible && documentVisible;
  const compute = useQuery(computeQuery, { enabled, freshMs: 0 });
  const sessions = useQuery(fleetSessionsQuery, { enabled, freshMs: 0 });
  const lanes = useQuery(fleetLanesQuery, { enabled, freshMs: 0 });
  const refreshCompute = useRefetch(computeQuery), refreshSessions = useRefetch(fleetSessionsQuery), refreshLanes = useRefetch(fleetLanesQuery);
  usePollWhileVisible(refreshCompute, 5_000, { enabled });
  usePollWhileVisible(refreshSessions, 5_000, { enabled });
  usePollWhileVisible(refreshLanes, 15_000, { enabled });
  const [mode, setMode] = useState<'2D' | '3D'>('2D');
  const [group, setGroup] = useState(true), [heat, setHeat] = useState(true);
  const [yaw, setYaw] = useState(0), [tilt, setTilt] = useState(15), [zoom, setZoom] = useState(1);
  const [selection, select] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, CoreHistory>>({});
  const data = compute.data;
  useEffect(() => {
    if (!data) return;
    setHistory(old => Object.fromEntries(data.nodes.filter(n => n.stats).map(n => [n.id, advanceCores(old[n.id], n.stats!, Date.parse(data.generatedAt))])));
  }, [data]);
  const now = Date.now();
  const nodes = data?.nodes ?? [];
  const observed = sessions.data?.sessions ?? [];
  const jobs: MapSession[] = [...observed];
  for (const node of nodes) for (const claim of node.jobs) if (!jobs.some(j => j.job === claim.job)) jobs.push({ job: claim.job, lane: null, model: null, status: 'running', elapsedSeconds: null, prUrl: null, outcome: null, live: 'unknown' });
  const placements = new Map(jobs.map(job => [job.job, placeSession(job, nodes, data?.localNodeId ?? '')]));
  const location = (job: MapSession) => placements.get(job.job) ?? null;
  const selected = jobs.find(j => j.job === selection) ?? sessions.data?.recent.find(j => j.job === selection);
  const maxCores = Math.max(1, ...nodes.map(n => n.stats?.cores.length ?? 0));
  function tokens(rows: MapSession[]) {
    const groups = group ? [...new Set(rows.map(s => s.lane ?? 'Lane unknown'))] : ['All lanes'];
    return groups.map(lane => {
      const members = group ? rows.filter(s => (s.lane ?? 'Lane unknown') === lane) : rows;
      return <section key={lane} className={styles.lane}><h4>{lane}</h4>{[...new Set(members.map(s => family(s.job)))].map(name => <div key={name}><small>{name}</small>
        {members.filter(s => family(s.job) === name).map(s => <Token key={s.job} session={s} enabled={enabled} selected={s.job === selection} choose={() => select(s.job)} />)}</div>)}</section>;
    });
  }
  return <section className={styles.root} aria-label="Fleet compute map">
    <header><p>PHANTOM / LIVE FLEET</p><h2>The company at work</h2><p>Compute → lanes → agents. Every reading carries its source time.</p></header>
    <div className={styles.toolbar} role="group" aria-label="Map controls">
      {(['2D', '3D'] as const).map(m => <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m}</button>)}
      <label><input type="checkbox" checked={group} onChange={e => setGroup(e.target.checked)} />Group lanes</label>
      <label><input type="checkbox" checked={heat} onChange={e => setHeat(e.target.checked)} />Capacity heat</label>
      <button type="button" onClick={() => { refreshCompute(); refreshSessions(); refreshLanes(); }}>Refresh fleet</button>
      <button type="button" onClick={() => host ? host.openPane('fleet-bus') : openDockPane('fleet-bus')}>Agent bus</button>
    </div>
    {mode === '3D' && <div className={styles.toolbar}>
      <label>Orbit <input aria-label="Orbit" type="range" min="-65" max="65" value={yaw} onChange={e => setYaw(Number(e.target.value))} /></label>
      <label>Tilt <input aria-label="Tilt" type="range" min="-35" max="35" value={tilt} onChange={e => setTilt(Number(e.target.value))} /></label>
      <label>Zoom <input aria-label="Zoom" type="range" min="0.4" max="1.5" step="0.05" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
    </div>}
    {[['Compute', compute], ['Sessions', sessions], ['Lanes', lanes]].map(([label, q]) => {
      const read = q as typeof compute;
      return read.status === 'error' ? <p key={String(label)} role="alert">{String(label)} refresh failed. {read.data ? 'Last reading retained; may be stale.' : 'No data available.'}</p> : null;
    })}
    <p>{data ? `Compute observed ${data.generatedAt} · ${recordedAt(data.generatedAt, now)}${data.truncated ? ' · partial inventory' : ''}` : 'No compute data yet.'}</p>
    <div className={styles.quota} aria-label="Lane quota strip">{!lanes.data?.lanes.length && <p>No lane observations.</p>}{lanes.data?.lanes.map(l => <article key={l.lane}>
      <strong>{l.lane}</strong><span>{shown(l.liveJobs)} running / {shown(l.slotTarget)} target / {shown(data?.lanes[l.lane]?.hardCap)} hard cap</span>
      <span>quota_ok: {data?.lanes[l.lane]?.quotaOk == null ? 'unknown' : String(data.lanes[l.lane]!.quotaOk)} · {l.credit.label}</span>
      <span>{l.hold?.held ? `HELD · ${l.hold.by ?? 'unknown'} · ${l.hold.reason ?? 'reason unknown'} · until ${l.hold.until ?? 'unknown'}` : l.hold ? 'No recorded hold' : 'Hold unknown'}</span>
      <small>Reset {l.credit.resetAt ?? 'unknown'} · {recordedAt(l.credit.observedAt, now)}</small>
    </article>) ?? <p>Lane quota: no data</p>}</div>
    <div className={styles.viewport} data-mode={mode}>
      <div className={styles.scene} style={mode === '3D' ? { transform: `scale(${zoom}) rotateX(${tilt}deg) rotateY(${yaw}deg)` } : undefined}>
        {nodes.map((n, i) => {
          const s = n.stats, current = fresh(s?.sampledAtMs, now), ceiling = s?.cores.length ? 2 * s.cores.length : null;
          const ratio = current && ceiling !== null && s?.load[0] != null ? s.load[0] / ceiling : null;
          return <article className={styles.machine} key={n.id} data-heat={heat && ratio !== null ? ratio >= 1 ? 'hot' : ratio >= 0.7 ? 'warm' : 'cool' : 'unknown'}
            style={{ flexGrow: s ? 1 + s.cores.length / maxCores : 1, transform: mode === '3D' ? `translateZ(${i % 2 * 70}px)` : undefined }}>
            <h3>{n.id}{n.local ? ' · this host' : ''}</h3><p>{n.state} · Heartbeat {n.heartbeatAt === null ? 'unknown' : recordedAt(n.heartbeatAt, now)}</p>
            <small>Metrics {s ? recordedAt(s.sampledAtMs, now) : 'unknown · no host-stats beat'}</small>
            <p>{s?.cores.length || 'unknown'} CPUs · Load 1/5/15: {s ? s.load.map(v => v === null ? 'unknown' : v.toFixed(1)).join(' / ') : 'unknown'}</p>
            <p>RAM {gib(s?.ramUsed)} / {gib(s?.ramTotal)} · Pressure {n.pressure ?? 'unknown'}</p>
            <p>Disk free {gib(s?.diskFree)} · Uptime {s ? `${Math.floor(s.uptimeSeconds / 3600)}h` : 'unknown'}</p>
            <CoreSparks history={history[n.id]} current={current} />
            <div className={styles.capacity}><span>Load ceiling (2 × CPU): {shown(ceiling)} · Slots {shown(n.slots)} · RAM slot ceiling {shown(n.ramSlots)}</span>
              <span>Memguard {n.memguardPaused === null ? 'unknown' : n.memguardPaused ? 'paused' : 'clear'}</span>
              {ratio === null ? <p>Headroom unknown · no fresh load reading</p> : <><meter aria-label={`${n.id} load versus ceiling`} min={0} max={1} value={Math.min(1, ratio)} /><small>{(ratio * 100).toFixed(0)}% of load ceiling · advisory; memory/slot gates remain independent</small></>}
            </div>
            {tokens(jobs.filter(j => location(j) === n.id))}
          </article>;
        })}
      </div>
    </div>
    {!nodes.length && <p>No nodes observed.</p>}
    <section aria-label="Unassigned agents"><h3>Queued / placement unknown</h3>{tokens(jobs.filter(j => location(j) === null))}</section>
    {!jobs.length && <p>{sessions.data?.sourceState === 'healthy' ? 'No active sessions recorded.' : 'Session inventory unknown.'}</p>}
    <p>Sessions: {sessions.data?.sourceState ?? 'unknown'}{sessions.data?.truncated ? ' · partial snapshot' : ''} · {recordedAt(sessions.data?.generatedAt, now)}. Dispatcher: {recordedAt(data?.dispatcherAt, now)}. {data && Object.entries(data.sources).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
    {selected && <AgentDetail key={selected.job} session={selected} node={nodes.find(n => n.id === location(selected))} enabled={enabled} openLog={() => { requestWorkerLogJob(selected.job); if (host) host.openPane('worker-log'); else openDockPane('worker-log'); }} />}
    {selection && !selected && <p role="status">Selected session left the active snapshot. See the job log for its outcome.</p>}
  </section>;
}
