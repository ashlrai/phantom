/**
 * routes/verse/mobile/LeaderReplies.tsx — the Leader's half of the Home
 * thread: the answers in MASON-OUTBOX.md interleaved with Mason's own
 * recent inbox lines, directly under the interject box.
 *
 * Reads the shared inbox-tail query — same cache key MobileInterject
 * polls, so this adds no request of its own. Merging, ordering, the 8-row
 * cap and the "answers" link all live in leader-replies-model.ts; the text
 * is untrusted and renders plain, never as HTML.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { OUTBOX_KIND_LABEL, type OutboxKind } from '../../../../core/fleet/outbox-kind.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { inboxTailQuery } from './inbox-tail-query.js';
import { leaderReplyRows } from './leader-replies-model.js';
import { mobileTime } from './interject-ack-model.js';
import { Badge, Row, Section, ui, type Tone } from './ui-parts.js';

const KIND_TONE: Readonly<Record<OutboxKind, Tone>> = {
  decision: 'warning', alert: 'danger', done: 'success', fyi: 'neutral',
};

export function LeaderReplies() {
  const query = useQuery(inboxTailQuery);
  const refetch = useRefetch(inboxTailQuery);
  usePollWhileVisible(refetch, 20_000);
  if (query.error !== undefined && query.data === undefined) {
    return <Section title="Leader replies"><p className={ui.faint}>Leader replies could not be read.</p></Section>;
  }
  const rows = leaderReplyRows(query.data?.outbox ?? [], query.data?.inbox ?? [], Date.now());
  const hasLeader = rows.some(row => row.who === 'leader');
  return (
    <Section title="Leader replies">
      {query.data !== undefined && !hasLeader ? <Row title="No reply from the Leader yet" /> : null}
      {rows.map((row, index) => (
        <Row
          key={`${row.at}-${index}`}
          title={row.text}
          subtitle={`${row.who === 'leader' ? 'Leader' : 'You'} · ${row.at ? mobileTime(row.at) : '—'}${row.answers ? ` · answers “${row.answers}”` : ''}`}
          trailing={row.kind ? <Badge tone={KIND_TONE[row.kind]}>{OUTBOX_KIND_LABEL[row.kind]}</Badge> : undefined}
        />
      ))}
    </Section>
  );
}
