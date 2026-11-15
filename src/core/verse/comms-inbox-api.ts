/** Desktop and agent read of the unified comms inbox (Needs-you lines, unanswered
 * teammate texts, pending email drafts, unclaimed bus work) as one ranked list.
 * Read-only: `readUnifiedInbox` never writes, sends, claims or resolves. Items
 * quote private text, so it answers only the local dispatch session. */
import type { ApiModule } from './api-modules.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { approveDraft, getDraft, listDrafts, rejectDraft, type Draft } from '../cos/drafts.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { markLinkedInAnswered } from '../comms/linkedin-drop.js';
import { readUnifiedInbox, type UnifiedInbox, type UnifiedInboxOptions } from '../comms/unified-inbox.js';

export const VERSE_COMMS_INBOX_PATH = '/api/verse/comms/inbox';
const SCHEMA = 'comms.unified-inbox.v1';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EMAIL_DRAFTS_PATH = `${VERSE_COMMS_INBOX_PATH}/email-drafts`;
const EMAIL_DRAFTS_APPROVE = `${EMAIL_DRAFTS_PATH}/approve`;
const EMAIL_DRAFTS_REJECT = `${EMAIL_DRAFTS_PATH}/reject`;
const LINKEDIN_ANSWERED_PATH = `${VERSE_COMMS_INBOX_PATH}/linkedin/answered`;
const EMAIL_DRAFTS_MAX = 50;
const EMAIL_BODY_MAX = 8000;
const DRAFT_ID_RE = /^d-[0-9a-f]{16}$/;
/** Full digest only, never a prefix. Optional `sha256:` label: sendJson scrubs a bare 64-hex string as secret-shaped. */
const FULL_DIGEST_RE = /^(?:sha256:)?[0-9a-f]{64}$/;
const DIGEST_LABEL = 'sha256:';

export interface CommsInboxApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Default: the unified inbox's own bus root. */
  busRoot?: string;
  /** Clock seam for tests. */
  now?: () => number;
  /** Reader seam for tests. */
  read?: (options: UnifiedInboxOptions) => Promise<UnifiedInbox>;
  /** Email draft store seams for tests; defaults are the real `cos/drafts` store. */
  listDrafts?: typeof listDrafts;
  getDraft?: typeof getDraft;
  approve?: typeof approveDraft;
  reject?: typeof rejectDraft;
  /** LinkedIn answered-marker seam for tests; default writes the marker file. */
  markLinkedIn?: typeof markLinkedInAnswered;
}

/** 1..200, or null for anything that is not a plain integer in range. */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

function emailDraftRow(draft: Draft) {
  const truncated = draft.body.length > EMAIL_BODY_MAX;
  return {
    id: draft.id, to: draft.to, subject: draft.subject,
    body: truncated ? draft.body.slice(0, EMAIL_BODY_MAX) : draft.body,
    ...(truncated ? { truncated: true } : {}),
    digest: `${DIGEST_LABEL}${draft.digest}`, createdAt: draft.createdAt,
  };
}

/** Outcome bodies carry `code` too: the desktop client reads refusal codes from it. */
const outcome = (status: string) => ({ v: 1, status, code: status });

