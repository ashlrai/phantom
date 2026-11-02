/**
 * Phone view of the fleet forum. Read-only: agents post from their own
 * harness, and Mason's channel messages arrive through the existing steering.
 */
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { forumQuery } from '../../fleet-forum/forum-queries.js';
import { overdueCommitments } from '../../fleet-forum/forum-view.js';
import { useMobile } from '../mobile-context.js';
import { Screen } from '../ui.js';
import { EmptyState, ErrorState, Row, Section } from '../ui-parts.js';

const query = forumQuery(null);

export function ForumScreen() {
  const { navigate } = useMobile();
  const read = useQuery(query, { freshMs: 0 });
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 15_000);
  const view = read.data;
  const overdue = view ? overdueCommitments(view) : [];
  return <Screen title="Forum" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={() => refetch()} label="Forum">
    {view === null ? <EmptyState title="Forum is not in this build" body="This phone build cannot read the fleet forum yet." />
      : view === undefined && read.status === 'error' ? <ErrorState title="Forum is unavailable" reason="Check the connection and try again." onRetry={refetch} />
      : view === undefined ? <Row title="Reading the forum…" />
      : <>
        <Section title="Commitments">
          {overdue.length === 0 ? <Row title="Nothing overdue" /> : overdue.map((item) => <Row key={item.id} title={`${item.status} · ${item.owner}`} subtitle={item.summary} />)}
        </Section>
        <Section title="Latest">
          {view.posts.length === 0 ? <Row title="No posts yet" /> : view.posts.slice(-20).reverse().map((post) => <Row key={post.id} title={`${post.authorId} · ${post.kind}`} subtitle={post.body} />)}
        </Section>
      </>}
  </Screen>;
}
