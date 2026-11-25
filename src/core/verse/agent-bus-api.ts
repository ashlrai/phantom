/**
 * Durable local bus, shared with `phm comms bus`:
 * GET /api/verse/agent-bus[?after=0&limit=50] reads a cursor page (limit 1..100).
 * POST /api/verse/agent-bus appends exactly one BusEnvelope, with the normal
 * dispatch/token gate. GET /api/verse/agent-bus/status inspects retained capacity.
 * GET /api/verse/agent-bus/work-feed is the v2 work projection (`phm fleet
 * work-feed --json`): ok and refused answers return 200 with the projection's
 * own status; unreadable or invalid storage returns 503. It accepts `claims=true`
 * plus the same filter parameters the feed CLIs take — `status`, `job`, `repo`,
 * `provider`, `tier`, `to`, `owner`, `since`, `before`, `contains`, `channel`,
 * `open` and `claimable`,
 * each validated by the shared `parseBusWorkFeedQuery` rules and applied through
 * the same `projectBusWorkFeedView` the CLIs use (`open`/`claimable` imply the
 * claims join); `limit` pages the filtered view through the shared
 * `sliceBusWorkFeedView` (1..200, reporting `matched`/`omitted`), and any other
 * parameter or value is a 400.
 * GET /api/verse/agent-bus/messages[?since=15m&before=2h&agent=claude&with=leader&kind=ask&priority=P0&job=RQ-1&thread=t-1&channel=eng&contains=parser&from=claude&excludeFrom=grok&inReplyTo=m-1&id=m-2&bodyKind=work.post&limit=50] is the same
 * read as `phm messages` (agent-messages.ts): newest first, scrubbed summaries.
 * `before` keeps only messages received strictly before its cutoff on the same
 * grammar `since` takes — the exclusive upper bound composing with `since`
 * into one [since, before) window on the receipt time, the same rule every
 * other bus read's `--before` applies.
 * `contains` is a case-insensitive substring over each scrubbed summary;
 * `channel` keeps only posts addressed to `group:<channel>:*` — the room's
 * whole traffic under every topic;
 * `from` keeps only the messages one sender wrote and `excludeFrom` drops
 * them, by the same sender rules the other bus reads apply; `inReplyTo` keeps only
 * envelopes whose object body cites that envelope id through its own
 * `inReplyTo` field — the same own-property exact match the raw bus reads
 * apply; `id` keeps only the envelope whose own wire id is strictly equal
 * to the value — the same exact-envelope match those raw reads' `id`
 * filter applies; `bodyKind` keeps only bodies whose own kind
 * discriminator strictly equals the value — the same `busBodyKind`
 * own-field exact match the raw bus reads' body-kind filter applies.
 * GETs require a current read session. Responses wrap store outcomes with v: 1;
 * missing storage reads as an empty page, while status reports source: missing.
 * Unavailable storage returns 503. Expired rows advance nextCursor but are omitted.
 * Address labels are routing data, not authenticated sender or recipient identities.
 * sendJson sanitizes returned data, so HTTP output is not necessarily byte-identical
 * to the stored envelope. No caller may choose the storage root or clock.
 * GET .../needs-mason/asks/batch is `phm asks list --json` (asks.batch.v1, the phone card);
 * GET .../needs-mason/asks is `phm asks --json` (asks.v1); POST .../needs-mason/asks/answer
 * takes {id, answer: yes|no|done} and records it once with source desktop (asks.answer.v1).
 * GET .../needs-mason/approvals is the `phm approvals` asks list (approvals.asks.v1); POST
 * .../needs-mason/approvals/answer takes {id, option, from?: desktop|phone} (approvals.answer.v1).
 * Passing the mutation gate is the verified-Mason check here, exactly as for asks.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFleetEdges } from '../fleet/fleet-edges.js';
import { parseBusEnvelope } from '../fleet/bus-envelope.js';
import { appendBusInbox, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter } from '../fleet/bus-inbox.js';
import { projectBusWorkFeedView, readBusWorkFeed, sliceBusWorkFeedView } from '../agents/bus-work-feed-read.js';
import { parseBusWorkFeedQuery, type BusWorkFeedQueryInput } from '../agents/bus-work-feed-query.js';
import { parseAgentMessagesQuery, readAgentMessages } from '../fleet/agent-messages.js';
import { getBusMirrorState, startBusMirrorLoop } from '../fleet/bus-mirror-dispatch.js';
import { mirrorLeaderPostToInbox } from '../fleet/bus-leader-inbox.js';
import { CHANNEL_ACK_TIMEOUT_MS } from '../fleet/channel-envelope.js';
import { listNeedsMason, type NeedsMasonResolveResult } from '../fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../fleet/needs-mason-relay.js';
import { answerAsk, listAsks, type AskAnswerResult } from '../fleet/asks.js';
import { listAskBatch, type AskBatch } from '../fleet/asks-batch.js';
import { answerApproval, listApprovals, type ApprovalAnswerResult } from '../fleet/approvals.js';
import { executeBusClaimBody, BUS_CLAIM_HTTP_STATUS, type BusClaimResult } from '../agents/bus-claims.js';
import { OPERATOR_SENDER_ID } from '../fleet/channel-envelope.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

const PATH = '/api/verse/agent-bus';
const NEEDS_MASON = `${PATH}/needs-mason`;
const MESSAGES = `${PATH}/messages`;
const WORK_FEED = `${PATH}/work-feed`;
/** The query keys the work-feed read accepts — the `claims` hold join, the
 * filter set `parseBusWorkFeedQuery` validates into `projectBusWorkFeedView`,
 * and the `limit` page bound `sliceBusWorkFeedView` applies after it. */
