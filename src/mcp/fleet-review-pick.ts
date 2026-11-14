/** Read-only MCP boundary for one unowned review task. No caller-owned paths. */
import { readReviewPick, REVIEW_PICK_SCHEMA, type ReviewPickReadOptions } from '../core/fleet/review-pick.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetReviewPickArgs {
  repo?: unknown;
  limit?: unknown;
}

export type FleetReviewPickDeps = Pick<ReviewPickReadOptions,
  'gh' | 'readClaimedTsv' | 'inspectBusWork' | 'readBoard' | 'listWorkers' | 'now'> & {
  /** Trusted test seam only; never accepted from tool arguments. */
  timeoutMs?: number;
};

export function parseFleetReviewPickArgs(args: Record<string, unknown>): FleetReviewPickArgs | null {
  return Object.keys(args).every(key => key === 'repo' || key === 'limit')
    ? { repo: args['repo'], limit: args['limit'] } : null;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const FLEET_REVIEW_PICK_TIMEOUT_MS = 20_000;

export async function readFleetReviewPick(args: FleetReviewPickArgs = {}, deps: FleetReviewPickDeps = {}): Promise<unknown> {
  if (args.repo !== undefined && (typeof args.repo !== 'string' || !REPO.test(args.repo))) {
    return sanitizePublicJson({ status: 'invalid', reason: 'repo must match owner/name.' });
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    return sanitizePublicJson({ status: 'invalid', reason: 'limit must be an integer from 1 to 100.' });
  }
  const repo = (args.repo as string | undefined) ?? 'ashlrai/phantom';
  const unavailable = (reason: string) => ({
    schema: REVIEW_PICK_SCHEMA, repo, picked: null, reason,
    source: {
      prs: 'unavailable',
      claims: { 'claimed-tsv': 'unavailable', 'bus-work-claims': 'unavailable', coordination: 'unavailable', 'live-workers': 'unavailable' },
      unavailable: ['claimed-tsv', 'bus-work-claims', 'coordination', 'live-workers'],
    },
    skipped: [], unowned_candidates: 0,
  });
  const timeoutMs = typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? deps.timeoutMs : FLEET_REVIEW_PICK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return sanitizePublicJson(await Promise.race([
      // Explicit seams prevent even trusted dependency objects forwarding runsDir.
      Promise.resolve().then(() => readReviewPick({
        repo, limit: args.limit as number | undefined,
        gh: deps.gh, readClaimedTsv: deps.readClaimedTsv, inspectBusWork: deps.inspectBusWork,
        readBoard: deps.readBoard, listWorkers: deps.listWorkers, now: deps.now,
      })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(unavailable('review-pick read timed out')), timeoutMs);
      }),
    ]));
  } catch {
    return sanitizePublicJson(unavailable('review-pick read unavailable'));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
