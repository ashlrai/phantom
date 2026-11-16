/**
 * routes/approvals/ApprovalsView.tsx — the human side of the autonomous fleet
 * (RQ-DESK-APPROVALS-1). Renders GET /api/approvals, the same projection as
 * `phm approvals --json`; nothing here parses logs or scrapes anything.
 *
 *   1. Team approvals — Approve/Deny post to the server, which decides with the
 *      identity derived from the local OS user (decideApproval). The click IS
 *      the approval; the app never supplies or fakes an actor.
 *   2. Inbox proposals — a row with a `revision` can be decided through the
 *      same revision-bound POST /api/inbox/:id/decision the approval card uses:
 *      ConfirmDialog → MutationTokenDialog → consent only, NEVER execution.
 *      A row without one is review-only and links back to its inbox surface.
 *      (RQ-SWE-APPROVALS-1 recut.)
 *   3. Outbound drafts — terminal-only; the exact `phm drafts …` commands are
 *      shown, never the draft body.
 *   4. Security pin queue — read-only. Pins stay Security's.
 *   5. Holds — persistent until resolved in $ASHLR_HOME/holds.json.
 *
 * A section whose source failed says so (state 'unavailable'); it never
 * renders as the honest-empty "nothing pending".
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProposalApprovalItem } from '../../data/api-types.js';
import { approvalsQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { decideApprovalRequest, decideTeamApproval } from '../../data/mutations.js';
import { DispatchDisabledError } from '../../data/client.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ConfirmDialog } from '../inbox/ConfirmDialog.js';
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

  // Inbox-proposal consent flow: the same ConfirmDialog → MutationTokenDialog
  // → revision-bound POST sequence as ApprovalCard. Consent is recorded, never
  // applied; a 404 from the dispatch gate flips the surface to read-only.
  const [pendingConsent, setPendingConsent] = useState<{ item: ProposalApprovalItem; decision: 'approve' | 'deny' } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [dispatchBlocked, setDispatchBlocked] = useState(false);
  const consentInFlight = useRef(false);

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

  function requestConsent(item: ProposalApprovalItem, decision: 'approve' | 'deny') {
    setConsentError(null);
    setPendingConsent({ item, decision });
    setConfirmOpen(true);
  }

  async function confirmConsent() {
    const pending = pendingConsent;
    if (!pending || pending.item.revision === null || consentInFlight.current) return;
    // Confirmation first, token second — an accidental click can be cancelled
    // before the operator is asked for a mutation token (same ordering as
    // ApprovalCard).
    if (!hasMutationHold()) {
      setConfirmOpen(false);
      setTokenOpen(true);
      return;
    }
    consentInFlight.current = true;
    setConsentBusy(true);
    setConsentError(null);
    try {
      await decideApprovalRequest(pending.item.id, pending.item.revision, pending.decision);
      setConfirmOpen(false);
      setPendingConsent(null);
    } catch (err) {
      if (err instanceof DispatchDisabledError) {
        setConfirmOpen(false);
        setPendingConsent(null);
        setDispatchBlocked(true);
      } else {
        setConsentError(err instanceof Error ? err.message : 'Could not save this decision.');
      }
    } finally {
      consentInFlight.current = false;
      setConsentBusy(false);
    }
  }

  function onTokenDialogClose() {
    setTokenOpen(false);
    // Live read, not a render snapshot — onClose can fire before re-render.
    if (hasMutationHold()) {
      setConfirmOpen(true);
      void confirmConsent();
    } else {
      setPendingConsent(null);
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

          <section className={styles.section} aria-labelledby="appr-proposals">
            <h2 id="appr-proposals" className={styles.sectionTitle}>Inbox proposals ({data.proposals.items.length})</h2>
            {dispatchBlocked ? (
              <p className={styles.error} role="alert">
                This server was started without --allow-dispatch, so approve/deny are unavailable. Review links still work.
              </p>
            ) : null}
            {data.proposals.state !== 'ok' ? (
              <Unavailable reason={data.proposals.reason} />
            ) : data.proposals.items.length === 0 ? (
              <p className={styles.empty}>No pending proposals.</p>
            ) : (
              <ul className={styles.list}>
                {data.proposals.items.map((p) => (
                  <li key={p.id} className={styles.item}>
                    <div className={styles.itemBody}>
                      <span className={styles.itemTitle}>{p.title}</span>
                      <span className={styles.meta}>
                        {p.kind}{p.partial ? ' · partial capture — deny only' : ''}{p.detail ? ` — ${p.detail}` : ''}
                      </span>
                      {p.revision === null ? (
                        <span className={styles.meta}>
                          No reviewable approval request — open it to inspect and decide.{' '}
                          <Link to={p.reviewPath} className={styles.reviewLink}>Review</Link>
                        </span>
                      ) : (
                        <Link to={p.reviewPath} className={styles.reviewLink}>Review</Link>
                      )}
                    </div>
                    {p.revision !== null ? (
                      <div className={styles.actions}>
                        <button type="button" className={styles.approve} disabled={dispatchBlocked || consentBusy || p.partial}
                          title={p.partial ? 'Partial captures can be denied, but cannot be approved.' : undefined}
                          onClick={() => requestConsent(p, 'approve')}>
                          Approve…
                        </button>
                        <button type="button" className={styles.deny} disabled={dispatchBlocked || consentBusy}
                          onClick={() => requestConsent(p, 'deny')}>
                          Deny…
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {data.proposals.truncated ? <p className={styles.meta}>List capped — the oldest {data.proposals.items.length} shown.</p> : null}
          </section>

          <section className={styles.section} aria-labelledby="appr-drafts">
            <h2 id="appr-drafts" className={styles.sectionTitle}>Outbound drafts ({data.drafts.items.length})</h2>
            <p className={styles.meta}>Decided in the terminal only; the draft body is never listed.</p>
            {data.drafts.state !== 'ok' ? (
              <Unavailable reason={data.drafts.reason} />
            ) : data.drafts.items.length === 0 ? (
              <p className={styles.empty}>No pending drafts.</p>
            ) : (
              <ul className={styles.list}>
                {data.drafts.items.map((d) => (
                  <li key={d.id} className={styles.item}>
                    <div className={styles.itemBody}>
                      <span className={styles.itemTitle}>{d.subject}</span>
                      <span className={styles.meta}>to {d.to} · digest {d.digestPrefix}</span>
                      <code className={styles.mono}>{d.approveCommand}</code>
                      <code className={styles.mono}>{d.rejectCommand}</code>
                      <code className={styles.mono}>{d.showCommand}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.drafts.truncated ? <p className={styles.meta}>List capped — the oldest {data.drafts.items.length} shown.</p> : null}
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

          <MutationTokenDialog open={tokenOpen} reason="Recording an approval decision requires the mutation token."
            onClose={onTokenDialogClose} />
          <ConfirmDialog
            open={confirmOpen}
            title={pendingConsent?.decision === 'approve' ? 'Approve this request?' : 'Deny this request?'}
            body={<>
              {pendingConsent?.item.title} · <code>{pendingConsent?.item.kind}</code><br />
              {pendingConsent?.decision === 'approve'
                ? 'This records approval only. It does not execute the action.'
                : 'This records a denial and keeps the request in inbox history.'}
            </>}
            confirmLabel={pendingConsent?.decision === 'approve' ? 'Record approval' : 'Record denial'}
            destructive={pendingConsent?.decision === 'approve'}
            busy={consentBusy}
            error={consentError}
            onConfirm={() => void confirmConsent()}
            onClose={() => {
              if (!consentInFlight.current) {
                setConfirmOpen(false);
                setPendingConsent(null);
                setConsentError(null);
              }
            }}
          />
        </>
      )}
    </div>
  );
}