const WORK_FEED_PARAMS = ['claims', 'status', 'job', 'repo', 'provider', 'tier', 'to', 'owner', 'since', 'before', 'contains', 'channel', 'result', 'open', 'claimable', 'limit'] as const;
const NEEDS_MASON_RESOLVE = `${NEEDS_MASON}/resolve`;
const ASKS = `${NEEDS_MASON}/asks`;
const ASKS_ANSWER = `${ASKS}/answer`;
const ASKS_BATCH = `${ASKS}/batch`;
const APPROVALS = `${NEEDS_MASON}/approvals`;
const APPROVALS_ANSWER = `${APPROVALS}/answer`;
type NeedsMasonApiResult = NeedsMasonResolveResult & { inbox?: 'appended' | 'skipped' | 'failed' };
export interface AgentBusApiDeps {
  append?: typeof appendBusInbox;
  list?: typeof listBusInboxAfter;
  inspect?: typeof inspectBusInbox;
  messages?: typeof readAgentMessages;
  workFeed?: typeof readBusWorkFeed;
  mirrorToInbox?: typeof mirrorLeaderPostToInbox;
  startMirror?: () => void;
  needsMason?: {
    list: typeof listNeedsMason;
    resolve: (input: unknown) => NeedsMasonApiResult | Promise<NeedsMasonApiResult>;
  };
  asks?: { batch?: () => AskBatch; list: typeof listAsks; answer: (id: unknown, answer: unknown) => Promise<AskAnswerResult> };
  approvals?: { list: typeof listApprovals; answer: typeof answerApproval };
  claims?: typeof executeBusClaimBody;
}
const APPROVAL_STATUS_HTTP: Record<ApprovalAnswerResult['status'], number> = {
  answered: 200, 'already-answered': 200, unverified: 403, expired: 410, unknown: 404, ambiguous: 409, invalid: 400, unavailable: 503,
};
const ASK_STATUS_HTTP: Record<AskAnswerResult['status'], number> = {
  answered: 200, 'already-answered': 200, refused: 403, unknown: 404, ambiguous: 409, invalid: 400, unavailable: 503,
};

/**
 * Claim results carry the caller's own 64-hex fencing token, which the public
 * scrub inside sendJson would redact; every field is schema-bounded (labels,
 * numbers, the token) so the gated caller receives the contract response intact.
 */
function sendClaimJson(res: ServerResponse, status: number, body: BusClaimResult): void {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  } catch {
    // Socket already closed — same swallow as sendJson.
  }
}

