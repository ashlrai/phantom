/** Desktop surface for chief-of-staff intake: ask, read status, approve the drafted reply.
 * Wire reference: docs/COS-DESKTOP-API.md. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import type { AshlrConfig } from '../types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { createChannelReceiver } from '../fleet/channel-envelope.js';
import { createLocalChannelDedupeStore } from '../fleet/channel-dedupe-store.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import { appendInboxEntry } from '../fleet/mason-inbox.js';
import { cosJobId, cosStatus, deliverCosResult, type CosRoute } from '../cos/intake.js';
import type { deliverTelegramCosResult } from '../comms/telegram-inbox-bridge.js';
import type { deliverEmailCosResult } from '../comms/email-drop-bridge.js';

export const VERSE_FLEET_COS_ASK_PATH = '/api/verse/fleet/cos/ask';
export const VERSE_FLEET_COS_STATUS_PATH = '/api/verse/fleet/cos/status';
export const VERSE_FLEET_COS_APPROVE_PATH = '/api/verse/fleet/cos/approve';

// passesMutationGate authenticates a single local operator (the x-ashlr-token
// holder). The receiver's canonical sender is therefore this fixed server-side
// identity, like VERSE_INBOX_OPERATOR_ID in fleet-runs-api.ts. Request fields
// are never identity, and the channel is never parsed from the body.
const VERSE_COS_OPERATOR_ID = 'verse-cos-operator';
const COS_INBOX_SOURCE = 'Phantom desktop task';
const COS_TEXT_MAX = 16_000;
const JOB_ID = /^cos-[a-f0-9]{32}$/;
const WIRE_DIGEST = /^sha256:[a-f0-9]{24}$/;

export interface FleetCosApiDeps {
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
  deliverTelegram?: typeof deliverTelegramCosResult;
  deliverEmail?: typeof deliverEmailCosResult;
  /** Config handed to the Telegram transport. Default: read-only user config. */
  loadConfig?: () => AshlrConfig | Promise<AshlrConfig>;
  /** Email reply outbox. Default: the saved email-drop config's outbox. */
  outboxDir?: string;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const defaultRunsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
// A bare 64-hex value is redacted by the response sanitizer, so the wire carries
// a labeled 96-bit prefix of the draft digest.
const wireDigest = (digest: string): string => `sha256:${digest.slice(0, 24)}`;
// Same guards as fleet-runs-api project(): bounded, no private paths, scrubbed.
function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length > COS_TEXT_MAX || /(?:\/Users\/|\/home\/|~\/|[A-Z]:\\)/.test(value)) {
    throw new Error('unsafe text');
  }
  return scrubSecrets(value);
}
const code = (e: unknown): unknown => record(e) ? e.code : undefined;

