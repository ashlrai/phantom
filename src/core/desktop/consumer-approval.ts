import {canonicalJson} from '../authority/canonical-json.js';
import {signDesktopUpdateApproval, verifyDesktopUpdateApproval,
  type DesktopUpdateApprovalBinding, type SignedDesktopUpdateApproval} from '../authority/custody-client.js';
import {ledgerSnapshot, type LedgerSnapshot} from '../authority/ledger.js';
import {installStandingGrant, readInstalledGrant, standingGrantEnvelopeDigest, verifyStandingGrant} from '../authority/standing-grant.js';
import type {StandingGrantV1} from '../authority/types.js';
import {currentHostBinding} from '../authority/surface.js';
import {STANDING_GRANT_TRUST_ROOTS} from '../authority/trust-roots.js';
import type {AppProof} from './qualified-update.js';

export interface ConsumerApprovalRequest {
  binding: DesktopUpdateApprovalBinding;
  grant: StandingGrantV1;
  authority: string;
  previous: string;
  app: AppProof;
}

export interface ConsumerApprovalAuthority {
  snapshot(): string;
  draft(surface: string, now: number): Promise<StandingGrantV1>;
  sign(request: ConsumerApprovalRequest): Promise<SignedDesktopUpdateApproval>;
  verify(request: ConsumerApprovalRequest, approval: unknown, now: number): approval is SignedDesktopUpdateApproval;
  accept(request: ConsumerApprovalRequest, approval: SignedDesktopUpdateApproval, now: number): boolean;
}

function authorityIdentity(snapshot: LedgerSnapshot): string {
  const current = readInstalledGrant();
  return canonicalJson({
    chain: snapshot.chain, genesis: snapshot.genesisHash, last: snapshot.index.lastAccepted?.envelopeDigest ?? null,
    accepted: snapshot.index.maxAcceptedGrantSeq, floor: snapshot.index.minGrantSeq,
    installed: current.state === 'ok' ? standingGrantEnvelopeDigest(current.envelope) : current.state,
    revoked: [...snapshot.index.revokedGrantIds].sort(),
  });
}

export const consumerApprovalAuthority: ConsumerApprovalAuthority = {
  snapshot: () => authorityIdentity(ledgerSnapshot('prefix')),
  draft: async (surface, now) => (await import('../verse/authority-api.js')).draftDesktopUpdateGrant(surface, now),
  sign: request => signDesktopUpdateApproval(request.binding, request.grant),
  verify(request, approval, now): approval is SignedDesktopUpdateApproval {
    const snapshot = ledgerSnapshot('prefix');
    const key = STANDING_GRANT_TRUST_ROOTS.find(root => root.keyId === request.grant.keyId);
    if (!key || authorityIdentity(snapshot) !== request.authority ||
        !verifyDesktopUpdateApproval(request.binding, approval, key, now) ||
        canonicalJson(request.grant) !== canonicalJson(approval.grant.payload)) return false;
    const verdict = verifyStandingGrant(approval.grant, {
      nowMs: now, hostBinding: currentHostBinding(), surfaceDigest: request.binding.surfaceDigest,
      minGrantSeq: Math.max(snapshot.index.maxAcceptedGrantSeq + 1, snapshot.index.minGrantSeq),
      revokedGrantIds: snapshot.index.revokedGrantIds,
    }, STANDING_GRANT_TRUST_ROOTS);
    return verdict.ok;
  },
  accept(request, approval, now) {
    return installStandingGrant(approval.grant, {surface:'installed', nowMs:now,
      expectedAuthority: snapshot => authorityIdentity(snapshot) === request.authority}).ok;
  },
};
