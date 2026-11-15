/**
 * routes/approvals/ApprovalsView.tsx — the human side of the autonomous fleet
 * (RQ-DESK-APPROVALS-1). Renders GET /api/approvals, the same projection as
 * `phm approvals --json`; nothing here parses logs or scrapes anything.
 *
 *   1. Team approvals — Approve/Deny post to the server, which decides with the
 *      identity derived from the local OS user (decideApproval). The click IS
 *      the approval; the app never supplies or fakes an actor.
 *   2. Security pin queue — read-only. Pins stay Security's.
 *   3. Holds — persistent until resolved in $ASHLR_HOME/holds.json.
 *
 * A section whose source failed says so (state 'unavailable'); it never
 * renders as the honest-empty "nothing pending".
 */
import { useRef, useState } from 'react';
import { approvalsQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { decideTeamApproval } from '../../data/mutations.js';
import { useScrollRestore } from '../../hooks/useScrollRestore.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import styles from './ApprovalsView.module.css';

export function formatAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function Unavailable({ reason }: { reason?: string }) {
  return (
    <p className={styles.error} role="alert">
      Source unavailable{reason ? `: ${reason}` : ''}. This is not the same as "nothing pending".
    </p>
  );
}

export function ApprovalsView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/approvals', containerRef);

  const query = useQuery(approvalsQuery);
  const data = query.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(id);
    setFailure(null);
    try {
      await decideTeamApproval(id, decision, data?.team);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Decision failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Approvals</h1>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        </div>
      </header>

      {query.status === 'loading' ? (
        <SkeletonLine width="60%" />
      ) : !data ? (
        <p className={styles.error} role="alert">{query.error?.message ?? 'Failed to load approvals.'}</p>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="appr-team">
            <h2 id="appr-team" className={styles.sectionTitle}>Team approvals ({data.teamApprovals.items.length})</h2>
            {failure ? <p className={styles.error} role="alert">{failure}</p> : null}
            {data.teamApprovals.state !== 'ok' ? (
              <Unavailable reason={data.teamApprovals.reason} />
            ) : data.teamApprovals.items.length === 0 ? (
              <p className={styles.empty}>Nothing pending.</p>
            ) : (
              <ul className={styles.list}>
                {data.teamApprovals.items.map((a) => (
                  <li key={a.id} className={styles.item}>
                    <div className={styles.itemBody}>
                      <span className={styles.itemTitle}>{a.summary}</span>
                      <span className={styles.meta}>
                        requested by {a.requestedBy}{a.note ? ` — "${a.note}"` : ''}
                      </span>
                      <code className={styles.mono}>{a.command}</code>
                    </div>
                    <div className={styles.actions}>
                      <button type="button" className={styles.approve} disabled={busy !== null} onClick={() => void decide(a.id, 'approve')}>
                        Approve
                      </button>
                      <button type="button" className={styles.deny} disabled={busy !== null} onClick={() => void decide(a.id, 'deny')}>
                        Deny
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.section} aria-labelledby="appr-pins">
            <h2 id="appr-pins" className={styles.sectionTitle}>Security pin queue ({data.pins.items.length})</h2>
            <p className={styles.meta}>Read-only. Pins are decided by Security.</p>
            {data.pins.state !== 'ok' ? (
              <Unavailable reason={data.pins.reason} />
            ) : data.pins.items.length === 0 ? (
              <p className={styles.empty}>Nothing staged.</p>
            ) : (
              <ul className={styles.list}>
                {data.pins.items.map((p) => (
                  <li key={p.name} className={styles.item}>
                    <div className={styles.itemBody}>
                      <span className={styles.itemTitle}>{p.name}</span>
                      <span className={styles.meta}>
                        {p.filesTouched}{p.truncated ? '+' : ''} file{p.filesTouched === 1 && !p.truncated ? '' : 's'} · staged {formatAge(p.ageMs)} ago
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.section} aria-labelledby="appr-holds">
            <h2 id="appr-holds" className={styles.sectionTitle}>Holds ({data.holds.items.length})</h2>
            {data.holds.state !== 'ok' ? (
              <Unavailable reason={data.holds.reason} />
            ) : data.holds.items.length === 0 ? (
              <p className={styles.empty}>
                {data.holds.configured ? 'No open holds.' : 'No holds configured.'}
              </p>
            ) : (
              <ul className={styles.list}>
                {data.holds.items.map((h) => (
                  <li key={h.id} className={styles.item}>
                    <div className={styles.itemBody}>
                      <span className={styles.itemTitle}>{h.title}</span>
                      <span className={styles.meta}>
                        {h.id}{h.since ? ` · since ${h.since}` : ''}{h.detail ? ` — ${h.detail}` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.meta}>Listed until marked resolved in {data.holds.path}; <code>phm approvals</code> reads the same file.</p>
          </section>
        </>
      )}
    </div>
  );
}
