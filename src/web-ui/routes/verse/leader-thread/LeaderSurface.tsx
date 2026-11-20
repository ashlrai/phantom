/**
 * The Leader pane as the dock and Home mount it: who is working right now,
 * then the conversation. The strip and the conversation are siblings so the
 * strip can hand a job to the reply box without the conversation knowing it.
 */
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { LeaderRoster } from './LeaderRoster.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import styles from './leader-roster.module.css';

export function LeaderSurface({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  return <div className={styles.surface}>
    <LeaderRoster visible={visible} onOpenSessions={() => host.openPane('fleet-sessions')}
      onOpenLog={job => { requestWorkerLogJob(job); host.openPane('worker-log'); }} />
    <div className={styles.thread}><LeaderThreadPane visible={visible} /></div>
  </div>;
}