export function createCommsInboxApi(deps: CommsInboxApiDeps = {}): ApiModule {
  const runsDirOf = () => deps.runsDir ?? fixedOwnerRunsDir();

  /** Email drafts the owner reads and decides in the desktop app. Approval only records the decision; it never sends. */
  const handleEmailDrafts: ApiModule = async (ctx, req, res, path, method) => {
    const isList = path === EMAIL_DRAFTS_PATH;
    if (!isList && path !== EMAIL_DRAFTS_APPROVE && path !== EMAIL_DRAFTS_REJECT) return false;
    if (method !== (isList ? 'GET' : 'POST')) {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (method === 'POST' && !passesMutationGate(req, res, ctx.token)) return true;
    try {
      if (isList) {
        const pending = await (deps.listDrafts ?? listDrafts)({ runsDir: runsDirOf(), status: 'pending' });
        const drafts = pending
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, EMAIL_DRAFTS_MAX).map(emailDraftRow);
        sendJson(res, 200, { v: 1, drafts });
        return true;
      }
      const approving = path === EMAIL_DRAFTS_APPROVE;
      let input: unknown;
      try { input = JSON.parse(await readBody(req)); }
      catch (error) {
        if (error instanceof SyntaxError) { sendJson(res, 400, outcome('invalid')); return true; }
        sendJson(res, 413, { error: 'Request body too large.' });
        return true;
      }
      const allowed = approving ? ['id', 'digest'] : ['id'];
      if (typeof input !== 'object' || input === null || Array.isArray(input)
        || Object.keys(input).some(key => !allowed.includes(key))) {
        sendJson(res, 400, outcome('invalid'));
        return true;
      }
      const { id, digest } = input as { id?: unknown; digest?: unknown };
      if (typeof id !== 'string' || !DRAFT_ID_RE.test(id) || (approving && (typeof digest !== 'string' || !FULL_DIGEST_RE.test(digest)))) {
        sendJson(res, 400, outcome('invalid'));
        return true;
      }
      const runsDir = runsDirOf();
      const draft = await (deps.getDraft ?? getDraft)(id, runsDir);
      if (!draft) { sendJson(res, 404, outcome('unknown')); return true; }
      if (draft.status !== 'pending') { sendJson(res, 409, outcome('already-decided')); return true; }
      if (approving) {
        if ((digest as string).replace(DIGEST_LABEL, '') !== draft.digest) { sendJson(res, 409, outcome('stale')); return true; }
        await (deps.approve ?? approveDraft)(id, { runsDir, digest: draft.digest });
      } else {
        await (deps.reject ?? rejectDraft)(id, { runsDir });
      }
      sendJson(res, 200, { v: 1, status: approving ? 'approved' : 'rejected', id });
    } catch {
      sendJson(res, 503, outcome('unavailable'));
    }
    return true;
  };

  /** Owner marks a LinkedIn message answered. Writes one marker file under the fixed runs dir; sends nothing. */
  const handleLinkedInAnswered: ApiModule = async (ctx, req, res, path, method) => {
    if (path !== LINKEDIN_ANSWERED_PATH) return false;
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    let input: unknown;
    try { input = JSON.parse(await readBody(req)); }
    catch (error) {
      if (error instanceof SyntaxError) { sendJson(res, 400, outcome('invalid')); return true; }
      sendJson(res, 413, { error: 'Request body too large.' });
      return true;
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'id')) {
      sendJson(res, 400, outcome('invalid'));
      return true;
    }
    const id = (input as { id?: unknown }).id;
    try {
      const result = typeof id === 'string' ? (deps.markLinkedIn ?? markLinkedInAnswered)(runsDirOf(), id) : 'invalid';
      if (result === 'invalid') sendJson(res, 400, outcome('invalid'));
      else sendJson(res, 200, { v: 1, outcome: result });
    } catch {
      sendJson(res, 503, outcome('unavailable'));
    }
    return true;
  };

  return async (ctx, req, res, path, method) => {
    if (await handleEmailDrafts(ctx, req, res, path, method)) return true;
    if (await handleLinkedInAnswered(ctx, req, res, path, method)) return true;
    if (path !== VERSE_COMMS_INBOX_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The comms inbox is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    let limit: number | null;
    try {
      limit = parseLimit(new URL(req.url ?? path, 'http://localhost').searchParams.get('limit'));
    } catch {
      limit = null;
    }
    if (limit === null) {
      sendJson(res, 400, { error: `limit must be an integer from 1 to ${MAX_LIMIT}.` });
      return true;
    }
    try {
      const inbox = await (deps.read ?? readUnifiedInbox)({
        runsDir: runsDirOf(),
        ...(deps.busRoot ? { busRoot: deps.busRoot } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      const items = inbox.items.slice(0, limit);
      sendJson(res, 200, {
        schema: SCHEMA,
        generatedAt: inbox.generatedAt,
        sources: inbox.sources,
        total: inbox.total,
        omitted: Math.max(0, inbox.total - items.length),
        items,
      });
    } catch {
      sendJson(res, 200, { schema: SCHEMA, unavailable: true, items: [] });
    }
    return true;
  };
}

export const handleCommsInboxApi: ApiModule = createCommsInboxApi();
