/** Read-only desktop review pick. Requests select only a repository; all
 * evidence locations remain server-owned. Failed or late reads prove no pick. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readReviewPick, REVIEW_PICK_SCHEMA, type ReviewPickReport } from '../fleet/review-pick.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const VERSE_FLEET_REVIEW_PICK_PATH = '/api/verse/fleet/work-board/review-pick';
const TIMEOUT_MS = 20_000;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export interface FleetReviewPickApiDeps {
  read?: typeof readReviewPick;
  /** May shorten the deadline for tests, but cannot exceed 20 seconds. */
  timeoutMs?: number;
}

function unavailable(repo: string): ReviewPickReport {
  return {
    schema: REVIEW_PICK_SCHEMA, as_of: new Date().toISOString(), repo,
    picked: null, reason: 'review-pick read unavailable', skipped: [], unowned_candidates: 0,
    source: {
      prs: 'unavailable',
      claims: { 'claimed-tsv': 'unavailable', 'bus-work-claims': 'unavailable',
        coordination: 'unavailable', 'live-workers': 'unavailable' },
      unavailable: ['claimed-tsv', 'bus-work-claims', 'coordination', 'live-workers'],
    },
  };
}

export function createFleetReviewPickApi(deps: FleetReviewPickApiDeps = {}): ApiModule {
  const read = deps.read ?? readReviewPick;
  const timeoutMs = typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(deps.timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_REVIEW_PICK_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, sanitizePublicJson({ error: 'method not allowed' }));
      return true;
    }
    let repo: string;
    try {
      repo = new URL(req.url ?? path, 'http://localhost').searchParams.get('repo') ?? 'ashlrai/phantom';
    } catch {
      repo = '';
    }
    if (!REPO.test(repo)) {
      sendJson(res, 400, sanitizePublicJson({ error: 'invalid repo' }));
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let report: ReviewPickReport;
    try {
      report = await Promise.race([
        Promise.resolve().then(() => read({ repo })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch {
      report = unavailable(repo);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    sendJson(res, 200, sanitizePublicJson(report));
    return true;
  };
}

export const handleFleetReviewPickApi: ApiModule = createFleetReviewPickApi();
