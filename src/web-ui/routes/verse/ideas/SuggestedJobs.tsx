/**
 * routes/verse/ideas/SuggestedJobs.tsx: the top five jobs worth queuing next, from
 * `GET /api/verse/fleet/control/ideas/bets` (same report as `phm bets suggest --limit 5`).
 * One action per row: copy the queue line. Nothing here queues a job.
 */
import { useState } from 'react';
import type { BetSuggestion, NextBetsReport } from '../../../../core/fleet/next-bets.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './ideas.module.css';

const SIGNAL_LABEL: Record<NextBetsReport['signals'][number]['name'], string> = { lanes: 'lane status', pace: 'usage pace', yield: 'launch yield', mains: 'main health', releases: 'releases', autonomy: 'autonomy score' };
const WHY: Record<BetSuggestion['signal'], string> = { 'red-main': 'Red main', 'idle-lane': 'Idle lane', 'pool-waste': 'Usage expiring', release: 'Unreleased work' };

/** Another shape means an older server: unreadable, not an empty list. */
export const nextBetsQuery: QueryDef<NextBetsReport> = {
  key: 'ideas-next-bets',
  fetch: async signal => {
    const report = await apiGet<NextBetsReport>('/api/verse/fleet/control/ideas/bets', signal);
    if (!report || report.schema !== 'fleet.next-bets.v1' || !Array.isArray(report.suggestions) || !Array.isArray(report.signals)) throw new Error('unexpected suggestions');
    return report;
  },
};

export function SuggestedJobs({ visible }: { visible: boolean }) {
  const result = useQuery(nextBetsQuery, { enabled: visible, freshMs: 60_000 });
  const refetch = useRefetch(nextBetsQuery);
  usePollWhileVisible(() => { refetch(); }, 60_000, { enabled: visible });
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const copy = (bet: BetSuggestion) => {
    Promise.resolve().then(() => navigator.clipboard.writeText(bet.queueLine))
      .then(() => setCopied({ id: bet.id, ok: true }), () => setCopied({ id: bet.id, ok: false }));
  };

  const report = result.data;
  const unknown = report?.signals.filter(signal => signal.status === 'unknown').map(signal => SIGNAL_LABEL[signal.name] ?? signal.name) ?? [];
  return <Card title="Suggested jobs" caption="Copy a line into the queue to act">
    {report === undefined ? <CardNote tone={result.status === 'error' ? 'unknown' : 'muted'}>{result.status === 'error' ? 'Could not read suggested jobs.' : 'Checking signals…'}</CardNote> : <>
      {report.suggestions.length === 0 ? <CardNote>{unknown.length ? 'No suggestions from the signals that could be read.' : 'No suggested jobs right now.'}</CardNote> : <ol className={styles.list}>
        {report.suggestions.slice(0, 5).map(bet => <li key={bet.id} className={styles.ideaCard}>
          <span className={styles.title}>{bet.goal}</span>
          <span className={styles.meta}>{WHY[bet.signal] ?? bet.signal} · {bet.lane} · {bet.tier} · {bet.repo ?? 'any repo'} · score {bet.score}</span>
          <span className={styles.actions}>
            <button type="button" className={styles.toggle} onClick={() => copy(bet)} aria-label={`Copy queue line: ${bet.goal}`}>Copy queue line</button>
            {copied?.id === bet.id && copied.ok ? <span className={styles.chip} role="status">Copied</span> : null}
          </span>
          {copied?.id === bet.id && !copied.ok ? <code className={styles.chipBad} role="alert">Could not copy. Select this line: {bet.queueLine}</code> : null}
        </li>)}
      </ol>}
      {unknown.length ? <CardNote tone="unknown">Not checked: {unknown.join(', ')}.</CardNote> : null}
    </>}
  </Card>;
}
