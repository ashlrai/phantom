/**
 * Intent pane: local owner directives, their RQ keys, and which ones have
 * gone stale. Reads GET /api/verse/intent. It does not edit the ledger.
 */
import { SkeletonLine } from '../../../components/primitives/index.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { intentPanelModel, type IntentPayload } from './intent-model.js';
import styles from './intent.module.css';

export const INTENT_PATH = '/api/verse/intent';
const POLL_MS = 15_000;

export const intentQuery: QueryDef<IntentPayload> = {
  key: 'verse-intent-ledger',
  fetch: (signal) => apiGet<IntentPayload>(INTENT_PATH, signal),
};

export function IntentPane({ visible }: PaneProps) {
  const read = useQuery(intentQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(intentQuery);
  usePollWhileVisible(refetch, POLL_MS, { enabled: visible });
  if (read.data === undefined && read.status !== 'error') {
    return <div className={styles.root} role="status"><span>Reading intents…</span><SkeletonLine /></div>;
  }
  const model = intentPanelModel(read.status === 'error' ? null : read.data);
  if (!model.ready) return <p className={styles.message}>Intent ledger is unknown. Import one with phm intent import.</p>;
  const headline = `${model.items ?? 'unknown'} items · ${model.tracked ?? 'unknown'} tracked · ${model.merged ?? 'unknown'} merged · ${model.shipped ?? 'unknown'} shipped · ${model.verified ?? 'unknown'} verified · ${model.stale ?? 'unknown'} stale`;
  return <section className={styles.root} aria-label="Intents">
    <p className={styles.headline}>{headline}</p>
    {model.rows.length === 0
      ? <p className={styles.message}>No intents yet.</p>
      : <ul className={styles.list}>
        {model.rows.map((row) => <li key={row.id} className={styles.row} data-stale={row.stale ? 'true' : 'false'}>
          <p className={styles.title}>{row.title}{row.partial ? ' (partial)' : ''}</p>
          <p className={styles.meta}>{row.status}{row.stale ? ' · stale' : ''}{row.rq ? ` · ${row.rq}` : ''}{row.pr ? ` · ${row.pr}` : ''}</p>
        </li>)}
      </ul>}
  </section>;
}
