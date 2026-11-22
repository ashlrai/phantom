/**
 * routes/verse/ideas/FixNext.tsx: the top of the Ideas view. What the fleet
 * should do next, ranked by `GET /api/verse/fleet/control/ideas` (same report as
 * `phm ideas --json`), with one action per idea: "Queue it"
 * (`POST /api/verse/fleet/control/ideas/queue`, same as `phm ideas queue <id>`). Signals the
 * server could not read are named as not checked, never filled in.
 */
import { useState } from 'react';
import type { BottleneckIdea, IdeaListReport, QueueIdeaResult, SignalName } from '../../../../core/fleet/bottleneck-ideas.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './ideas.module.css';

/** An older server (or a wrong route) answers with another shape: treat it as unreadable, not as an empty list. */
export const ideaListQuery: QueryDef<IdeaListReport> = {
  key: 'ideas-list',
  fetch: async signal => {
    const report = await apiGet<IdeaListReport>('/api/verse/fleet/control/ideas', signal);
    if (!report || report.schema !== 'fleet.idea-list.v1' || !Array.isArray(report.ideas) || !Array.isArray(report.signals)) throw new Error('unexpected ideas list');
    return report;
  },
};

const SIGNAL_LABEL: Record<SignalName, string> = {
  'empty-launches': 'Empty launches',
  'guardian-fixups': 'Main guardian fixes',
  'disk-trend': 'Disk trend',
  'idle-lanes': 'Idle lanes',
  'unspent-usage': 'Unspent usage',
  'loop-hints': 'Self-awareness loop',
  vision: 'Leader vision',
  queue: 'Work queue',
  'mason-inbox': 'Mason requests',
  'job-events': 'Job events',
};

/** `emptyRate=0.6` → `empty rate 0.6`; a null value reads "unknown". */
export function evidenceText(evidence: BottleneckIdea['evidence']): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ${value ?? 'unknown'}`)
    .join(' · ');
}

export function notCheckedText(report: IdeaListReport): string | null {
  const unknown = report.signals.filter(signal => signal.status === 'unknown');
  return unknown.length === 0 ? null : `Not checked: ${unknown.map(signal => `${SIGNAL_LABEL[signal.name] ?? signal.name} (${signal.reason ?? 'unknown'})`).join('; ')}.`;
}

export async function postQueueIdea(id: string): Promise<QueueIdeaResult> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token to queue ideas.');
  const result = await apiPost<QueueIdeaResult>('/api/verse/fleet/control/ideas/queue', { id }, token);
  if (!result || typeof result.jobId !== 'string' || typeof result.queued !== 'boolean') throw new Error('The queue returned an invalid response. Please try again.');
  touchMutationHold();
  return result;
}

type QueueState = { busy: true } | { done: QueueIdeaResult } | { error: string };

export function FixNext({ visible }: { visible: boolean }) {
  const result = useQuery(ideaListQuery, { enabled: visible, freshMs: 30_000 });
  const refetch = useRefetch(ideaListQuery);
  usePollWhileVisible(() => { refetch(); }, 30_000, { enabled: visible });
  const [states, setStates] = useState<ReadonlyMap<string, QueueState>>(new Map());
  const set = (id: string, state: QueueState) => setStates(prev => new Map(prev).set(id, state));
  const queue = (id: string) => {
    set(id, { busy: true });
    postQueueIdea(id).then(done => set(id, { done }), (err: unknown) => set(id, { error: err instanceof Error ? err.message : 'Could not queue this idea.' }));
  };

  const report = result.data;
  const notChecked = report ? notCheckedText(report) : null;
  return <Card title="Next bets">
    {report === undefined ? <CardNote tone={result.status === 'error' ? 'unknown' : 'muted'}>{result.status === 'error' ? 'Could not read ideas.' : 'Checking ideas…'}</CardNote> : <>
      {report.ideas.length === 0 ? <CardNote>{notChecked ? 'No candidates from the available sources.' : 'No ideas to queue right now.'}</CardNote> : <ol className={styles.list}>
        {report.ideas.map(idea => {
          const state = states.get(idea.id);
          const status = idea.status === 'proposed' && !idea.evidence.existingJobId && state && 'done' in state ? 'queued' : idea.status;
          const jobId = state && 'done' in state ? state.done.jobId : '';
          const jobLabel = jobId.startsWith('RQ-') ? jobId : `RQ-PHX-${jobId}`;
          return <li key={idea.id} className={styles.ideaCard}>
            <span className={styles.title}>{idea.title}</span>
            <span className={styles.meta}>Why: {idea.why}</span>
            <span className={styles.meta}>{idea.lane ?? 'Unknown lane'} · {status}</span>
            <span className={styles.meta}>{idea.payoff.text}</span>
            <span className={styles.meta}>{evidenceText(idea.evidence)}</span>
            <span className={styles.actions}>
              <button type="button" className={styles.toggle} disabled={status !== 'proposed' || typeof idea.evidence.existingJobId === 'string' || (state !== undefined && 'busy' in state)}
                onClick={() => queue(idea.id)} aria-label={`Queue it: ${idea.title}`}>Queue it</button>
              {state && 'done' in state ? <span className={styles.chip} role="status">{state.done.queued ? `Queued as ${jobLabel}` : `Already queued as ${jobLabel}`}</span> : null}
              {state && 'error' in state ? <span className={styles.chipBad} role="alert">{state.error}</span> : null}
            </span>
          </li>;
        })}
      </ol>}
      {notChecked ? <CardNote tone="unknown">{notChecked}</CardNote> : null}
    </>}
  </Card>;
}
