/**
 * The Org view on a phone: one column, top to bottom. A one-line headline, a pinned "Needs you"
 * card when something is waiting, then one row per lane that opens to its live jobs; a job opens
 * its log. It draws `fleet.org-groups.v1` (`phm fleet org --json`) and nothing else, so people
 * and agents read one source. A number the server did not send reads "unknown", never zero.
 */
import { useState } from 'react';
import { PLANNER_GROUPS, type FleetOrgGroups, type OrgGroupNode } from '../../../../core/fleet/org-groups.js';
import type { MapEdge } from '../../../../core/fleet/map-edges.js';
import { relativeAt } from '../fleet/bus-feed-model.js';
import { LaneHealthBadge } from '../../../components/fleet/LaneHealthBadge.js';
import styles from './phone-org.module.css';

/** Something that waits on the owner. No server read feeds this yet; the caller passes what it has. */
export interface OrgAsk { id: string; text: string }
export interface PhoneOrgProps {
  groups: FleetOrgGroups;
  asks?: readonly OrgAsk[];
  /** Open the log of the job with this id. */
  onOpenJob: (jobId: string) => void;
  /** `phm map edges`: who messaged whom in the last 15 minutes. Null or absent reads "unknown". */
  messages?: readonly MapEdge[] | null;
  now?: number;
  /** The drawn map (computers, pools, messages) stays one tap away. */
  onShowMap?: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}`;

function counts(node: OrgGroupNode): string {
  const { running, queued, unknown } = node.counts;
  return [`${running} running`, `${queued} queued`, ...unknown ? [`${unknown} unknown`] : []].join(', ');
}

function Usage({ pct, lane }: { pct: number | null | undefined; lane: string }) {
  if (pct === null || pct === undefined) return <span className={styles.unknown}>Usage unknown</span>;
  const used = Math.max(0, Math.min(100, Math.round(pct)));
  return <span className={styles.usage}>
    <span className={styles.track} role="meter" aria-label={`${lane} plan used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
      <span className={styles.fill} data-high={used >= 80 || undefined} style={{ width: `${used}%` }} />
    </span>
    <span>{used}% used</span>
  </span>;
}

function Row({ node, jobs, onOpenJob }: { node: OrgGroupNode; jobs: OrgGroupNode[]; onOpenJob: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const lane = node.role === 'lane';
  return <li className={styles.row}>
    <button type="button" className={styles.laneButton} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className={styles.laneTop}>
        <span className={styles.name}>{node.label}</span>
        {lane && <LaneHealthBadge health={node.health} />}
        <span aria-hidden="true" className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </span>
      <span className={styles.meta}>{counts(node)}</span>
      {lane && <Usage pct={node.usedPct} lane={node.label} />}
    </button>
    {open && (jobs.length === 0 ? <p className={styles.empty}>No live jobs.</p>
      : <ul className={styles.jobs}>{jobs.map(job => <li key={job.id}>
        <button type="button" className={styles.job} onClick={() => onOpenJob(job.label)} aria-label={`Open log for ${job.label}: ${job.status ?? 'unknown'}`}>
          <span className={styles.name}>{job.label}</span>
          <span className={styles.meta}>{job.status ?? 'unknown'}{job.live === false ? ' · no activity for 5 min' : ''}</span>
        </button>
      </li>)}</ul>)}
  </li>;
}

export function PhoneOrg({ groups, asks = [], onOpenJob, onShowMap, messages, now = Date.now() }: PhoneOrgProps) {
  const byId = new Map(groups.nodes.map(node => [node.id, node]));
  const leaves = (node: OrgGroupNode): OrgGroupNode[] => node.children.flatMap(id => {
    const child = byId.get(id)!;
    return child.role === 'job' ? [child] : leaves(child);
  });
  // The phone lists lanes and their jobs; the guardian and loops branches are on the full map and `phm org`.
  const rows = (byId.get(groups.root)?.children ?? []).filter(id => !PLANNER_GROUPS.has(id)).map(id => byId.get(id)!);
  return <section className={styles.root} aria-label="Fleet org">
    {asks.length > 0 && <section className={styles.asks} aria-label="Needs you">
      <h2>{asks.length === 1 ? 'Needs you' : `Needs you (${asks.length})`}</h2>
      <ul>{asks.map(ask => <li key={ask.id}>{ask.text}</li>)}</ul>
    </section>}
    <p className={styles.headline} data-testid="org-headline">{groups.headline.text}</p>
    {rows.length === 0 ? <p className={styles.empty}>{plural(0, 'lanes reported.')}</p>
      : <ul className={styles.rows}>{rows.map(node => <Row key={node.id} node={node} jobs={leaves(node)} onOpenJob={onOpenJob} />)}</ul>}
    {messages !== undefined && <section aria-label="Recent messages">
      <h2 className={styles.messagesTitle}>Messages, last 15 minutes</h2>
      {messages === null ? <p className={styles.unknown}>Messages unknown.</p>
        : messages.length === 0 ? <p className={styles.empty}>No messages.</p>
        : <ul className={styles.messages}>{messages.map(edge => <li key={edge.id}>
          <strong>{edge.from.name} → {edge.to.name}</strong>{edge.count > 1 ? ` (${edge.count})` : ''}
          <span className={styles.meta}> {relativeAt(edge.lastAt, now)}: “{edge.lastSummary}”</span></li>)}</ul>}
    </section>}
    {onShowMap && <button type="button" className={styles.showMap} onClick={onShowMap}>Show the full map</button>}
  </section>;
}
