/** Read-only claim-execution evidence under the existing identity prefix:
 * which live claims a worker is actually RUNNING right now (named
 * owner/claim plus actual execution evidence). Never writes; a thrown or
 * stalled reader degrades to an UNKNOWN report with a fixed reason and never
 * leaks the error text. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { sanitizePublicJson } from '../util/public-json.js';
import {
  CLAIM_EXECUTION_SCHEMA,
  readClaimExecution,
  type ClaimExecutionReport,
} from '../fleet/claim-execution-evidence.js';

export const VERSE_FLEET_CLAIM_EXECUTION_PATH = '/api/verse/fleet/runtime-identity/claim-execution';

// A stalled read must still produce a bounded UNKNOWN answer — the evidence
// reader runs `ps` for the live worker table. The race does not cancel the
// underlying read, it only stops waiting for it.
export const FLEET_CLAIM_EXECUTION_READ_DEADLINE_MS = 5_000;
const READER_FAILED_REASON = 'claim execution: reader failed';
const READ_DEADLINE_REASON = 'claim execution: read deadline exceeded';

export interface FleetClaimExecutionResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: ClaimExecutionReport;
}

export interface FleetClaimExecutionApiDeps {
  /** Reader seam for tests. Default: readClaimExecution(). */
  read?: () => Promise<ClaimExecutionReport>;
  /** Clock seam for tests; stamps generatedAt and a degraded report's asOf. */
  now?: () => Date;
  /** Read deadline seam for tests. Default: FLEET_CLAIM_EXECUTION_READ_DEADLINE_MS. */
  deadlineMs?: number;
}

/** Every field empty/'unavailable' plus a fixed reason; never carries the thrown message. */
function unknownReport(reason: string, asOf: string): ClaimExecutionReport {
  return {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf,
    ledger: 'unavailable', processes: 'unavailable', rows: [],
    counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
    reasons: [reason],
  };
}

type ClaimExecutionReadOutcome =
  | { kind: 'report'; report: ClaimExecutionReport }
  | { kind: 'rejected' }
  | { kind: 'timeout' };

export function createFleetClaimExecutionApi(deps: FleetClaimExecutionApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const read = deps.read ?? (() => readClaimExecution());
  const deadlineMs = deps.deadlineMs ?? FLEET_CLAIM_EXECUTION_READ_DEADLINE_MS;
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_CLAIM_EXECUTION_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    // The router already stripped the query from `path`; read it from req.url.
    // Any query key is rejected before any host read.
    const params = new URL(req.url ?? '', 'http://local').searchParams;
    if ([...params.keys()].length > 0) {
      sendJson(res, 400, { v: 1, authority: 'none', error: 'no query accepted' });
      return true;
    }
    const generatedAt = now().toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: ClaimExecutionReadOutcome;
    try {
      outcome = await Promise.race<ClaimExecutionReadOutcome>([
        // Handlers stay attached after a timeout wins, so a late rejection is
        // consumed and can never write a second response or leak unhandled.
        Promise.resolve().then(() => read()).then(
          report => ({ kind: 'report' as const, report }),
          (): ClaimExecutionReadOutcome => ({ kind: 'rejected' as const }),
        ),
        new Promise<ClaimExecutionReadOutcome>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'timeout' as const }), deadlineMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const report = outcome.kind === 'report'
      ? outcome.report
      : unknownReport(outcome.kind === 'timeout' ? READ_DEADLINE_REASON : READER_FAILED_REASON, generatedAt);
    const response: FleetClaimExecutionResponse = { v: 1, authority: 'none', generatedAt, report };
    sendJson(res, 200, sanitizePublicJson(response));
    return true;
  };
}

export const handleFleetClaimExecutionApi: ApiModule = createFleetClaimExecutionApi();
