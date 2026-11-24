/**
 * Home's Disk card: job worktrees by state and how much is safe to remove.
 * Built only on the `phm worktrees --json` report (worktrees.v1). Read-only:
 * removal stays one CLI command, which the card names.
 */
import type { WorktreeState, WorktreesReport } from '../../../../core/fleet/worktrees.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

export const WORKTREES_PATH = '/api/verse/fleet/runs/worktrees';
const query: QueryDef<WorktreesReport> = { key: 'worktrees', fetch: signal => apiGet(WORKTREES_PATH, signal) };
const STATES: Array<[WorktreeState, string]> = [
  ['merged', 'merged PR'], ['empty', 'empty result'], ['open', 'open PR'], ['live', 'live job'], ['kept', 'kept on purpose'], ['unknown', 'unknown'],
];

export function bytesText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : '0 KB';
}

/** Only a well-formed worktrees.v1 payload is a report. */
function reportOf(data: unknown): WorktreesReport | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<WorktreesReport>;
  return report.schema === 'worktrees.v1' && report.counts !== undefined ? report as WorktreesReport : null;
}

export function DiskCard({ visible = true }: { visible?: boolean }) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 5 * 60_000, { enabled: visible });
  const report = reportOf(read.data);
  let body;
  if (read.status === 'error' && !report) body = <p data-unknown>Unknown: the worktree list could not be read.</p>;
  // Before the first read, or any other payload (an older server), the card stays hidden.
  else if (!report) return null;
  else if (report.counts.total === 0) {
    body = <p>No job worktrees.</p>;
  } else {
    const { counts } = report;
    const over = counts.total > report.warnAt;
    body = <>
      <p data-warn={over || undefined}>{counts.total} job worktrees{over ? `, over the warning level of ${report.warnAt}` : ''}.</p>
      <ul aria-label="Worktrees by state">{STATES.filter(([state]) => counts[state] > 0).map(([state, label]) =>
        <li key={state}>{label}: {counts[state]}</li>)}</ul>
      <p>Safe to remove: {counts.safe} ({bytesText(report.reclaimableBytes)}{report.reclaimableComplete ? '' : ' or more'}).</p>
      {!report.sourcesOk && <p data-unknown>Some records could not be read, so nothing is marked safe.</p>}
      {over && <p>To list the removal commands, run <code className={styles.command}>phm worktrees --reap --plan</code></p>}
      {counts.safe > 0 && <p>To remove them, run <code className={styles.command}>phm worktrees --reap --apply</code></p>}
    </>;
  }
  return <section className={styles.card} aria-label="Disk"><h3>Disk</h3>{body}</section>;
}
