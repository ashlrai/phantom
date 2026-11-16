import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CopyPill } from '../apps/CopyPill.js';
import { GMAIL_TRIAGE_COMMAND, GMAIL_TRIAGE_PATH, GMAIL_TRIAGE_SAMPLE_NOTE, gmailEvidenceLine, gmailTriageLine, readGmailEvidence, readGmailTriageView } from './gmail-triage-model.js';
import styles from './fleet-inbox.module.css';

const gmailTriageQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-gmail-triage', fetch: s => apiGet(GMAIL_TRIAGE_PATH, s) };

/** Read only: shows the last Gmail triage result; never moves or sends mail. */
export function GmailTriageCard({ visible }: { visible: boolean }) {
  const triage = useQuery(gmailTriageQuery, { enabled: visible });
  const refetch = useRefetch(gmailTriageQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const view = !triage || triage.error ? null : readGmailTriageView(triage.data);
  if (view === null) return null;
  if (view.state === 'never') {
    return <section className={styles.cos} aria-label="Gmail triage">
      <h3 className={styles.day}>Gmail triage</h3>
      <p className={styles.meta}>Gmail not triaged yet</p>
      <p className={styles.meta}><CopyPill text={GMAIL_TRIAGE_COMMAND} what="the Gmail triage command" /></p>
    </section>;
  }
  const line = gmailTriageLine(view, Date.now());
  return <section className={styles.cos} aria-label="Gmail triage" data-over-target={view.overTarget ? 'true' : undefined}>
    <h3 className={styles.day}>Gmail triage</h3>
    <p className={styles.meta}>{line.summary}</p>
    <p className={styles.meta}>{line.unread}</p>
    <p className={styles.meta}>{gmailEvidenceLine(readGmailEvidence(triage.data))}</p>
    <p className={styles.meta}>{GMAIL_TRIAGE_SAMPLE_NOTE}</p>
  </section>;
}
