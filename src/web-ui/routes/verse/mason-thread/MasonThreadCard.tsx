/**
 * The operator panel (desktop pane and phone card): one timeline of what the operator
 * said on any channel and what the leader sent back, each of his messages
 * tagged Received, Assigned, Running, Blocked or Verified with its jobs. The
 * same request on two channels shows once. Read-only: nothing here sends.
 * Data is phantom.mason.thread.v1, the same as `phm mason thread --json`.
 * Text is untrusted and renders as plain text.
 */
import { MASON_THREAD_EMPTY, masonStateWord, type MasonThreadItem } from '../../../../core/comms/mason-thread-model.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { Row, Section } from '../mobile/ui-parts.js';
import { masonThreadQuery } from './mason-thread-queries.js';

const time = (iso: string): string => iso.slice(11, 16);

function title(item: MasonThreadItem): string {
  const also = item.also_on.length > 0 ? ` (also ${item.also_on.join(', ')})` : '';
  return item.dir === 'in' ? `Operator via ${item.channel}${also}` : `Leader to ${[item.channel, ...item.also_on].join(', ')}`;
}

export function MasonThreadCard() {
  const query = useQuery(masonThreadQuery);
  const thread = query.data;
  if (!thread) {
    return query.status === 'error'
      ? <Section title="Operator"><Row title="Unknown right now" subtitle={readFailureReason(query.error)} /></Section>
      : null;
  }
  return (
    <Section title="Operator">
      {thread.items.length === 0 ? <Row title={MASON_THREAD_EMPTY} /> : (
        <ul aria-label="Operator thread" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {thread.items.map((item) => (
            <li key={`${item.at}-${item.dir}-${item.channel}-${item.text.slice(0, 24)}`}>
              <Row
                title={`${time(item.at)} ${title(item)}: ${item.text}`}
                subtitle={item.state === null ? undefined : `${masonStateWord(item.state)}${item.job_ids.length > 0 ? ` · ${item.job_ids.join(', ')}` : ''}`}
              />
            </li>
          ))}
        </ul>
      )}
      {thread.gaps.map((gap) => <Row key={gap} title={`Unknown: ${gap}`} />)}
    </Section>
  );
}
