/**
 * routes/verse/ops/OpsLeaders.tsx : the leaders' channel on the team event
 * bus: who leads (owners, admins and agents declaring the leader
 * capability), what they have said on the `leaders` channel, and the
 * handoffs and approvals still open on the bus. Posting appends the same
 * `message.posted` event `phm team say` writes, so the CLI and any other
 * reader of the log see it too.
 */
import { useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { opsLeadersQuery, postLeaderMessage } from './ops-queries.js';
import type { OpsLeaderMember } from '../../../../core/verse/ops-types.js';
import styles from './ops.module.css';

function MemberChip({ member }: { member: OpsLeaderMember }) {
  return (
    <li className={styles.member} data-online={member.online || undefined} data-leader={member.leader || undefined}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.memberId}>{member.id}</span>
      <span className={styles.memberRole}>{member.role}{member.provider ? ` · ${member.provider}` : ''}</span>
    </li>
  );
}

export function OpsLeaders() {
  const read = useQuery(opsLeadersQuery, { freshMs: 5_000 });
  const refetch = useRefetch(opsLeadersQuery);
  usePollWhileVisible(refetch, 10_000);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const data = read.data;

  async function send() {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      await postLeaderMessage(text);
      setDraft('');
      refetch();
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'The message could not be sent.');
    } finally {
      setPosting(false);
    }
  }

  const leaders = data?.leaders.filter((m) => m.leader) ?? [];
  const others = data?.leaders.filter((m) => !m.leader) ?? [];
  const busiest = data?.channels.find((c) => c.channel !== data.channel);

  return (
    <section className={styles.panel} aria-labelledby="ops-leaders-title">
      <div className={styles.header}>
        <div>
          <h2 id="ops-leaders-title">Leaders' channel</h2>
          <p>The leadership lane of the shared team bus{data ? ` (team ${data.team})` : ''}: the same log the CLI and Telegram read and write.</p>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        </div>
      </div>
      {read.status === 'error' ? <p role="status">The leaders channel is unavailable. Refresh to reconnect.</p>
        : !data ? <p role="status">Reading the channel…</p>
        : <>
            <h3 className={styles.groupTitle}>Leaders</h3>
            {leaders.length === 0 && others.length === 0
              ? <p className={styles.empty}>Nobody has joined this team yet. Join with `phm team join`.</p>
              : <ul className={styles.members}>
                  {leaders.map((m) => <MemberChip key={m.id} member={m} />)}
                  {others.map((m) => <MemberChip key={m.id} member={m} />)}
                </ul>}

            {data.pendingApprovals.length > 0
              ? <>
                  <h3 className={styles.groupTitle}>Waiting on a decision</h3>
                  <ul className={styles.compact}>
                    {data.pendingApprovals.map((a) => <li key={a.id}>{a.action} requested by {a.requestedBy}</li>)}
                  </ul>
                </>
              : null}
            {data.openHandoffs.length > 0
              ? <>
                  <h3 className={styles.groupTitle}>Open handoffs</h3>
                  <ul className={styles.compact}>
                    {data.openHandoffs.map((h) => <li key={h.id}>{h.title} · {h.from}{h.to ? ` to ${h.to}` : ''} ({h.state})</li>)}
                  </ul>
                </>
              : null}

            <h3 className={styles.groupTitle}>#{data.channel}</h3>
            {data.messages.length === 0
              ? <p className={styles.empty}>
                  Nothing on this channel yet.{busiest ? ` The #${busiest.channel} channel has ${busiest.count} message${busiest.count === 1 ? '' : 's'}.` : ''}
                </p>
              : <ol className={styles.transcript}>
                  {data.messages.map((m) => (
                    <li key={m.id} className={styles.message}>
                      <span className={styles.messageFrom}>{m.from}</span>
                      <span className={styles.messageAt}>{m.at}</span>
                      <p className={styles.messageText}>{m.text}</p>
                    </li>
                  ))}
                </ol>}

            <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <label htmlFor="ops-leaders-compose" className={styles.composerLabel}>Post to #{data.channel}</label>
              <textarea
                id="ops-leaders-compose"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                maxLength={4_000}
                placeholder="Say it on the bus: the CLI's `phm team view` and Telegram both see it."
                disabled={!data.canPost || posting}
              />
              <div className={styles.composerRow}>
                {!data.canPost ? <span className={styles.note}>Read-only: posting needs dispatch on.</span> : null}
                {postError ? <span role="alert" className={styles.postError}>{postError}</span> : null}
                <Button size="sm" variant="primary" type="submit" disabled={!data.canPost || posting || !draft.trim()}>
                  {posting ? 'Posting…' : 'Post to leaders'}
                </Button>
              </div>
            </form>
          </>}
    </section>
  );
}
