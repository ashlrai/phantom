/**
 * Approval actors come from the authenticated principal.
 *
 * A web token is an agent principal `web-token.<fingerprint>`, never a human
 * and never the raw token. The fingerprint is 32 hex characters of SHA-256
 * (a dot, not a colon, so the team log's secret scanner does not treat it as
 * a `token:` assignment). Human-required decisions need a custody presence
 * assertion over the approval id and decision. The assertion is verified
 * against the custody public key. This module does not sign.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { custodyPublicKey } from '../authority/custody-client.js';
import { canonicalJson } from '../authority/canonical-json.js';
import { enrolledHumanActor } from '../teams/identity.js';
import type { TeamActor } from '../teams/protocol.js';

export const APPROVAL_PRESENCE_DOMAIN = 'phantom.approval.presence.v1\0';
export const WEB_TOKEN_PRINCIPAL_PREFIX = 'web-token.';

/** P-256 IEEE P1363 r||s, standard base64. */
const PRESENCE_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

export class HumanPresenceRequired extends Error {
  readonly code = 'human-presence-required' as const;
  constructor() {
    super('human-presence-required');
    this.name = 'HumanPresenceRequired';
  }
}

export interface WebTokenPrincipal {
  kind: 'agent';
  /** Ledger id. Never the raw token. */
  id: string;
  principal: string;
}

/** The authenticated principal for a web token the server already accepted. */
export function principalFromWebToken(token: string): WebTokenPrincipal {
  const fingerprint = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);
  const id = `${WEB_TOKEN_PRINCIPAL_PREFIX}${fingerprint}`;
  return { kind: 'agent', id, principal: id };
}

export function agentActorForToken(token: string): TeamActor {
  const principal = principalFromWebToken(token);
  return { kind: 'agent', id: principal.id, principal: principal.principal };
}

/** Human id of this device, used only after a presence assertion verifies. */
export function humanActorForPresence(token: string): TeamActor {
  const principal = principalFromWebToken(token);
  const human = enrolledHumanActor();
  return { kind: 'human', id: human.id, principal: principal.principal };
}

export function approvalPresenceBytes(approvalId: string, decision: 'approve' | 'deny'): Buffer {
  return Buffer.from(
    `${APPROVAL_PRESENCE_DOMAIN}${canonicalJson({ v: 1, kind: 'approval.decision', approvalId, decision })}`,
    'utf8',
  );
}

export function invitePresenceBytes(team: string, op: 'create' | 'accept'): Buffer {
  return Buffer.from(
    `${APPROVAL_PRESENCE_DOMAIN}${canonicalJson({ v: 1, kind: 'team.invite', team, op })}`,
    'utf8',
  );
}

let publicKeyOverride: string | null = null;

/** Test seam: PEM of the key that presence assertions must verify against. */
export function _setApprovalPresencePublicKeyForTest(pem: string | null): void {
  publicKeyOverride = pem;
}

function verifyWithKey(message: Buffer, signature: string, pem: string): boolean {
  if (!PRESENCE_SIGNATURE.test(signature)) return false;
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verifySignature('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** True only when `signature` is a custody signature over `message`. */
export async function verifyPresenceSignature(message: Buffer, signature: string): Promise<boolean> {
  if (typeof signature !== 'string' || !PRESENCE_SIGNATURE.test(signature)) return false;
  if (publicKeyOverride !== null) return verifyWithKey(message, signature, publicKeyOverride);
  try {
    const key = await custodyPublicKey();
    return verifyWithKey(message, signature, key.publicKeyPem);
  } catch {
    return false;
  }
}
