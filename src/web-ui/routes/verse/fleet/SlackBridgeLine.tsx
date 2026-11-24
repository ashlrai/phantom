import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { slackBridgeLine } from './slack-bridge-model.js';
import { slackBridgeQuery } from './slack-bridge-queries.js';
import { notInBuild } from './workers-card-queries.js';
import styles from './fleet.module.css';

/** One status line for the Slack bridge; renders nothing when the build lacks the route. */
export function SlackBridgeLine() {
  const read = useQuery(slackBridgeQuery, { freshMs: 30_000 });
  const refresh = useRefetch(slackBridgeQuery);
  usePollWhileVisible(refresh, 30_000);
  if (read.status === 'error' && notInBuild(read.error)) return null;
  if (!read.data) return null;
  const line = slackBridgeLine(read.data, Date.now());
  return <>
    <p className={styles.muted} role="status" data-tone={line.tone}>{line.text}</p>
    {line.next ? <details className={styles.muted}><summary>Next step</summary>{line.next}</details> : null}
  </>;
}
