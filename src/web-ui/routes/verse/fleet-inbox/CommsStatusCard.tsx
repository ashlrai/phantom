import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CopyPill } from '../apps/CopyPill.js';
import { EMAIL_DROP_USAGE } from '../fleet-channels/fleet-channels-model.js';
import { COMMS_STATUS_PATH, commsStatusLines, imessageStatusLine, readCommsStatus, teammateLatencyLine } from './comms-status-model.js';
import styles from './fleet-inbox.module.css';

const commsStatusQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-status', fetch: s => apiGet(COMMS_STATUS_PATH, s) };

export function CommsStatusCard({ visible }: { visible: boolean }) {
  const status = useQuery(commsStatusQuery, { enabled: visible });
  const refetch = useRefetch(commsStatusQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const parsed = !status || status.error ? null : readCommsStatus(status.data);
  if (parsed === null) return null;
  const lines = commsStatusLines(parsed, Date.now());
  return <section className={styles.cos} aria-label="Comms agent status">
    <h3 className={styles.day}>Comms</h3>
    <p className={styles.meta}>{lines.drafts}</p>
    <p className={styles.meta}>
      {lines.email}
      {lines.showEmailDropHint && <> <CopyPill text={EMAIL_DROP_USAGE.replace(/^usage: /, '')} label={EMAIL_DROP_USAGE} what="the email drop command" /></>}
    </p>
    {parsed.imessage !== null && <p className={styles.meta}>{imessageStatusLine(parsed.imessage, Date.now())}</p>}
    {parsed.teammate !== null
      ? <p className={styles.meta}>{teammateLatencyLine(parsed.teammate)}</p>
      : parsed.teammateSource === 'degraded' && <p className={styles.meta}>Dot reply speed unknown (teammate log unreadable)</p>}
    {lines.stuckReasons !== null && <p className={styles.meta}>{lines.stuckReasons}</p>}
  </section>;
}
