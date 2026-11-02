import { useRef, useState } from 'react';
import type { ApprovalRequest, Proposal } from '../../data/api-types.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { DispatchDisabledError } from '../../data/client.js';
import { decideApprovalRequest } from '../../data/mutations.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DiffViewer } from './DiffViewer.js';
import styles from './ApprovalCard.module.css';

interface ApprovalCardProps {
  proposal: Proposal;
  request?: ApprovalRequest | null;
  dispatchEnabled?: boolean;
  onDispatchDisabled: () => void;
  onDecided?: () => void;
}

export function ApprovalCard({ proposal, request, dispatchEnabled = true, onDispatchDisabled, onDecided }: ApprovalCardProps) {
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<'approve' | 'deny' | null>(null);
  const [dispatchBlocked, setDispatchBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const validRequest = request?.schemaVersion === 1 && request.proposalId === proposal.id;

  function start(decision: 'approve' | 'deny') {
    setError(null);
    setPending(decision);
    setConfirmOpen(true);
  }

  async function confirm() {
    if (!pending || !validRequest || !request || inFlight.current) return;
    // Match the console's confirmation-first interaction: an accidental click
    // can be cancelled before the operator is asked for a mutation token.
    if (!hasMutationHold()) {
      setConfirmOpen(false);
      setTokenOpen(true);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await decideApprovalRequest(proposal.id, request.revision, pending);
      setCompleted(pending);
      setConfirmOpen(false);
      setPending(null);
      onDecided?.();
    } catch (err) {
      if (err instanceof DispatchDisabledError) {
        setConfirmOpen(false);
        setDispatchBlocked(true);
        onDispatchDisabled();
      } else setError(err instanceof Error ? err.message : 'Could not save this decision.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const decided = completed ?? proposal.approvalDecision?.decision;
  const dispatchAvailable = dispatchEnabled && !dispatchBlocked;
  const canDecide = proposal.status === 'pending' && !decided && dispatchAvailable && validRequest && !busy;

  return (
    <section className={styles.card} aria-label="Approval request">
      <h3>Approval request</h3>
      {validRequest && request ? <>
        <dl className={styles.facts}>
          <dt>Action</dt><dd>{request.action.description}</dd>
          <dt>Scope</dt><dd>{request.scope.repo ?? 'No repository'}
            {request.scope.sandboxId ? <span> · sandbox {request.scope.sandboxId}</span> : null}
          </dd>
        </dl>
        {request.action.details ? <pre className={styles.details}>{request.action.details}</pre> : null}
        <details>
          <summary>Diff preview</summary>
          <DiffViewer diff={request.diffPreview.text} proposalKind={request.action.kind} />
          {request.diffPreview.truncated ? <p>Preview shortened. Review the full diff above before deciding.</p> : null}
        </details>
      </> : <p role="alert">This server has no reviewable approval request. Refresh before deciding.</p>}
      <p>Approval records consent for this exact request. Execution still requires the existing policy checks.</p>
      {decided || proposal.status !== 'pending' ? (
        <p role="status">{decided ? `Decision recorded: ${decided === 'approve' ? 'approved' : 'denied'}.` : `Proposal is ${proposal.status}.`}</p>
      ) : <div className={styles.actions}>
        {!dispatchAvailable ? <p role="status">Decisions are unavailable while dispatch is disabled.</p> : null}
        <button type="button" disabled={!canDecide} onClick={() => start('deny')}>Deny…</button>
        <button type="button" className={styles.approve} disabled={!canDecide || proposal.isPartial === true} onClick={() => start('approve')}>Approve…</button>
        {proposal.isPartial === true ? <p>Partial captures can be denied, but cannot be approved.</p> : null}
      </div>}
      <MutationTokenDialog open={tokenOpen} reason="Recording an approval decision requires the mutation token."
        onClose={() => {
          setTokenOpen(false);
          if (hasMutationHold()) { setConfirmOpen(true); void confirm(); }
          else setPending(null);
        }} />
      <ConfirmDialog open={confirmOpen} title={pending === 'approve' ? 'Approve this request?' : 'Deny this request?'}
        body={<>{request?.action.description} · <code>{request?.scope.repo ?? 'No repository'}</code><br />
          {pending === 'approve' ? 'This records approval only. It does not execute the action.' : 'This records a denial and keeps the request in inbox history.'}</>}
        confirmLabel={pending === 'approve' ? 'Record approval' : 'Record denial'} destructive={pending === 'approve'}
        busy={busy} error={error} onConfirm={() => void confirm()}
        onClose={() => { if (!inFlight.current) { setConfirmOpen(false); setPending(null); setError(null); } }} />
    </section>
  );
}
