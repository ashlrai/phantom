import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ApiModule } from './api-modules.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { createChannelReceiver } from '../fleet/channel-envelope.js';
import type { InboxAppendResult } from '../fleet/mason-inbox.js';
import { parseInboxReadQuery, projectInboxRead } from './fleet-inbox-read.js';
import { FLEET_RUNS_INBOX_MAX_CHARS, VERSE_FLEET_RUNS_PATH, VERSE_FLEET_RUNS_INBOX_PATH, type FleetRunsV1 } from './fleet-runs-types.js';

// passesMutationGate authenticates a single local operator (the x-ashlr-token
// holder); there is no per-request user identity. The shared channel receiver's
// canonical sender is therefore this documented server-owned identity. Request
// fields — including `source` — are never identity.
const VERSE_INBOX_OPERATOR_ID = 'verse-inbox-operator';
// The only trusted surface fact is that the request reached this authenticated
// desktop/mobile console route, so the channel is a fixed server-side mapping.
const VERSE_INBOX_CHANNEL = 'desktop' as const;
const DEFAULT_INBOX_SOURCE = 'Phantom desktop';

export interface FleetRunsApiDeps {
  readRunsDir?: () => Promise<unknown>;
  listWorkers?: () => Promise<unknown>;
  readInbox?: (limit: number) => Promise<unknown>;
  appendInbox?: (text: string, source: string) => Promise<unknown>;
  codexPersonal?: () => Promise<unknown>;
  mergedLastHour?: () => Promise<unknown>;
  now?: () => number;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unavailable = (e: unknown) => record(e) && ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String(e.code));
// Project only declared fields. Never forward reader objects, paths or diagnostic errors.
type Shape = string | { [key: string]: Shape } | readonly [Shape];
function project(value: unknown, shape: Shape): unknown {
  if (typeof shape === 'string') {
    if (shape.endsWith('?') && value === null) return null;
    const kind = shape.replace('?', '');
    if (typeof value !== kind || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('shape');
    if (typeof value === 'string') {
      if (value.length > 6000 || /(?:\/Users\/|\/home\/|~\/|[A-Z]:\\)/.test(value)) throw new Error('private path');
      return scrubSecrets(value);
    }
    return value;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length > 1000) throw new Error('array');
    return value.map(v => project(v, shape[0]!));
  }
  if (!record(value)) throw new Error('object');
  return Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, project(value[k], s)]));
}
const inboxShape: Shape = [{ at: 'string', source: 'string', text: 'string' }];
const runsShape: Shape = {
  lastTick: 'string?', paused: 'boolean?', memFreePct: 'number?', diskFreeGb: 'number?', switches: ['string'], claudeLane: 'string?',
  lanes: [{ lane: 'string', running: 'number', target: 'number', queued: 'number', held: 'boolean', heldReason: 'string?', tokensLastHour: 'number?', merged24h: 'number?', mergeRate24h: 'number?' }],
  publishesLastHour: [{ job: 'string', lane: 'string?', url: 'string?', at: 'string' }],
  events: [{ at: 'string', kind: 'string', text: 'string' }],
};
const workersShape: Shape = {
  workers: [{ job: 'string', repo: 'string', lane: 'string', tier: 'string', ageSeconds: 'number?' }],
  leaders: [{ label: 'string', ageSeconds: 'number?' }], orchestratorAgents: 'number?',
};
const dropShape: Shape = { pending: [{ lane: 'string', file: 'string' }], done: 'number' };
const codexShape: Shape = { usedPct: 'number?', resetsAt: 'string?', asOf: 'string?' };
const mergesShape: Shape = { count: 'number?', items: [{ repo: 'string', number: 'number', title: 'string' }] };

