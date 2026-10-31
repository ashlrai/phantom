import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ApiModule } from './api-modules.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { parseInboxReadQuery, projectInboxRead } from './fleet-inbox-read.js';
import { FLEET_RUNS_INBOX_MAX_CHARS, VERSE_FLEET_RUNS_PATH, VERSE_FLEET_RUNS_INBOX_PATH, type FleetRunsV1 } from './fleet-runs-types.js';

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
        const value = project(raw, shape);
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
    try {
      const value: unknown = await append(body.text.trim(), typeof body.source === 'string' ? body.source : 'Phantom desktop');
      if (record(value) && value.ok === true) {
        cached = undefined;
        sendJson(res, 201, { ok: true, at: new Date(now()).toISOString() });
      } else if (record(value) && value.ok === false && typeof value.reason === 'string') {
        sendJson(res, 422, { code: 'INBOX_REFUSED', reason: project(value.reason, 'string') });
      } else sendJson(res, 503, { code: 'INBOX_UNAVAILABLE' });
    } catch { sendJson(res, 503, { code: 'INBOX_UNAVAILABLE' }); }
    return true;
  };
}
export const handleFleetRunsApi: ApiModule = createFleetRunsApi();
