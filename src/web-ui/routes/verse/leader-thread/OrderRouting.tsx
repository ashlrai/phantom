/**
 * routes/verse/leader-thread/OrderRouting.tsx — the routing trail under one of
 * Mason's messages in the Leader thread: one row per job the message became,
 * with the lane it was routed to, a four-step track (queued, launched,
 * published, merged) and the recorded result. A launched job opens its
 * Worker log; a published one links its PR. Presentational: the facts come
 * from thread-routing-model.
 */
import { useState } from 'react';
import { ROUTING_STAGES, type LineRouting, type RoutedJob } from './thread-routing-model.js';
import styles from './order-routing.module.css';

/** Rows shown before the rest fold behind "Show N more". */
const VISIBLE_JOBS = 4;

function Track({ job }: { job: RoutedJob }) {
  return <span className={styles.track} aria-hidden="true">
    {ROUTING_STAGES.map((stage, index) => <span key={stage} data-on={index < job.reached || undefined} data-current={index === job.reached - 1 || undefined} />)}
  </span>;
}

function JobRow({ job, onOpenJob }: { job: RoutedJob; onOpenJob: (id: string) => void }) {
  return <li className={styles.job} data-state={job.empty ? 'empty' : job.state}>
    <Track job={job} />
    <span className={styles.lane} data-unknown={job.lane === null || undefined} title={job.lane === null ? 'No launch marker or queue row names a lane' : `Routed to ${job.lane}`}>{job.lane ?? 'lane unknown'}</span>
    {job.openable
      ? <button type="button" className={styles.id} aria-label={`Open log for ${job.id}`} onClick={() => onOpenJob(job.id)}>{job.id}</button>
      : <span className={styles.id}>{job.id}</span>}
    {job.href
      ? <a className={styles.word} href={job.href} target="_blank" rel="noreferrer">{job.word}</a>
      : <span className={styles.word}>{job.word}</span>}
  </li>;
}

export function OrderRouting({ routing, onOpenJob }: { routing: LineRouting; onOpenJob: (id: string) => void }) {
  const [all, setAll] = useState(false);
  if (routing.state !== 'routed') {
    return <p className={styles.root} data-routing={routing.state}><span className={styles.label}>Routing</span><span className={styles.summary}>{routing.summary}</span></p>;
  }
  const shown = all ? routing.jobs : routing.jobs.slice(0, VISIBLE_JOBS);
  const hidden = routing.jobs.length - shown.length;
  return <div className={styles.root} data-routing="routed" role="group" aria-label={`Routing: ${routing.summary}`}>
    <p className={styles.head}><span className={styles.label}>Routed</span><span className={styles.summary}>{routing.summary}</span></p>
    <ul className={styles.jobs}>
      {shown.map(job => <JobRow key={job.id} job={job} onOpenJob={onOpenJob} />)}
    </ul>
    {hidden > 0 ? <button type="button" className={styles.more} onClick={() => setAll(true)}>Show {hidden} more</button> : null}
  </div>;
}
