import { useId } from 'react';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { runQuery } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../autonomy/format.js';
import { jobDetailQuery, notInBuild } from './workers-card-queries.js';
import styles from './workers-card.module.css';

const tones: Record<string, Tone> = { running: 'success', published: 'info', archived: 'neutral', unknown: 'warning' };
export function JobDetailSheet({ job, onClose }: { job: string; onClose: () => void }) {
  const id = useId();
  const query = jobDetailQuery(job);
  const read = useQuery(query);
  usePollWhileVisible(() => { void runQuery(query.key, () => query.fetch()); }, 5_000, { enabled: !notInBuild(read.error) });
  const d = read.data;
  const facts = d ? [['Lane', d.lane], ['Tier', d.tier], ['Model', d.model], ['Launched', formatRelative(d.launchedAt)], ['Base', d.baseSha?.slice(0, 7)], ['Branch', d.branch]] : [];
  return <Sheet open titleId={id} title={job} onClose={onClose}>
    {read.status === 'refreshing' ? <RefreshIndicator /> : null}
    {notInBuild(read.error) ? <p>Job detail is not in this build yet.</p> : read.error ? <p>Job detail unavailable.</p> : !d ? <SkeletonLine /> : <>
      <StatusBadge status={d.state} tone={tones[d.state]} />
      <dl className={styles.facts}>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd aria-label={`${label} ${value ?? 'unknown'}`}>{value ?? '—'}</dd></div>)}</dl>
      {d.publish?.prUrl ? <p><a href={d.publish.prUrl} target="_blank" rel="noreferrer">PR for job {job}</a></p> : null}
      {d.publish?.autoMerge != null ? <p>Auto-merge {d.publish.autoMerge ? 'on' : 'off'}</p> : null}
      <p>Notes present: {d.hasNotes === null ? 'unknown' : d.hasNotes ? 'yes' : 'no'}</p>
      {d.log.source === 'missing' ? <p>No log yet.</p> : <><h3>Log tail ({d.log.source}, {d.log.tail.length} lines{d.log.truncated ? ', truncated' : ''})</h3>
        <pre className={styles.log}>{d.log.tail.join('\n')}</pre></>}
    </>}
  </Sheet>;
}
