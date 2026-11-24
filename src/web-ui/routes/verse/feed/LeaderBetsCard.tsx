/**
 * routes/verse/feed/LeaderBetsCard.tsx — "Leader bets": the latest leader batch and whether it worked.
 * Reads GET /api/fleet/leader-bets (the same report as `phm bets`); the card adds nothing the CLI cannot say.
 * Nothing judged yet reads "unknown", never 0%. The bet list is one tap away so the phone card stays short.
 * Text is untrusted and stays plain; a link shows only for a github.com pull request URL.
 */
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { LeaderBatch, LeaderBetsReport, LeaderBetStage } from '../../../../core/fleet/leader-batches.js';
import { CardNote } from '../command/Surface.js';
import styles from './feed.module.css';

export const leaderBetsQuery: QueryDef<LeaderBetsReport> = { key: 'leader-bets', fetch: signal => apiGet<LeaderBetsReport>('/api/fleet/leader-bets', signal) };
const STAGE: Record<LeaderBetStage, string> = { queued: 'Queued', running: 'Running', pr_open: 'PR open', merged: 'Merged', empty: 'Empty', ended: 'Ended, no result' };
const ORDER: readonly LeaderBetStage[] = ['merged', 'pr_open', 'running', 'queued', 'ended', 'empty'];

const isReport = (v: unknown): v is LeaderBetsReport => !!v && typeof v === 'object' && (v as LeaderBetsReport).schema === 'fleet.leader-bets.v1' && Array.isArray((v as LeaderBetsReport).batches);
const safeUrl = (u: unknown): string | null => typeof u === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(u) ? u : null;

/** The plain sentence for a batch's hit rate. */
export function hitRateLine(batch: Pick<LeaderBatch, 'hit_rate' | 'judged' | 'counts'>): string {
  return typeof batch.hit_rate !== 'number' ? 'Hit rate unknown: nothing judged yet'
    : `Hit rate ${Math.round(batch.hit_rate * 100)}%: ${batch.counts.merged} of ${batch.judged} judged merged`;
}

export function LeaderBetsCardView({ report }: { report: LeaderBetsReport | undefined }) {
  const batch = report?.batches[0];
  return <section className={styles.betsCard} aria-labelledby="leader-bets-title">
    <h2 id="leader-bets-title">Leader bets</h2>
    {!report ? <CardNote>Loading leader bets…</CardNote>
      : !batch ? <CardNote tone={report.known ? undefined : 'unknown'}>{report.known ? 'No leader bets in the last day.' : 'Leader bets are unknown: the job metrics file could not be read.'}</CardNote>
        : <>
          <p className={styles.betsHead}><strong>Batch {batch.batch}</strong> · {batch.bets.length} {batch.bets.length === 1 ? 'bet' : 'bets'}</p>
          <p className={styles.betsRate} data-known={batch.hit_rate !== null}>{hitRateLine(batch)}</p>
          <p className={styles.meta}>{ORDER.filter(s => batch.counts[s]).map(s => `${batch.counts[s]} ${STAGE[s].toLowerCase()}`).join(' · ')}</p>
          <details className={styles.group}>
            <summary>Show all {batch.bets.length}</summary>
            <ul>{batch.bets.map(bet => {
              const url = safeUrl(bet.url);
              return <li key={bet.id}>{bet.id}: {STAGE[bet.stage] ?? 'Unknown'}{(bet.stage === 'empty' || bet.stage === 'ended') ? ` (${bet.reason ?? 'reason unknown'})` : ''}
                {url ? <> · <a href={url} target="_blank" rel="noopener noreferrer">PR</a></> : null}</li>;
            })}</ul>
          </details>
        </>}
  </section>;
}

export function LeaderBetsCard({ visible }: { visible: boolean }) {
  const read = useQuery(leaderBetsQuery, { enabled: visible, freshMs: 60_000 });
  const report = isReport(read.data) ? read.data : undefined;
  // An older hub has no such route (404): the card stays away instead of claiming anything. Once read, the last report stays on screen.
  if (!report && read.error) return null;
  return <LeaderBetsCardView report={report} />;
}