export function createFleetCosApi(deps: FleetCosApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const runsDir = deps.runsDir ?? defaultRunsDir();
  const receive = createChannelReceiver({
    allowedSenderIds: new Set([VERSE_COS_OPERATOR_ID]),
    now: () => new Date(now()),
    runsDir,
    backgroundQueue: true,
    receiptStore: createLocalChannelDedupeStore(runsDir),
    // The order trail stays MASON-INBOX.md, the same sink the inbox route uses.
    write: (envelope) => appendInboxEntry(envelope.body, { source: COS_INBOX_SOURCE, runsDir, now: () => new Date(now()) }),
  });

  async function ask(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { body = null; }
    const text = record(body) && typeof body.text === 'string' ? body.text.trim() : '';
    if (!record(body) || Object.keys(body).some(k => k !== 'text') || !text || text.length > COS_TEXT_MAX) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid task body' }); return;
    }
    try {
      const result = await receive({ channel: 'desktop', verifiedSenderId: VERSE_COS_OPERATOR_ID, body: text });
      if (result.ok) {
        const duplicate = result.ack.status === 'duplicate';
        sendJson(res, duplicate ? 200 : 201, { v: 1, id: cosJobId(result.ack.dedupeKey),
          ack: scrubSecrets(formatChannelAck(result.ack)).replace(/[a-f0-9]{64}/g, m => wireDigest(m)),
          status: 'queued', duplicate });
      } else if (result.reason === 'dedupe-store-unavailable' || result.reason === 'write-failed') {
        sendJson(res, 503, { code: 'COS_UNAVAILABLE' });
      } else {
        sendJson(res, 422, { code: 'COS_REFUSED', reason: safeText(result.reason) });
      }
    } catch { sendJson(res, 503, { code: 'COS_UNAVAILABLE' }); }
  }

  /** 'unknown' for a missing job; throws for unreadable state. */
  async function read(id: string) {
    try { return await cosStatus(id, runsDir); }
    catch (error) {
      if (error instanceof Error && error.message === 'Unknown chief-of-staff job') return 'unknown' as const;
      throw error;
    }
  }

  async function status(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    let id: string | null;
    try { id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id'); } catch { id = null; }
    if (id === null || !JOB_ID.test(id)) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid id' }); return; }
    try {
      const state = await read(id);
      if (state === 'unknown') { sendJson(res, 404, { code: 'COS_UNKNOWN' }); return; }
      const route = JSON.parse(state.job.acceptance) as CosRoute;
      // senderId and threadId stay server-side.
      sendJson(res, 200, { v: 1, id, jobStatus: safeText(state.job.status), channel: safeText(state.draft?.origin.channel ?? route.origin.channel),
        draft: state.draft ? { text: safeText(state.draft.text), digest: wireDigest(state.draft.digest) } : null,
        delivery: state.delivery ?? null, needsYou: state.needsYou });
    } catch { sendJson(res, 503, { code: 'COS_UNAVAILABLE' }); }
  }

  async function approve(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { body = null; }
    // Approval binds to the stored draft only; no text is ever read from the request.
    if (!record(body) || Object.keys(body).length !== 2 || typeof body.id !== 'string' || !JOB_ID.test(body.id) ||
      typeof body.digest !== 'string' || !WIRE_DIGEST.test(body.digest)) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid approval body' }); return;
    }
    const { id, digest } = body as { id: string; digest: string };
    try {
      const state = await read(id);
      if (state === 'unknown') { sendJson(res, 404, { code: 'COS_UNKNOWN' }); return; }
      if (!state.draft || wireDigest(state.draft.digest) !== digest) { sendJson(res, 409, { code: 'COS_APPROVAL_STALE' }); return; }
      // Any prior claim (sending, sent or uncertain) is final: never retry automatically.
      if (state.delivery !== undefined) { sendJson(res, 409, { code: 'COS_ALREADY_CLAIMED' }); return; }
      const full = state.draft.digest;
      const channel = state.draft.origin.channel;
      let send: () => Promise<void>;
      if (channel === 'telegram') {
        const cfg = await (deps.loadConfig ?? (async () => (await import('../config.js')).loadConfigReadOnly()))();
        const deliver = deps.deliverTelegram ?? (await import('../comms/telegram-inbox-bridge.js')).deliverTelegramCosResult;
        send = () => deliver(id, full, cfg, { runsDir });
      } else if (channel === 'email') {
        let outboxDir = deps.outboxDir;
        if (outboxDir === undefined) {
          const saved = await (await import('../comms/email-drop-config.js')).readEmailDropConfig(runsDir);
          if (saved.state === 'ok' && saved.config) outboxDir = saved.config.outboxDir ?? join(saved.config.inboxDir, '..', 'outbox');
        }
        if (outboxDir === undefined) { sendJson(res, 422, { code: 'COS_NO_TRANSPORT', channel }); return; }
        const deliver = deps.deliverEmail ?? (await import('../comms/email-drop-bridge.js')).deliverEmailCosResult;
        const dir = outboxDir;
        send = () => deliver(id, full, { runsDir, outboxDir: dir });
      } else if (channel === 'desktop' || channel === 'cli') {
        // The reply is already on screen; claiming the delivery records the approval.
        send = () => deliverCosResult(id, full, async () => {}, runsDir);
      } else {
        sendJson(res, 422, { code: 'COS_NO_TRANSPORT', channel }); return;
      }
      try { await send(); }
      catch (error) {
        if (code(error) === 'EEXIST') {
          // Our own failed send leaves 'uncertain'; anything else means another caller holds the claim.
          const after = await read(id).catch(() => 'unknown' as const);
          if (after === 'unknown' || after.delivery !== 'uncertain') { sendJson(res, 409, { code: 'COS_ALREADY_CLAIMED' }); return; }
        }
        sendJson(res, 502, { code: 'COS_DELIVERY_UNCERTAIN' }); return;
      }
      sendJson(res, 200, { v: 1, id, delivery: 'sent' });
    } catch { sendJson(res, 503, { code: 'COS_UNAVAILABLE' }); }
  }

  return async (ctx, req, res, path, method) => {
    const route = path === VERSE_FLEET_COS_ASK_PATH ? 'ask' : path === VERSE_FLEET_COS_STATUS_PATH ? 'status'
      : path === VERSE_FLEET_COS_APPROVE_PATH ? 'approve' : null;
    if (route === null) return false;
    if (method !== (route === 'status' ? 'GET' : 'POST')) { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (route !== 'status' && !passesMutationGate(req, res, ctx.token)) return true;
    await (route === 'ask' ? ask : route === 'status' ? status : approve)(req, res);
    return true;
  };
}

export const handleFleetCosApi: ApiModule = createFleetCosApi();
