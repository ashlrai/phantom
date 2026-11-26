import { createHash } from 'node:crypto';
import type { GitHubOriginAuthority } from '../git.js';
import type { PrView } from '../integrations/github.js';
import type {
  ProposalLocalMergeIntent,
  ProposalRemoteAuthorityBinding,
  ProposalRemoteHandoff,
} from '../types.js';

export const REMOTE_HANDOFF_RECOVERY_MARKER = '[ashlr-remote-handoff-retry:1]' as const;
export type RemoteIntentPhase = 'pre-effect' | 'recovery';

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Preserve a valid GitHub UTC timestamp without synthesizing local time. */
export function sanitizeGithubMergedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return undefined;
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized ? value : undefined;
}

function stablePushUrlIdentity(raw: string): string {
  const value = raw.trim();
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/** Hash effective push destinations without retaining credentials in proposal state. */
function remotePushAuthorityDigest(authority: GitHubOriginAuthority): string {
  const pushUrls = [...new Set(authority.pushUrls.map(stablePushUrlIdentity))].sort();
  if (!authority.nameWithOwner || pushUrls.length === 0) return '';
  return createHash('sha256').update(JSON.stringify([
    'ashlr.github-push-authority.v1',
    authority.nameWithOwner,
    pushUrls,
  ]), 'utf8').digest('hex');
}

export function remoteAuthorityBinding(
  authority: GitHubOriginAuthority,
): ProposalRemoteAuthorityBinding | null {
  const pushAuthorityDigest = remotePushAuthorityDigest(authority);
  return authority.nameWithOwner && HEX64_RE.test(pushAuthorityDigest)
    ? { provider: 'github', nameWithOwner: authority.nameWithOwner, pushAuthorityDigest }
    : null;
}

export function sameRemoteAuthorityBinding(
  left: ProposalRemoteAuthorityBinding | undefined,
  right: ProposalRemoteAuthorityBinding | undefined,
): boolean {
  return Boolean(left && right && left.provider === 'github' && right.provider === 'github' &&
    left.nameWithOwner.length > 0 &&
    left.nameWithOwner === right.nameWithOwner &&
    left.pushAuthorityDigest === right.pushAuthorityDigest &&
    HEX64_RE.test(left.pushAuthorityDigest));
}

/**
 * The HMAC signer authenticates authorizationId. Deriving that id from the
 * remote fields makes the otherwise-local intent signature bind exact host and
 * push authority without changing the provenance signing format.
 */
export function remoteIntentAuthorizationId(
  phase: RemoteIntentPhase,
  intent: Omit<ProposalLocalMergeIntent, 'attestation' | 'authorizationId'>,
): string {
  const authority = intent.remoteAuthority;
  if (!authority || !sameRemoteAuthorityBinding(authority, authority)) return '';
  const recoveryMarker = phase === 'recovery' ? REMOTE_HANDOFF_RECOVERY_MARKER : '';
  return createHash('sha256').update(JSON.stringify([
    intent.evidenceProtocol === 'sealed-v3'
      ? 'ashlr.remote-handoff-authorization.sealed-v3.v1'
      : 'ashlr.remote-handoff-authorization.v1',
    phase,
    authority.provider,
    authority.nameWithOwner,
    authority.pushAuthorityDigest,
    intent.schemaVersion,
    intent.branch,
    intent.base,
    intent.baseBeforeOid,
    intent.proposalHeadOid,
    intent.diffHash,
    intent.evidencePackDigest,
    intent.authorizedAt,
    recoveryMarker,
    ...(intent.evidenceProtocol === 'sealed-v3' ? [intent.evidenceProtocol] : []),
  ]), 'utf8').digest('hex').slice(0, 32);
}

export function hasValidRemoteHandoffRecovery(handoff: ProposalRemoteHandoff): boolean {
  return handoff.recovery?.schemaVersion === 1 && handoff.recovery.attempt === 1 &&
    handoff.recovery.marker === REMOTE_HANDOFF_RECOVERY_MARKER &&
    Number.isFinite(Date.parse(handoff.recovery.authorizedAt));
}

export function prUrlMatchesRepository(url: string | undefined, nameWithOwner: string): boolean {
  if (!url) return false;
  const match = url.match(/^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)$/i);
  return Boolean(match?.[1] && match[2] &&
    `${match[1]}/${match[2]}`.toLowerCase() === nameWithOwner.toLowerCase());
}

export function hasStrongRemoteHandoffIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  return Boolean(
    handoff.prUrl && pr.url && handoff.prUrl === pr.url &&
    handoff.branch && pr.headRefName && handoff.branch === pr.headRefName &&
    handoff.base && pr.baseRefName && handoff.base === pr.baseRefName &&
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() === pr.headRefOid.toLowerCase()
  );
}
