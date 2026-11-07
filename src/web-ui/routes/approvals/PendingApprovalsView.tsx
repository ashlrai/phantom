/**
 * routes/approvals/PendingApprovalsView.tsx — "a user must never miss a
 * consent request" (operator-console surface at /approvals).
 *
 * One bounded, value-blind list of every approval waiting on the operator:
 * pending inbox proposals, outbound email drafts, and team
 * consequential-action approvals — aggregated by GET /api/approvals
 * (src/core/web/pending-approvals.ts). The response already decided HOW each
 * row may be acted on (`decide`):
 *
 *  - 'consent'     → Approve…/Deny… record consent through the same
 *                    revision-bound POST /api/inbox/:id/decision the
 *                    approval card uses — confirmation dialog, mutation
 *                    token, dispatch gate, all identical. It NEVER applies
 *                    the action; the copy says so before the click.
 *  - 'terminal'    → no web mutation exists (drafts, team approvals); the
 *                    exact `phm …` commands render as hints instead.
 *  - 'review-only' → no safe decision path; the row links to the full
 *                    review surface that owns the decision.
 *
 * Never renders secret values: the backend scrubs/caps every string, and
 * this view renders response fields as text only. A degraded source is
 * announced loudly — the view never claims an all-clear it cannot prove.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PendingApprovalItem, PendingApprovalSource } from '../../data/api-types.js';
import { pendingApprovalsQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { decideApprovalRequest } from '../../data/mutations.js';
import { DispatchDisabledError } from '../../data/client.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../components/primitives/Skeleton.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ConfirmDialog } from '../inbox/ConfirmDialog.js';
import {
  SOURCE_LABELS,
  degradedSources,
  formatAge,
  hiddenParameterCount,
  isPartialCapture,
  kindLabel,
  parameterChips,
} from './pending-approvals-model.js';
import styles from './PendingApprovalsView.module.css';

type PendingDecision = { item: PendingApprovalItem; decision: 'approve' | 'deny' } | null;

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function sourceStateLabel(state: string): string {
  if (state === 'healthy') return 'ok';
  if (state === 'missing') return 'no store yet';
  return 'unavailable';
}

function DecideCell({
  item,
  decisionsAvailable,
  onDecide,
}: {
  item: PendingApprovalItem;
  decisionsAvailable: boolean;
  onDecide: (item: PendingApprovalItem, decision: 'approve' | 'deny') => void;
}) {
  const decide = item.decide;
  if (decide.mode === 'terminal') {
    return (
      <div className={styles.terminal}>
        <span className={styles.terminalLabel}>Approve in terminal</span>
        <code className={styles.command}>{decide.approveCommand}</code>
        <code className={styles.command}>{decide.denyCommand}</code>
        {decide.showCommand ? <code className={styles.command}>{decide.showCommand}</code> : null}
      </div>
    );
  }
  if (decide.mode === 'review-only') {
    return (
      <div className={styles.decide}>
        <span className={styles.reason}>{decide.reason}</span>
        {item.reviewPath ? <ReviewLink path={item.reviewPath} /> : null}
      </div>
    );
  }
  // consent
  const partial = isPartialCapture(item);
  return (
    <div className={styles.decide}>
      {decisionsAvailable ? (
        <div className={styles.consentActions}>
          <button
            type="button"
            className={styles.denyButton}
            aria-label={`Deny ${item.title}`}
            onClick={() => onDecide(item, 'deny')}
          >
            Deny…
          </button>
          <button
            type="button"
            className={styles.approveButton}
            aria-label={`Approve ${item.title}`}
            disabled={partial}
            title={partial ? 'Partial captures can be denied, but cannot be approved.' : undefined}
            onClick={() => onDecide(item, 'approve')}
          >
            Approve…
          </button>
          {partial ? <span className={styles.reason}>Partial capture — deny only.</span> : null}
        </div>
      ) : (
        <span className={styles.reason}>This server is read-only — review the request to decide.</span>
      )}
      {item.reviewPath ? <ReviewLink path={item.reviewPath} /> : null}
    </div>
  );
}

function ReviewLink({ path }: { path: string }) {
  return (
    <Link to={path} className={styles.reviewLink}>
      Review
    </Link>
  );
}

export function PendingApprovalsView() {
  const query = useQuery(pendingApprovalsQuery);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dispatchBlocked, setDispatchBlocked] = useState(false);
  const inFlight = useRef(false);

  const data = query.data;
  const degraded = data ? degradedSources(data.sources) : [];
  const decisionsAvailable = (data?.dispatchEnabled ?? false) && !dispatchBlocked;

  function requestDecision(item: PendingApprovalItem, decision: 'approve' | 'deny') {
    setActionError(null);
    setPendingDecision({ item, decision });
    setConfirmOpen(true);
  }

  async function confirmDecision() {
    const pending = pendingDecision;
    if (!pending || pending.item.decide.mode !== 'consent' || inFlight.current) return;
    // Confirmation first, token second — an accidental click never reaches
    // for the mutation token (same ordering as ApprovalCard).
    if (!hasMutationHold()) {
      setConfirmOpen(false);
      setTokenOpen(true);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await decideApprovalRequest(pending.item.decide.proposalId, pending.item.decide.revision, pending.decision);
      setConfirmOpen(false);
      setPendingDecision(null);
    } catch (err) {
      if (err instanceof DispatchDisabledError) {
        setConfirmOpen(false);
        setPendingDecision(null);
        setDispatchBlocked(true);
      } else {
        setActionError(err instanceof Error ? err.message : 'Could not save this decision.');
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function onTokenDialogClose() {
    setTokenOpen(false);
    // Live read, not a render snapshot — onClose can fire before re-render.
    if (hasMutationHold()) {
      setConfirmOpen(true);
      void confirmDecision();
    } else {
      setPendingDecision(null);
    }
  }

  const pending = pendingDecision;
  const pendingConsent = pending?.item.decide.mode === 'consent' ? pending.item.decide : null;

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Pending approvals</h1>
          <p className={styles.subtitle}>
            Every consent request waiting on you — proposals, outbound email drafts, and team approvals — oldest
            first. Values stay blind: metadata only, never secrets.
          </p>
        </div>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          {data ? <span className={styles.freshnessLabel}>Updated {formatRelative(Date.parse(data.generatedAt))}</span> : null}
        </div>
      </header>

      {dispatchBlocked ? (
        <div className={styles.dispatchBanner} role="alert">
          This server was started without <code>--allow-dispatch</code>, so approve/deny are unavailable right now.
          Terminal commands and review links still work.
        </div>
      ) : null}

      {degraded.length > 0 ? (
        <div className={styles.sourceBanner} role="alert">
          {degraded.map((s) => SOURCE_LABELS[s as PendingApprovalSource]).join(', ')}{' '}
          {degraded.length === 1 ? 'source' : 'sources'} could not be read
          {data ? ` (${degraded.map((s) => data.sources[s as PendingApprovalSource].reason ?? 'read failed').join('; ')})` : ''} — this
          list may be incomplete. A consent request could be waiting that is not shown.
        </div>
      ) : null}

      {query.status === 'loading' ? (
        <div className={styles.panel}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : query.status === 'error' ? (
        <div className={styles.error} role="alert">
          {query.error?.message ?? 'Failed to load pending approvals.'}
        </div>
      ) : data ? (
        <>
          {data.approvals.length === 0 ? (
            <div className={styles.panel}>
              <p className={styles.empty}>
                {degraded.length > 0
                  ? 'No approvals could be listed — one or more sources are unavailable.'
                  : 'No pending approvals — nothing is waiting on you.'}
              </p>
            </div>
          ) : (
            <div className={styles.panel}>
              <table className={styles.table} aria-label="Pending approvals">
                <thead>
                  <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Source</th>
                    <th scope="col">Parameters</th>
                    <th scope="col">Age</th>
                    <th scope="col">Status</th>
                    <th scope="col">Decide</th>
                  </tr>
                </thead>
                <tbody>
                  {data.approvals.map((item) => {
                    const chips = parameterChips(item);
                    const hidden = hiddenParameterCount(item);
                    return (
                      <tr key={item.id}>
                        <td className={styles.requestCell}>
                          {item.reviewPath ? (
                            <Link to={item.reviewPath} className={styles.titleLink} title={item.title}>
                              {item.title}
                            </Link>
                          ) : (
                            <span className={styles.titleText} title={item.title}>
                              {item.title}
                            </span>
                          )}
                          {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
                        </td>
                        <td>{kindLabel(item.kind)}</td>
                        <td>{SOURCE_LABELS[item.source]}</td>
                        <td className={styles.paramsCell}>
                          {chips.length === 0 ? (
                            <span className={styles.muted}>—</span>
                          ) : (
                            <span className={styles.params} title={Object.entries(item.parameters).map(([k, v]) => `${k}: ${v ?? '—'}`).join('\n')}>
                              {chips.map((c) => (
                                <span key={c.key} className={styles.param}>
                                  <span className={styles.paramKey}>{c.key}</span> {c.value}
                                </span>
                              ))}
                              {hidden > 0 ? <span className={styles.paramMore}>+{hidden}</span> : null}
                            </span>
                          )}
                        </td>
                        <td className={styles.age}>{formatAge(item.createdAt)}</td>
                        <td>
                          <StatusBadge status={item.status} />
                        </td>
                        <td>
                          <DecideCell item={item} decisionsAvailable={decisionsAvailable} onDecide={requestDecision} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.truncated ? (
                <p className={styles.truncated}>
                  Showing the {data.approvals.length} oldest pending requests — the list is capped; decide items to
                  surface more.
                </p>
              ) : null}
            </div>
          )}
          <p className={styles.sourceNote}>
            Sources:{' '}
            {(Object.keys(data.sources) as PendingApprovalSource[]).map((s, i) => (
              <span key={s}>
                {i > 0 ? ' · ' : ''}
                {SOURCE_LABELS[s]} {sourceStateLabel(data.sources[s].sourceState)}
                {data.sources[s].reason ? ` (${data.sources[s].reason})` : ''}
              </span>
            ))}
          </p>
        </>
      ) : null}

      <MutationTokenDialog
        open={tokenOpen}
        onClose={onTokenDialogClose}
        reason="Recording an approval decision requires the mutation token."
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          if (!inFlight.current) {
            setConfirmOpen(false);
            setPendingDecision(null);
            setActionError(null);
          }
        }}
        title={pending?.decision === 'approve' ? 'Approve this request?' : 'Deny this request?'}
        body={
          pending && pendingConsent ? (
            <>
              {pending.decision === 'approve' ? (
                <>
                  This records approval for <strong>{pending.item.title}</strong> ({kindLabel(pending.item.kind)}).
                  It does not execute the action — execution still requires the existing policy checks.
                  {pending.item.reviewPath ? (
                    <>
                      {' '}
                      <Link to={pending.item.reviewPath}>Review the full request</Link> before confirming.
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  This records a denial for <strong>{pending.item.title}</strong>. It stays visible in history as
                  rejected.
                </>
              )}
            </>
          ) : null
        }
        confirmLabel={pending?.decision === 'approve' ? 'Record approval' : 'Record denial'}
        destructive={pending?.decision === 'approve'}
        busy={busy}
        error={actionError}
        onConfirm={() => void confirmDecision()}
      />
    </div>
  );
}