/** Dependencies permit isolated store tests; the public handler uses the default store. */
export function createAgentBusApi(deps: AgentBusApiDeps = {}): ApiModule {
  let mirrorStarted = false;
  return async (ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
    if (path !== PATH && path !== `${PATH}/status` && path !== `${PATH}/edges` && path !== MESSAGES && path !== WORK_FEED && path !== NEEDS_MASON && path !== NEEDS_MASON_RESOLVE && path !== ASKS && path !== ASKS_BATCH && path !== ASKS_ANSWER && path !== APPROVALS && path !== APPROVALS_ANSWER) return false;
    if (method !== (path === NEEDS_MASON_RESOLVE || path === ASKS_ANSWER || path === APPROVALS_ANSWER ? 'POST' : 'GET') && !(method === 'POST' && path === PATH)) {
      sendJson(res, 404, { error: 'not found' }); return true;
    }
    if (method === 'GET' && (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now())) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    if (method === 'POST') {
      // Same gate as the interject POST: dispatch enabled + mutation token/origin checks.
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
    }
    let params: URLSearchParams;
    try { params = new URL(req.url ?? path, 'http://localhost').searchParams; }
    catch { sendJson(res, 400, { error: 'Invalid query.' }); return true; }
    const allowed = method === 'GET' && path === PATH ? ['after', 'limit']
      : method === 'GET' && path === MESSAGES ? ['since', 'before', 'agent', 'with', 'kind', 'priority', 'job', 'thread', 'channel', 'contains', 'from', 'excludeFrom', 'inReplyTo', 'id', 'bodyKind', 'limit']
      : method === 'GET' && path === WORK_FEED ? [...WORK_FEED_PARAMS] : [];
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) {
      sendJson(res, 400, { error: 'Invalid query.' }); return true;
    }
    try {
      if (path === `${PATH}/edges`) {
        const result = readFleetEdges();
        sendJson(res, result.source === 'unavailable' ? 503 : 200, result);
      } else if (path === WORK_FEED) {
        const query: BusWorkFeedQueryInput = {};
        for (const key of WORK_FEED_PARAMS) {
          const value = params.get(key);
          if (value !== null) query[key] = value;
        }
        const parsed = parseBusWorkFeedQuery(query);
        if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return true; }
        const feed = deps.workFeed ?? readBusWorkFeed;
        const result = projectBusWorkFeedView(parsed.claims ? feed({ claims: true }) : feed(), parsed.filters);
        const paged = parsed.limit === undefined ? result : sliceBusWorkFeedView(result, parsed.limit);
        sendJson(res, paged.status === 'ok' || paged.status === 'refused' ? 200 : 503, { v: 1, ...paged });
      } else if (path === MESSAGES) {
        const parsed = parseAgentMessagesQuery({ since: params.get('since') ?? undefined,
          before: params.get('before') ?? undefined,
          agent: params.get('agent') ?? undefined, with: params.get('with') ?? undefined,
          kind: params.get('kind') ?? undefined, priority: params.get('priority') ?? undefined,
          job: params.get('job') ?? undefined, thread: params.get('thread') ?? undefined,
          channel: params.get('channel') ?? undefined,
          contains: params.get('contains') ?? undefined, from: params.get('from') ?? undefined,
          excludeFrom: params.get('excludeFrom') ?? undefined,
          inReplyTo: params.get('inReplyTo') ?? undefined,
          id: params.get('id') ?? undefined,
          bodyKind: params.get('bodyKind') ?? undefined,
          to: params.get('to') ?? undefined,
          limit: params.get('limit') ?? undefined });
        if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return true; }
        const result = (deps.messages ?? readAgentMessages)(parsed.query);
        sendJson(res, result.source === 'unavailable' ? 503 : 200, result);
      } else if (path === NEEDS_MASON) {
        sendJson(res, 200, { v: 1, items: (deps.needsMason?.list ?? listNeedsMason)() });
      } else if (path === ASKS) {
        // 200 even when the ledger is unreadable: asks.v1 says ledger: unavailable, so the card can show unknown.
        sendJson(res, 200, (deps.asks?.list ?? listAsks)());
      } else if (path === ASKS_BATCH) {
        // The phone card: oldest first, duplicates merged (asks.batch.v1). 200 even when the ledger is unreadable (ledger: unavailable).
        sendJson(res, 200, (deps.asks?.batch ?? listAskBatch)());
      } else if (path === ASKS_ANSWER) {
        let raw: string;
        try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
        let input: unknown;
        try { input = JSON.parse(raw); } catch { input = null; }
        const fields = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
        const outcome = fields && Object.keys(fields).every(key => key === 'id' || key === 'answer')
          ? await (deps.asks?.answer ?? ((id, answer) => answerAsk(id, answer, 'desktop')))(fields.id, fields.answer)
          : await answerAsk(undefined, undefined, 'desktop');
        sendJson(res, ASK_STATUS_HTTP[outcome.status], outcome);
      } else if (path === APPROVALS) {
        // 200 even when the ledger is unreadable: the list says ledger: unavailable, so the card can show unknown.
        sendJson(res, 200, (deps.approvals?.list ?? listApprovals)());
      } else if (path === APPROVALS_ANSWER) {
        let raw: string;
        try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
        let input: unknown;
        try { input = JSON.parse(raw); } catch { input = null; }
        const fields = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
        const shaped = fields !== null && Object.keys(fields).every(key => key === 'id' || key === 'option' || key === 'from')
          && (fields.from === undefined || fields.from === 'desktop' || fields.from === 'phone');
        // The gate above proved the operator's unlock; `from` only labels which of his screens it was.
        const answerer = { channel: fields?.from === 'phone' ? 'phone' as const : 'desktop' as const, senderId: OPERATOR_SENDER_ID };
        const answer = deps.approvals?.answer ?? answerApproval;
        const outcome = shaped ? await answer(fields.id, fields.option, answerer) : await answer(undefined, undefined, answerer);
        sendJson(res, APPROVAL_STATUS_HTTP[outcome.status], outcome);
      } else if (path === NEEDS_MASON_RESOLVE) {
        let raw: string;
        try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
        let input: unknown;
        try { input = JSON.parse(raw); } catch { sendJson(res, 400, { v: 1, status: 'invalid', error: 'Invalid JSON.' }); return true; }
        const result = await (deps.needsMason?.resolve ?? resolveNeedsMasonWithInbox)(input);
        if (result.ok) sendJson(res, 200, { v: 1, status: 'resolved', itemId: result.itemId, cursor: result.cursor, inbox: result.inbox ?? 'skipped' });
        else sendJson(res, result.code === 'unknown' ? 404 : result.code === 'already-resolved' ? 409
          : result.code === 'unavailable' ? 503 : 400, { v: 1, status: result.code, error: result.error });
      } else if (method === 'GET' && path === `${PATH}/status`) {
        if (ctx.allowDispatch && !mirrorStarted) {
          mirrorStarted = true;
          try { (deps.startMirror ?? startBusMirrorLoop)(); }
          catch { /* a failing mirror must never break the status read */ }
        }
        const result = (deps.inspect ?? inspectBusInbox)();
        sendJson(res, result.source === 'unavailable' ? 503 : 200,
          { v: 1, ...result, mirror: getBusMirrorState() });
      } else if (method === 'GET') {
        const after = params.get('after') ?? '0', limit = params.get('limit') ?? '50';
        if (![after, limit].every(value => /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))) ||
          Number(limit) < 1 || Number(limit) > BUS_INBOX_MAX_READ) {
          sendJson(res, 400, { error: 'Invalid cursor or limit.' }); return true;
        }
        const result = (deps.list ?? listBusInboxAfter)(Number(after), Number(limit));
        sendJson(res, result.status === 'ok' ? 200 : result.status === 'invalid' ? 400 : 503, { v: 1, ...result });
      } else {
        let raw: string;
        try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
        const parsed = parseBusEnvelope(raw);
        if (!parsed.ok) { sendJson(res, 400, { v: 1, status: 'invalid' }); return true; }
        // v2 claim bodies are operations on the coordination table, not mail:
        // they execute and answer {v:2, ...} instead of appending to the inbox.
        const claim = (deps.claims ?? executeBusClaimBody)(parsed.value.body, parsed.value.id);
        if (claim !== undefined) {
          sendClaimJson(res, BUS_CLAIM_HTTP_STATUS[claim.status], claim);
          return true;
        }
        const result = (deps.append ?? appendBusInbox)(parsed.value);
        const status = result.status === 'posted' ? 201 : result.status === 'duplicate' ? 200 :
          result.status === 'invalid' ? 400 : result.status === 'conflict' ? 409 : result.status === 'full' ? 507 : 503;
        let appended = false;
        if (result.status === 'posted' || result.status === 'duplicate') {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const mirrored = await Promise.race([
              (deps.mirrorToInbox ?? mirrorLeaderPostToInbox)(parsed.value),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), CHANNEL_ACK_TIMEOUT_MS); }),
            ]);
            if (mirrored && !mirrored.ok) throw new Error('receive failed');
            appended = mirrored?.ok === true && mirrored.ack.status === 'accepted';
          } catch {
            // Static diagnostic: neither untrusted payloads nor error details reach logs.
            console.warn('Agent bus leader inbox mirror failed.');
          } finally { if (timer !== undefined) clearTimeout(timer); }
        }
        sendJson(res, status, { v: 1, ...result, inbox: { appended } });
      }
    } catch { sendJson(res, 503, { v: 1, status: 'unavailable' }); }
    return true;
  };
}
export const handleAgentBusApi = createAgentBusApi();
