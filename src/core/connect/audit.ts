/**
 * core/connect/audit.ts: value-free audit entries for the connect wizard.
 *
 * Every request, denial, approval refusal, grant and revocation appends one
 * entry to the shared audit trail (~/.ashlr/audit/<date>.jsonl). Summaries
 * carry ids, service, node, method and delivery only; never a secret value,
 * token or session payload (audit() also scrubs defensively).
 */

import { audit } from '../sandbox/audit.js';
import type { ConnectGrant, ConnectRequest } from './types.js';

export type ConnectAuditResult = 'ok' | 'refused' | 'error';

export function auditConnect(
  action: string,
  summary: string,
  result: ConnectAuditResult,
): void {
  audit({ action, repo: null, sandboxId: null, summary, result });
}

export function auditConnectRequest(request: ConnectRequest): void {
  auditConnect(
    'connect.request',
    `request=${request.id} service=${request.service} node=${request.node} scopes=${request.scopes.join(',')} by=${request.requestedBy}`,
    'ok',
  );
}

export function auditConnectDeny(request: ConnectRequest): void {
  auditConnect(
    'connect.deny',
    `request=${request.id} service=${request.service} node=${request.node}`,
    'ok',
  );
}

export function auditConnectGrant(grant: ConnectGrant): void {
  auditConnect(
    'connect.grant',
    `grant=${grant.id} service=${grant.service} node=${grant.node} method=${grant.method} delivery=${grant.delivery}` +
      `${grant.secretName ? ` secretName=${grant.secretName}` : ''} request=${grant.requestId ?? 'none'}`,
    'ok',
  );
}

export function auditConnectRefusal(
  kind: 'approve' | 'grant' | 'revoke' | 'request',
  detail: string,
): void {
  auditConnect(`connect.${kind}`, detail, 'refused');
}

export function auditConnectRevoke(grant: ConnectGrant): void {
  auditConnect(
    'connect.revoke',
    `grant=${grant.id} service=${grant.service} node=${grant.node} method=${grant.method}`,
    'ok',
  );
}
