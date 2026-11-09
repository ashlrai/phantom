/** Desktop read of the last saved Gmail triage result (counts only). Read-only:
 * it never touches mail. Answers only the local dispatch session. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { GMAIL_TRIAGE_LATEST_SCHEMA, readGmailTriageLatest } from '../comms/gmail-triage-latest.js';

export const VERSE_GMAIL_TRIAGE_PATH = '/api/verse/comms/gmail-triage';

export interface GmailTriageApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
}

export function createGmailTriageApi(deps: GmailTriageApiDeps = {}): ApiModule {
  return async (ctx, _req, res, path, method) => {
    if (path !== VERSE_GMAIL_TRIAGE_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The Gmail triage result is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    sendJson(res, 200, { schema: GMAIL_TRIAGE_LATEST_SCHEMA, latest: readGmailTriageLatest(deps.runsDir ?? fixedOwnerRunsDir()) });
    return true;
  };
}

export const handleGmailTriageApi: ApiModule = createGmailTriageApi();