async function personal(now: number): Promise<unknown> {
  const { collectCodexSessionUsages, buildCodexResourceReport } = await import('../fleet/codex-session-usage.js');
  const usages = collectCodexSessionUsages({ env: { CODEX_HOME: join(homedir(), '.codex'), CODEX_HOME_ALT: join(homedir(), '.codex-2') } });
  const account = buildCodexResourceReport(usages.filter(u => u.accountId === 'codex-personal'), [], now).resources[0];
  if (!account || !account.session) return null;
  return { usedPct: account.session.usedPct, resetsAt: account.session.resetsAt, asOf: account.observedAt };
}
export function createFleetRunsApi(deps: FleetRunsApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  let mergedCache: { at: number; value: unknown } | undefined;
  const merges = deps.mergedLastHour ?? (async () => {
    if (mergedCache && now() - mergedCache.at < 60_000) return mergedCache.value;
    const { stdout } = await promisify(execFile)('gh', ['api', 'search/issues', '-X', 'GET', '-f',
      'q=org:ashlrai is:pr is:merged merged:>' + new Date(now() - 3_600_000).toISOString(), '-f', 'per_page=30'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const raw: unknown = JSON.parse(stdout);
    if (!record(raw) || typeof raw.total_count !== 'number' || !Array.isArray(raw.items)) throw new Error('merges');
    const value = { count: raw.total_count, items: raw.items.map((item: unknown) => {
      if (!record(item) || typeof item.repository_url !== 'string' || !/^https:\/\/api.github.com\/repos\/ashlrai\/[\w.-]+$/.test(item.repository_url)) throw new Error('repo');
      return { repo: item.repository_url.replace('https://api.github.com/repos/', ''), number: item.number, title: item.title };
    }) };
    project(value, mergesShape);
    mergedCache = { at: now(), value };
    return value;
  });
  const runs = deps.readRunsDir ?? (async () => (await import('../fleet/runs-dir-state.js' as string)).readFleetRunsDirState());
  const workers = deps.listWorkers ?? (async () => (await import('../fleet/runs-live-workers.js' as string)).listLiveWorkers());
  const inbox = deps.readInbox ?? (async (limit: number) => (await import('../fleet/mason-inbox.js' as string)).readInboxEntries({ limit }));
  const append = deps.appendInbox ?? (async (text: string, source: string) => (await import('../fleet/mason-inbox.js' as string)).appendInboxEntry(text, { source }));
  // One receiver per API instance: its normalization/dedupe contract is shared
  // by every POST below for the process lifetime. `source` stays presentation
  // metadata — never identity — so it rides to the sink out of band: the
  // receiver serializes all writes, which keeps the ticket at the head of
  // pendingSources the one belonging to the request inside receive(). Each
  // request removes its ticket exactly once (consumed by write, or spliced in
  // the finally of the POST handler) before the next receive can start.
  const pendingSources: { source: string }[] = [];
  const receive = createChannelReceiver({
    allowedSenderIds: new Set([VERSE_INBOX_OPERATOR_ID]),
    now: () => new Date(now()),
    write: async (envelope) => (await append(envelope.body, pendingSources[0]?.source ?? DEFAULT_INBOX_SOURCE)) as InboxAppendResult,
  });
  async function build(): Promise<FleetRunsV1> {
    const result: FleetRunsV1 = {
      v: 1, generatedAt: new Date(now()).toISOString(), sources: { runsDir: 'degraded', workers: 'degraded', inbox: 'degraded', codex: 'degraded', merges: 'degraded' },
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
      workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
    };
    const sources = [
      ['runsDir', runs, runsShape], ['workers', workers, workersShape], ['inbox', () => inbox(30), inboxShape],
      ['codex', deps.codexPersonal ?? (() => personal(now())), codexShape], ['merges', merges, mergesShape],
    ] as const;
    await Promise.all(sources.map(async ([key, read, shape]) => {
      try {
        const raw: unknown = await read();
        if (raw === null && key === 'codex') { result.sources[key] = 'missing'; return; }
        // The canonical inbox reader returns an envelope; older injected
        // readers may still supply the snapshot array directly.
        if (key === 'inbox' && !Array.isArray(raw) &&
          (!record(raw) || !['healthy', 'missing', 'degraded'].includes(String(raw.sourceState)))) throw new Error('inbox state');
        const value = project(key === 'inbox' && record(raw) ? raw.entries : raw, shape);
        // Validate the optional drop projection before applying any runs fields.
        const drop = key === 'runsDir' && record(raw) && raw.drop != null ? project(raw.drop, dropShape) : null;
        if (key === 'runsDir' || key === 'workers') Object.assign(result, value);
        if (key === 'runsDir') result.drop = drop as FleetRunsV1['drop'];
        if (key === 'inbox') result.inbox = value as FleetRunsV1['inbox'];
        if (key === 'codex') result.codexPersonal = value as FleetRunsV1['codexPersonal'];
        if (key === 'merges') result.mergesLastHour = value as FleetRunsV1['mergesLastHour'];
        result.sources[key] = record(raw) && ['missing', 'degraded'].includes(String(raw.sourceState)) ? raw.sourceState as 'missing' | 'degraded' : 'healthy';
      } catch (error) { result.sources[key] = unavailable(error) ? 'not-landed' : 'degraded'; }
    }));
    return result;
  }
  let cached: { at: number; value: FleetRunsV1 } | undefined;
  let flight: Promise<FleetRunsV1> | undefined;
  return async (ctx, req, res, path, method) => {
    if (method === 'GET' && path === VERSE_FLEET_RUNS_PATH) {
      if (!flight && (!cached || now() - cached.at >= 2000)) {
        flight = build().then(value => { cached = { at: now(), value }; return value; }).finally(() => { flight = undefined; });
      }
      sendJson(res, 200, flight ? await flight : cached!.value);
      return true;
    }
    if (method === 'GET' && path === VERSE_FLEET_RUNS_INBOX_PATH) {
      let query: ReturnType<typeof parseInboxReadQuery>;
      try { query = parseInboxReadQuery(new URL(req.url ?? '/', 'http://localhost').searchParams); }
      catch { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query string' }); return true; }
      if ('error' in query) { sendJson(res, 400, { code: 'VERSE_INVALID', error: query.error }); return true; }
      try { sendJson(res, 200, projectInboxRead(await inbox(query.limit), query)); }
      catch { sendJson(res, 503, { code: 'INBOX_UNAVAILABLE' }); }
      return true;
    }
    if (method !== 'POST' || path !== VERSE_FLEET_RUNS_INBOX_PATH) return false;
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { body = null; }
    if (!record(body) || Object.keys(body).some(k => k !== 'text' && k !== 'source') ||
      typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > FLEET_RUNS_INBOX_MAX_CHARS ||
      (body.source !== undefined && (typeof body.source !== 'string' || !/^[A-Za-z0-9 ._-]{1,40}$/.test(body.source)))) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid inbox body' }); return true;
    }
    const ticket = { source: typeof body.source === 'string' ? body.source : DEFAULT_INBOX_SOURCE };
    pendingSources.push(ticket);
    try {
      const result = await receive({ channel: VERSE_INBOX_CHANNEL, verifiedSenderId: VERSE_INBOX_OPERATOR_ID, body: body.text.trim() });
      if (result.ok) {
        // Only an accepted persistence invalidates the cached composite; a
        // duplicate appended nothing, and a refusal changed nothing.
        if (result.ack.status === 'accepted') cached = undefined;
        sendJson(res, result.ack.status === 'accepted' ? 201 : 200, {
          ok: true, at: result.envelope.receivedAt,
          accepted: result.ack.status === 'accepted', duplicate: result.ack.status === 'duplicate',
          // The receiver's key is a bare 64-hex SHA-256 — a secret shape the
          // response sanitizer would redact — so the wire carries a labeled
          // 96-bit prefix of the same stable key.
          dedupeKey: `sha256:${result.ack.dedupeKey.slice(0, 24)}`,
        });
      } else if (result.reason === 'write-failed' || typeof result.reason !== 'string' || !result.reason) {
        sendJson(res, 503, { code: 'INBOX_UNAVAILABLE' });
      } else {
        sendJson(res, 422, { code: 'INBOX_REFUSED', reason: project(result.reason, 'string') });
      }
    } catch { sendJson(res, 503, { code: 'INBOX_UNAVAILABLE' }); }
    finally {
      const i = pendingSources.indexOf(ticket);
      if (i >= 0) pendingSources.splice(i, 1);
    }
    return true;
  };
}
export const handleFleetRunsApi: ApiModule = createFleetRunsApi();
