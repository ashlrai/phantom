import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CopyPill } from '../apps/CopyPill.js';
import { gmailEvidenceLine, readGmailEvidence, triageAge } from './gmail-triage-model.js';
import styles from './fleet-inbox.module.css';

export const GMAIL_ARCHIVE_PLAN_PATH = '/api/verse/comms/gmail-triage/archive-plan';
const SCHEMA = 'fleet.gmail-archive-plan-latest.v1';
const COMMAND = 'ashlr fleet gmail-archive-plan';
const STALE_MS = 24 * 3_600_000;

const gmailArchivePlanQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-gmail-archive-plan', fetch: s => apiGet(GMAIL_ARCHIVE_PLAN_PATH, s) };

interface Plan { inbox: string; at: string; unread: number; target: number; archiveCount: number; topSenders: { sender: string; count: number }[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Plans from the payload; [] when none saved; null when the payload is not ours. Defensive, never repairing. */
function readPlans(data: unknown): Plan[] | null {
  if (!isRecord(data) || data.schema !== SCHEMA) return null;
  if (data.latest === null) return [];
  if (!isRecord(data.latest) || data.latest.schema !== SCHEMA || !Array.isArray(data.latest.plans)) return null;
  const plans: Plan[] = [];
  for (const p of data.latest.plans as unknown[]) {
    if (!isRecord(p) || typeof p.inbox !== 'string' || typeof p.at !== 'string' || !isCount(p.unread) || !isCount(p.target)
      || !isCount(p.archiveCount) || !Array.isArray(p.topSenders)) return null;
    const topSenders = (p.topSenders as unknown[]).flatMap(s => isRecord(s) && typeof s.sender === 'string' && isCount(s.count) ? [{ sender: s.sender, count: s.count }] : []);
    plans.push({ inbox: p.inbox, at: p.at, unread: p.unread, target: p.target, archiveCount: p.archiveCount, topSenders: topSenders.slice(0, 3) });
  }
  return plans;
}

/** Read only: shows the latest Gmail archive plan per inbox; never moves, sends or deletes mail. */
export function GmailArchivePlanCard({ visible }: { visible: boolean }) {
  const query = useQuery(gmailArchivePlanQuery, { enabled: visible });
  const refetch = useRefetch(gmailArchivePlanQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const plans = !query || query.error ? null : readPlans(query.data);
  if (plans === null) return null;
  if (plans.length === 0) {
    return <section className={styles.cos} aria-label="Gmail archive plan">
      <h3 className={styles.day}>Gmail archive plan</h3>
      <p className={styles.meta}>No archive plan yet. Run <CopyPill text={COMMAND} what="the Gmail archive plan command" />.</p>
    </section>;
  }
  const now = Date.now();
  const evidence = readGmailEvidence(query.data);
  return <section className={styles.cos} aria-label="Gmail archive plan">
    <h3 className={styles.day}>Gmail archive plan</h3>
    {plans.map(p => {
      const then = Date.parse(p.at);
      const stale = Number.isFinite(then) && now - then > STALE_MS;
      return <div key={p.inbox} aria-label={`Archive plan for ${p.inbox}`}>
        <p className={styles.meta}><strong>{p.inbox}</strong> · {triageAge(p.at, now)}{stale && ' · stale'}</p>
        <p className={styles.meta}>{p.unread} {evidence.scope === 'saved-export-sample' ? 'unread in the saved export' : 'unread (source unknown)'} (target {p.target}) · would archive {p.archiveCount}</p>
        {p.topSenders.length > 0 && <p className={styles.meta}>Top senders: {p.topSenders.map(s => `${s.sender} (${s.count})`).join(', ')}</p>}
      </div>;
    })}
    <p className={styles.meta}>{gmailEvidenceLine(evidence)}</p>
    <p className={styles.meta}>Archive only, nothing is deleted.</p>
  </section>;
}
