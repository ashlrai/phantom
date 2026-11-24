/**
 * Deploy gate. The standing-grant surface check is unchanged.
 *
 * A candidate whose authority-surface digest equals the active grant installs
 * with no pause. A different digest waits for the authority window, which
 * carries one re-approve, and every deferral is a ledger note. This never
 * clears Stop and never touches the KILL sentinel.
 */
import { appendLedger } from './ledger.js';

export type DeployDecision =
  | { action: 'install'; reapprove: false }
  | { action: 'install'; reapprove: true }
  | { action: 'queue'; code: 'authority-bump' };

export function decideDeploy(input: {
  candidateDigest: string;
  grantDigest: string;
  windowOpen: boolean;
}): DeployDecision {
  if (input.candidateDigest === input.grantDigest) return { action: 'install', reapprove: false };
  if (input.windowOpen) return { action: 'install', reapprove: true };
  return { action: 'queue', code: 'authority-bump' };
}

/** Record one deferral. The note does not pause the grant and does not clear Stop. */
export function recordDeployDeferral(input: {
  grantId: string | null;
  candidateDigest: string;
  grantDigest: string;
}): { ok: boolean; reason?: string } {
  const recorded = appendLedger({
    kind: 'note',
    actor: 'daemon',
    grantId: input.grantId,
    repo: null,
    data: {
      topic: 'authority-deploy-deferred',
      detail: `candidate ${input.candidateDigest} deferred until the authority window; grant ${input.grantDigest}`,
    },
  });
  return recorded.ok ? { ok: true } : { ok: false, reason: recorded.reason };
}
