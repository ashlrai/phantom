/** Desktop read of the last saved Gmail triage result (counts only). Read-only:
 * it never touches mail. Answers only the local dispatch session. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { GMAIL_TRIAGE_LATEST_SCHEMA, readGmailTriageLatest } from '../comms/gmail-triage-latest.js';
import { GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, readGmailArchivePlanLatest } from '../comms/gmail-archive-plan-latest.js';

export const VERSE_GMAIL_TRIAGE_PATH = '/api/verse/comms/gmail-triage';
/** Under the triage prefix so the registered route family already covers it. */
export const VERSE_GMAIL_ARCHIVE_PLAN_PATH = '/api/verse/comms/gmail-triage/archive-plan';

/** Saved exports support sample triage and planning only; they do not observe
 * the live inbox or verify that an archive operation was executed. */
function evidence(latest: unknown) {
  return {
    scope: latest === null ? 'unknown' : 'saved-local-export-sample',
    liveInboxTargetState: 'unknown',
    archiveExecution: 'unverified',
  };
}

export interface GmailTriageApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
}

export function createGmailTriageApi(deps: GmailTriageApiDeps = {}): ApiModule {
  return async (ctx, _req, res, path, method) => {
    if (path !== VERSE_GMAIL_TRIAGE_PATH && path !== VERSE_GMAIL_ARCHIVE_PLAN_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The Gmail triage result is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const runsDir = deps.runsDir ?? fixedOwnerRunsDir();
    if (path === VERSE_GMAIL_ARCHIVE_PLAN_PATH) {
      const latest = readGmailArchivePlanLatest(runsDir);
      sendJson(res, 200, { schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, latest, evidence: evidence(latest) });
      return true;
    }
    const latest = readGmailTriageLatest(runsDir);
    sendJson(res, 200, { schema: GMAIL_TRIAGE_LATEST_SCHEMA, latest, evidence: evidence(latest) });
    return true;
  };
}

export const handleGmailTriageApi: ApiModule = createGmailTriageApi();
