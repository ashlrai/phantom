import type { FleetLaneView } from '../../../data/api-types.js';
import type { ReactNode } from 'react';
import type { ComputeNode, FleetCompute } from '../../../../core/fleet/compute-view.js';
import { ecosystemBrand } from '../../../../core/brand/ecosystem.js';
import { EcosystemMark } from '../../../components/brand/EcosystemMark.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { RelativeTime } from '../../../components/primitives/RelativeTime.js';
import { relativeTime } from '../../../lib/relative-time.js';
import { fresh } from './compute-model.js';
import styles from './compute.module.css';

export function Observation({ value, now = Date.now() }: { value: unknown; now?: number }) {
  const reading = relativeTime(value, now);
  return <RelativeTime value={value} now={now} fallback="Observation time unknown" prefix={reading && reading.seconds > 120 ? 'Stale · recorded ' : 'recorded '} />;
}

function NoTelemetry({ value, now, kind }: { value: unknown; now: number; kind?: string }) {
  return <small className={styles.noTelemetry}>No {kind ? `${kind} ` : ''}telemetry<RelativeTime value={value} now={now} prefix=" since " fallback=" yet" /></small>;
}

const count = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function LaneTelemetry({ lane, limits, state, now }: {
  lane: FleetLaneView; limits?: FleetCompute['lanes'][string]; state: string; now: number;
}) {
  const project = lane.lane.replace(/^ashlrai\//u, '');
  const brand = !project.includes('/') ? ecosystemBrand(project) : undefined;
  const { liveJobs, slotTarget, queueDepth, credit, hold } = lane;
  const hardCap = limits?.hardCap, quotaOk = limits?.quotaOk;
  const capacity = count(liveJobs) && count(slotTarget) && slotTarget > 0 ? { used: liveJobs, total: slotTarget } : null;
  const dispatch = [count(liveJobs) && `${liveJobs} running`, count(slotTarget) && `${slotTarget} target`, count(hardCap) && `${hardCap} hard cap`].filter(Boolean).join(' / ');
  const hasQuota = quotaOk != null || credit.state === 'observed' || hold?.held === true || count(slotTarget) || count(hardCap);
  return <article data-state={state}>
    <strong className={styles.laneName}>{brand ? <EcosystemMark brand={brand} /> : <ProviderBadge of={lane.lane} size={18} iconOnly />}{lane.lane}</strong>
    {dispatch && <span>{dispatch}</span>}
    {capacity && <progress className={styles.laneCapacity} aria-label={`${lane.lane} slot utilization`}
      aria-valuetext={`${capacity.used} running of ${capacity.total} target slots`} value={Math.min(capacity.used, capacity.total)} max={capacity.total} />}
    {count(queueDepth) && <span>{queueDepth} queued</span>}
    {!hasQuota ? <NoTelemetry value={credit.observedAt} now={now} kind={dispatch || count(queueDepth) ? 'capacity' : undefined} /> : <>
      {(quotaOk != null || credit.state === 'observed') && <span>{[quotaOk === true ? 'Quota available' : quotaOk === false ? 'Quota blocked' : null, credit.state === 'observed' ? credit.label : null].filter(Boolean).join(' · ')}</span>}
      {hold?.held && <span>{['HELD', hold.by, hold.reason, hold.until && `until ${hold.until}`].filter(Boolean).join(' · ')}</span>}
      {(credit.resetAt || credit.observedAt) && <small>{credit.resetAt && <>Reset <time dateTime={credit.resetAt} title={credit.resetAt}>{new Date(credit.resetAt).toLocaleString()}</time></>}
        {credit.resetAt && credit.observedAt && ' · '}{credit.observedAt && <Observation value={credit.observedAt} now={now} />}</small>}
    </>}
  </article>;
}

export function OfflineMachine({ node, now, children }: { node: ComputeNode; now: number; children: ReactNode }) {
  const lastSeen = [node.heartbeatAt, node.stats?.sampledAtMs].filter((at): at is number => typeof at === 'number' && relativeTime(at, now) !== null);
  return <article className={styles.offlineMachine}>
    <h3>{node.id}{node.local ? ' · this host' : ''}</h3>
    <NoTelemetry value={lastSeen.length ? Math.max(...lastSeen) : null} now={now} />
    {count(node.slots) && <small>{node.slots} last advertised slots</small>}
    {node.caps?.length ? <small>{node.caps.join(', ')}</small> : null}
    {node.stats && <details><summary>Last recorded readings</summary><MachineReadings node={node} now={now} /></details>}
    {children}
  </article>;
}

function gib(value: number) { return `${(value / 1024 ** 3).toFixed(1)} GiB`; }

export function MachineReadings({ node, now }: { node: ComputeNode; now: number }) {
  const { stats, pressure, slots, ramSlots, memguardPaused, caps } = node;
  return <>
    <p>{node.state}{node.heartbeatAt != null && <> · Heartbeat <Observation value={node.heartbeatAt} now={now} /></>}</p>
    {!stats ? <NoTelemetry value={node.heartbeatAt} now={now} kind={node.heartbeatAt != null ? 'host metrics' : undefined} /> : <>
      <small>Metrics <Observation value={stats.sampledAtMs} now={now} /></small>
      {stats.cores.length > 0 && <p>{stats.cores.length} CPUs · Load 1/5/15: {stats.load.map(v => v === null ? '—' : v.toFixed(1)).join(' / ')}</p>}
      <p>RAM {gib(stats.ramUsed)} / {gib(stats.ramTotal)}{pressure && ` · Pressure ${pressure}`}</p>
      <p>{stats.diskFree !== null && <>Disk free {gib(stats.diskFree)} · </>}Uptime {Math.floor(stats.uptimeSeconds / 3600)}h</p>
    </>}
    <div className={styles.machineFacts}>
      {count(slots) && <span>Slots {slots}{slots === 0 && node.state === 'ready' ? ' (held; reason not recorded)' : ''}</span>}
      {count(ramSlots) && <span>RAM slot ceiling {ramSlots}</span>}
      {caps?.length ? <span>Caps: {caps.join(', ')}</span> : null}
      {memguardPaused != null && <span>Memguard {memguardPaused ? 'paused' : 'clear'}</span>}
    </div>
  </>;
}

export function isOfflineWithoutFreshMetrics(node: ComputeNode, now: number) {
  return node.state === 'offline' && !fresh(node.stats?.sampledAtMs, now);
}
