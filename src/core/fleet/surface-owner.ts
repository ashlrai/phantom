/**
 * Surface ownership evidence: joins live advisory coordination claims with
 * the landed path history so "who owns the Slack bridge right now?" returns
 * evidence instead of routing prose. Read-only; a claim is advisory
 * coordination, never execution authority, and landed history never promotes
 * itself to owner.
 */
import { readFleetBoard, type FleetBoard, type FleetCoordinationOptions } from './coordination.js';
import { pathJobHistory } from './path-job-history.js';
import { isHubRepositoryLabel } from '../authority/repository-binding.js';
import { scrubSecrets } from '../util/scrub.js';

const UNKNOWN = 'UNKNOWN';

/**
 * Named slices of the tree an owner question can be asked about. Every entry
 * is a repo-relative literal path that must exist on the default branch —
 * test/fleet-surface-owner-379.test.ts fails if one rots. At most 13 each (slack-bridge owns 13: audience authority and reply identity are both owner-sensitive).
 */
export const SURFACES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'slack-bridge': Object.freeze([
    'src/core/agents/slack-audience.ts',
    'src/core/agents/slack-inbound.ts',
    'src/core/agents/slack-journal.ts',
    'src/core/agents/slack-leader.ts',
    'src/core/agents/slack-network.ts',
    'src/core/agents/slack-reply-binding.ts',
    'src/core/agents/slack-reply-identity.ts',
    'src/core/agents/slack-request-trace.ts',
    'src/core/agents/slack-send-receipts.ts',
    'src/core/agents/slack-status.ts',
    'src/core/agents/slack-transport.ts',
    'src/core/comms/slack-bus-ingress.ts',
    'src/cli/channels-slack.ts',
  ]),
  'imessage-bridge': Object.freeze([
    'src/core/comms/imessage-ack-evidence.ts',
    'src/core/comms/imessage-findings-bridge.ts',
    'src/core/comms/imessage-inbox-bridge.ts',
    'src/core/comms/imessage-leader-replies.ts',
    'src/core/comms/imessage-outbox.ts',
    'src/core/comms/imessage-patch-transfer.ts',
    'src/core/comms/imessage-path-check.ts',
    'src/core/comms/imessage-teammate-inbox.ts',
    'src/core/comms/imessage-teammate-transport.ts',
    'src/core/comms/imessage-teammate-worker.ts',
    'src/cli/imessage.ts',
    'src/core/integrations/imessage.ts',
  ]),
  'dot-handoff': Object.freeze([
    'src/cli/fleet-dot-handoff.ts',
    'docs/DOT-HANDOFF.md',
    'docs/DOTS-COMPANION.md',
  ]),
  'coordination': Object.freeze([
    'src/core/fleet/coordination.ts',
    'src/core/fleet/coordination-return.ts',
    'src/core/fleet/coordination-returns-view.ts',
    'src/core/fleet/coordination-claims-view.ts',
    'src/core/fleet/review-take.ts',
    'src/cli/fleet-coordination.ts',
    'src/core/fleet/claim-lease-reap.ts',
    'src/core/fleet/local-store-lock.ts',
  ]),
});

export interface SurfaceOwnerReport {
  schemaVersion: 1;
  authority: 'none';
  surface: string;
  asOf: string;
  owner: string;
  ownerSource: 'advisory-claim' | 'none';
  liveClaims: Array<{ id: string; agent: string; expiresInSeconds: number }>;
  lastLanded: { jobId: string; pr: number | null; date: string; path: string } | null;
  scannedPaths: string[];
  reasons: string[];
}

export interface SurfaceOwnerDeps {
  /** Newest-first commits touching a repo-relative path; same shape pathJobHistory takes. */
  log?: Parameters<typeof pathJobHistory>[1]['log'];
  board?: (options?: FleetCoordinationOptions) => FleetBoard;
  now?: () => number;
}

/** Identity labels are single safe tokens: never echo emails, paths or arbitrary text. */
const label = (value: string | null): string =>
  value !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && scrubSecrets(value) === value ? value : UNKNOWN;

/**
 * One bounded snapshot for a named surface. A claim names a surface when its
 * task contains the surface id or one of its paths as an exact substring.
 * The catalog describes this repository's tree, so only claims on the Hub
 * repository identity (ashlrai/phantom or its pre-rename label, matched
 * case-insensitively like the rest of coordination) can name an owner;
 * live claims on other repositories are ignored, never ambiguous. Claim task
 * text and ledger paths never leave this function.
 */
export async function readSurfaceOwner(surface: string, deps: SurfaceOwnerDeps = {}): Promise<SurfaceOwnerReport | null> {
  if (!Object.hasOwn(SURFACES, surface)) return null;
  const paths = SURFACES[surface]!;
  const now = (deps.now ?? Date.now)();
  const reasons: string[] = [];
  const liveClaims: SurfaceOwnerReport['liveClaims'] = [];
  let owner = UNKNOWN;
  let ownerSource: SurfaceOwnerReport['ownerSource'] = 'none';
  let board: FleetBoard;
  try {
    board = (deps.board ?? readFleetBoard)({ now, reap: false });
  } catch {
    board = { schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null };
  }
  if (board.state !== 'known') {
    reasons.push('coordination ledger: missing or unreadable');
  } else {
    const namesSurface = (claim: FleetBoard['claims'][number]): boolean =>
      typeof claim.task === 'string'
        && (claim.task.includes(surface) || paths.some(path => claim.task.includes(path)));
    const matches = board.claims.filter(claim => claim.expiresAt > now
      && typeof claim.repo === 'string' && isHubRepositoryLabel(claim.repo) && namesSurface(claim));
    const foreign = board.claims.filter(claim => claim.expiresAt > now
      && !(typeof claim.repo === 'string' && isHubRepositoryLabel(claim.repo)) && namesSurface(claim)).length;
    for (const claim of matches) {
      liveClaims.push({ id: label(claim.id), agent: label(claim.agent),
        expiresInSeconds: Math.floor((claim.expiresAt - now) / 1000) });
    }
    if (matches.length === 1) {
      owner = liveClaims[0]!.agent;
      ownerSource = 'advisory-claim';
    } else if (matches.length === 0) {
      reasons.push('no live claim names this surface; lastLanded is history, not ownership');
      if (foreign > 0) reasons.push(`${foreign} live claim(s) naming this surface belong to other repositories and were ignored`);
    } else {
      reasons.push(`${matches.length} live claims name this surface`);
    }
  }
  let lastLanded: SurfaceOwnerReport['lastLanded'] = null;
  const scannedPaths: string[] = [];
  if (!deps.log) {
    reasons.push('landed history: no git log reader');
  } else {
    const log = deps.log;
    await Promise.all(paths.map(async path => {
      scannedPaths.push(path);
      try {
        const row = (await pathJobHistory(path, { log }, { limit: 1 }))[0];
        if (row && Number.isFinite(Date.parse(row.date))
          && (!lastLanded || Date.parse(row.date) > Date.parse(lastLanded.date))) {
          lastLanded = { jobId: row.jobId, pr: row.pr, date: row.date, path };
        }
      } catch {
        reasons.push(`path history unreadable: ${path}`);
      }
    }));
  }
  return {
    schemaVersion: 1, authority: 'none', surface, asOf: new Date(now).toISOString(),
    owner, ownerSource, liveClaims, lastLanded, scannedPaths, reasons,
  };
}
