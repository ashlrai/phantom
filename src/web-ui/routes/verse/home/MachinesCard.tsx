/**
 * Home's Machines card, on the desktop and the phone: the joined Macs as one pool, this Mac first, a tile per Mac
 * (whether it answers, free slots, memory in use, the jobs it is running, then load, disk and offload).
 * Built only on the `phm nodes pool --json` report (phantom.nodes-pool.v1). Read-only: with `onOpenJob`
 * (the desktop Home) each running job is a button that opens that job's messages; without it the names are plain text.
 */
import { NODES_POOL_SCHEMA, type NodesPool } from '../../../../core/fleet/nodes-pool-types.js';
import { apiGet, ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { machinesSummary, macTiles, type MacTile } from './machines-card-model.js';
import styles from './machines-card.module.css';

export const NODES_POOL_PATH = '/api/verse/fleet/control/nodes-pool';
const MAX_NODES = 32;
const STATUSES = ['online', 'offline', 'unknown'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const measured = (v: unknown) => v === 'unknown' || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160;

/** Accepts only a well-formed phantom.nodes-pool.v1 report; anything else (an older server, another payload) is no reading. */
export function narrowNodesPool(raw: unknown): NodesPool | null {
  if (!object(raw) || raw.schema !== NODES_POOL_SCHEMA || raw.schemaVersion !== 1 || !Array.isArray(raw.nodes) || raw.nodes.length > MAX_NODES
    || !object(raw.total) || !text(raw.total.line) || !Array.isArray(raw.reasons)) return null;
  for (const row of raw.nodes as unknown[]) {
    if (!object(row) || !text(row.name) || !text(row.state) || !STATUSES.includes(row.status as string) || !['on', 'off', 'unknown'].includes(row.offload as string)
      || !measured(row.freeSlots) || !measured(row.load) || !measured(row.freeMemoryBytes) || !measured(row.freeDiskGb) || typeof row.lastSeen !== 'string'
      || !(row.jobsRunning === 'unknown' || (Array.isArray(row.jobsRunning) && row.jobsRunning.length <= 500 && row.jobsRunning.every(text)))) return null;
  }
  return raw as unknown as NodesPool;
}

export const nodesPoolQuery: QueryDef<NodesPool | null> = {
  key: 'verse-fleet-nodes-pool',
  async fetch(signal) {
    try { return narrowNodesPool(await apiGet<unknown>(NODES_POOL_PATH, signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};

function Jobs({ mac, onOpenJob }: { mac: MacTile; onOpenJob?: (job: string) => void }) {
  if (mac.jobs === null) return <span className={styles.value} data-unknown>unknown</span>;
  if (mac.jobs.length === 0) return <span className={styles.value}>nothing</span>;
  return <span className={styles.jobs} role="group" aria-label={`Jobs running on ${mac.name}`}>
    {mac.jobs.map(job => onOpenJob && JOB_ID_RE.test(job)
      ? <button key={job} type="button" className={styles.job} aria-label={`Open messages for ${job}`} onClick={() => onOpenJob(job)}>{job}</button>
      : <span key={job} className={styles.job}>{job}</span>)}
    {mac.moreJobs > 0 && <span className={styles.label}>+{mac.moreJobs} more</span>}
  </span>;
}

function Mac({ mac, onOpenJob }: { mac: MacTile; onOpenJob?: (job: string) => void }) {
  return <li className={styles.mac} data-status={mac.status}>
    <span className={styles.head}>
      <span className={styles.name}>{mac.name}{mac.isSelf ? <span className={styles.self}>(this Mac)</span> : null}</span>
      <span className={styles.status} data-status={mac.status}>{mac.status}</span>
      <span className={styles.seen}>{mac.seen}</span>
    </span>
    {mac.slots === null ? <span className={styles.figure} data-unknown>free slots unknown</span>
      : <span className={styles.figure}><strong>{mac.slots}</strong>{mac.slots === 1 ? 'free slot' : 'free slots'}</span>}
    <span className={styles.reading}>
      <span className={styles.row}><span className={styles.label}>Memory</span>
        <span className={styles.value} data-unknown={mac.memoryWords === 'unknown' || undefined}>{mac.memoryWords}</span></span>
      {/* The words above carry the reading; the bar is the same share at a glance. */}
      {mac.memoryUsed === null ? <span className={styles.track} data-unknown aria-hidden="true" />
        : <span className={styles.track} role="meter" aria-label={`${mac.name} memory in use`} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={mac.memoryUsed} aria-valuetext={mac.memoryWords}><i className={styles.fill} style={{ width: `${mac.memoryUsed}%` }} /></span>}
    </span>
    <span className={styles.reading}><span className={styles.label}>Running</span><Jobs mac={mac} onOpenJob={onOpenJob} /></span>
    <dl className={styles.facts}>
      {mac.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd data-unknown={fact.unknown || undefined}>{fact.value}</dd></div>)}
    </dl>
  </li>;
}

export function MachinesCard({ visible = true, className = '', onOpenJob }: { visible?: boolean; className?: string; onOpenJob?: (job: string) => void }) {
  const read = useQuery(nodesPoolQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(nodesPoolQuery);
  usePollWhileVisible(refresh, 30_000, { enabled: visible });
  const pool = narrowNodesPool(read.data);
  // Before the first read, or on an older server, the card stays hidden.
  if (!pool) return null;
  return <section className={`${styles.card} ${className}`} aria-label="Machines">
    <h3 className={styles.title}>Machines</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Machines could not refresh. Showing the last reading.</p> : null}
    <p className={styles.line}>{pool.total.line}</p>
    {pool.nodes.length ? <>
      <p className={styles.muted}>{machinesSummary(pool)}</p>
      <ul className={styles.macs} aria-label="Macs in the pool">{macTiles(pool).map(mac => <Mac key={mac.name} mac={mac} onOpenJob={onOpenJob} />)}</ul>
    </> : <p className={styles.muted}>No Macs known. Run <code>phm node join</code> on each Mac.</p>}
    <p className={styles.muted}>Same for agents: <code>phm nodes pool --json</code></p>
  </section>;
}
