/**
 * core/verse/self-surface.ts — Phantom sees and drives its own UI.
 *
 * An agent asks the console for the open window's route snapshot (roles,
 * names and stable ids, never input values), a render of the webview, a
 * navigation, or a click/focus on a stable id. The request waits in this
 * process; the desktop webview long-polls for it (self-surface-client.ts in
 * web-ui), runs it in the page and posts the result back. Nothing depends on
 * the window being visible or on screen pixels.
 *
 * Gates, the same as desktop-operator writes: every action posts a bus
 * envelope first and does not run if the bus refuses it; navigate and act are
 * refused while KILL or the comms pause is on (reads stay available, as
 * desktop reads do). Agents authenticate with a scoped token that only opens
 * POST /api/verse/self/request; it is published 0600 under
 * ~/.ashlr/self-surface/endpoint.json for local agents and is not the console
 * mutation token. Result text is secret-scrubbed; screenshots are written
 * 0600 under ~/.ashlr/self-surface/shots and returned as a path unless the
 * call opts in to the image bytes.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { isPaused } from '../comms/pause.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { scrubSecrets } from '../util/scrub.js';

export const SELF_SURFACE_ENDPOINT_SCHEMA = 'phantom.self-surface.endpoint.v1';
export const SELF_REQUEST_PATH = '/api/verse/self/request';
export const SELF_NEXT_PATH = '/api/verse/self/next';
export const SELF_RESULT_PATH = '/api/verse/self/result';
export const SELF_TOKEN_HEADER = 'x-ashlr-self-token';

export const SELF_VERBS = ['snapshot', 'screenshot', 'navigate', 'act'] as const;
export type SelfVerb = (typeof SELF_VERBS)[number];
export const SELF_ACTIONS = ['click', 'focus'] as const;
export type SelfAction = (typeof SELF_ACTIONS)[number];

export type SelfRequest =
  | { verb: 'snapshot' }
  | { verb: 'screenshot'; includeImage?: boolean }
  | { verb: 'navigate'; section: string; anchor?: string }
  | { verb: 'act'; testId: string; action: SelfAction };

export type SelfErrorCode = 'invalid' | 'no_console' | 'killed' | 'comms_paused' | 'intent_not_posted' | 'no_client' | 'busy' | 'timeout' | 'failed';
export type SelfResult =
  | { ok: true; verb: SelfVerb; data: Record<string, unknown> }
  | { ok: false; verb: SelfVerb | null; code: SelfErrorCode; error: string };

export interface SelfCommand { id: string; request: SelfRequest; issuedAt: number }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SECTION = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_QUEUE = 4;
const MAX_SHOT_BYTES = 8 * 1024 * 1024;
/** A client that has not polled for this long is treated as absent. */
export const SELF_CLIENT_STALE_MS = 45_000;
export const SELF_REQUEST_TIMEOUT_MS = 20_000;
const INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isSelfWrite(verb: SelfVerb): boolean {
  return verb === 'navigate' || verb === 'act';
}

/** Null when `raw` is not one well-formed request. */
export function parseSelfRequest(raw: unknown): SelfRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (r['verb']) {
    case 'snapshot': return only('verb') ? { verb: 'snapshot' } : null;
    case 'screenshot':
      if (!only('verb', 'includeImage') || (r['includeImage'] !== undefined && typeof r['includeImage'] !== 'boolean')) return null;
      return r['includeImage'] === true ? { verb: 'screenshot', includeImage: true } : { verb: 'screenshot' };
    case 'navigate':
      if (!only('verb', 'section', 'anchor') || typeof r['section'] !== 'string' || !SECTION.test(r['section'])) return null;
      if (r['anchor'] !== undefined && (typeof r['anchor'] !== 'string' || !ID.test(r['anchor']))) return null;
      return { verb: 'navigate', section: r['section'], ...(typeof r['anchor'] === 'string' ? { anchor: r['anchor'] } : {}) };
    case 'act': {
      const action = r['action'] ?? 'click';
      if (!only('verb', 'testId', 'action') || typeof r['testId'] !== 'string' || !ID.test(r['testId'])) return null;
      if (!(SELF_ACTIONS as readonly unknown[]).includes(action)) return null;
      return { verb: 'act', testId: r['testId'], action: action as SelfAction };
    }
    default: return null;
  }
}

/** Every string in a result, secret-scrubbed and bounded; image bytes are handled before this. */
export function scrubSelfJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecrets(value).slice(0, 2_000);
  if (depth > 8 || value === null || typeof value !== 'object') return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
  if (Array.isArray(value)) return value.slice(0, 2_000).map((v) => scrubSelfJson(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 200)) out[k] = scrubSelfJson(v, depth + 1);
  return out;
}

export interface SelfSurfaceDeps {
  killed?: () => boolean;
  commsPaused?: () => boolean;
  postIntent?: (envelope: BusEnvelope) => { status: string };
  now?: () => number;
  id?: () => string;
  shotsDir?: () => string;
  timeoutMs?: number;
}

const failClosed = (probe: () => boolean): boolean => { try { return probe(); } catch { return true; } };

function targetOf(request: SelfRequest): string | null {
  if (request.verb === 'navigate') return request.anchor ? `${request.section}#${request.anchor}` : request.section;
  if (request.verb === 'act') return `${request.action}:${request.testId}`;
  return null;
}

export class SelfSurfaceBroker {
  private queue: SelfCommand[] = [];
  private pollers: Array<(command: SelfCommand | null) => void> = [];
  private pending = new Map<string, { command: SelfCommand; settle: (result: SelfResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private lastPollAt = 0;

  constructor(private readonly deps: SelfSurfaceDeps = {}) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Gate, log to the bus, queue for the webview and wait for its answer. */
  async submit(raw: unknown): Promise<SelfResult> {
    const request = parseSelfRequest(raw);
    const verb = raw && typeof raw === 'object' && (SELF_VERBS as readonly unknown[]).includes((raw as { verb?: unknown }).verb)
      ? (raw as { verb: SelfVerb }).verb : null;
    if (!request) return { ok: false, verb, code: 'invalid', error: 'Use verb snapshot, screenshot, navigate {section} or act {testId, action: click|focus}.' };
    if (isSelfWrite(request.verb) && failClosed(this.deps.killed ?? killSwitchOn)) {
      return { ok: false, verb: request.verb, code: 'killed', error: 'The fleet KILL switch is on. Self-surface writes are stopped.' };
    }
    if (isSelfWrite(request.verb) && failClosed(this.deps.commsPaused ?? isPaused)) {
      return { ok: false, verb: request.verb, code: 'comms_paused', error: 'Comms pause is on. Self-surface writes are paused.' };
    }
    if (this.now() - this.lastPollAt > SELF_CLIENT_STALE_MS) {
      return { ok: false, verb: request.verb, code: 'no_client', error: 'No Phantom window is connected to this console. Open the desktop app.' };
    }
    if (this.queue.length >= MAX_QUEUE) return { ok: false, verb: request.verb, code: 'busy', error: 'The self-surface queue is full. Retry shortly.' };
    const command: SelfCommand = { id: (this.deps.id ?? randomUUID)(), request, issuedAt: this.now() };
    if (!this.postIntent(command)) {
      return { ok: false, verb: request.verb, code: 'intent_not_posted', error: 'The self-surface intent was not posted to the agent bus, so the action did not run.' };
    }
    return new Promise<SelfResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        this.queue = this.queue.filter((c) => c.id !== command.id);
        resolve({ ok: false, verb: request.verb, code: 'timeout', error: 'The Phantom window did not answer in time.' });
      }, this.deps.timeoutMs ?? SELF_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(command.id, { command, settle: resolve, timer });
      const poller = this.pollers.shift();
      if (poller) poller(command);
      else this.queue.push(command);
    });
  }

  private postIntent(command: SelfCommand): boolean {
    const envelope: BusEnvelope = {
      id: command.id,
      from: 'self-surface',
      to: 'leaders',
      priority: 'P2',
      ttl: INTENT_TTL_MS,
      body: { kind: 'desktop.intent', verb: `self-${command.request.verb}`, app: 'Phantom', window: targetOf(command.request), chars: null },
    };
    const checked = validateBusEnvelope(envelope);
    if (!checked.ok) return false;
    try {
      const status = (this.deps.postIntent ?? ((value) => appendBusInbox(value)))(checked.value).status;
      return status === 'posted' || status === 'duplicate';
    } catch { return false; }
  }

  /** The webview's long poll: the next command, or null after `waitMs`. */
  next(waitMs: number, signal?: AbortSignal): Promise<SelfCommand | null> {
    this.lastPollAt = this.now();
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      let done = false;
      const finish = (command: SelfCommand | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pollers = this.pollers.filter((p) => p !== finish);
        this.lastPollAt = this.now();
        resolve(command);
      };
      const timer = setTimeout(() => finish(null), Math.max(0, Math.min(waitMs, 30_000)));
      timer.unref?.();
      signal?.addEventListener('abort', () => finish(null), { once: true });
      this.pollers.push(finish);
    });
  }

  /** The webview's answer. False when the id is unknown or already settled. */
  complete(id: string, raw: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.settle(this.shape(entry.command, raw));
    return true;
  }

  private shape(command: SelfCommand, raw: unknown): SelfResult {
    const verb = command.request.verb;
    const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (r['ok'] !== true || !r['data'] || typeof r['data'] !== 'object') {
      return { ok: false, verb, code: 'failed', error: scrubSecrets(typeof r['error'] === 'string' ? r['error'] : 'The window could not run that.').slice(0, 300) };
    }
    const data = { ...(r['data'] as Record<string, unknown>) };
    if (verb === 'screenshot') {
      const base64 = typeof data['base64'] === 'string' ? data['base64'] : '';
      delete data['base64'];
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_SHOT_BYTES || bytes.subarray(0, 4).toString('hex') !== '89504e47') {
        return { ok: false, verb, code: 'failed', error: 'The window returned no PNG within the size cap.' };
      }
      const dir = (this.deps.shotsDir ?? (() => join(ashlrHome(), 'self-surface', 'shots')))();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${command.id.slice(0, 8)}.png`);
      writeFileSync(path, bytes, { mode: 0o600 });
      const shaped = scrubSelfJson(data) as Record<string, unknown>;
      return { ok: true, verb, data: { ...shaped, mime: 'image/png', path, bytes: bytes.length, untrusted: true,
        ...(command.request.verb === 'screenshot' && command.request.includeImage ? { base64 } : {}) } };
    }
    return { ok: true, verb, data: { ...(scrubSelfJson(data) as Record<string, unknown>), untrusted: true } };
  }

  clientConnected(): boolean {
    return this.now() - this.lastPollAt <= SELF_CLIENT_STALE_MS;
  }
}

let broker: SelfSurfaceBroker | null = null;
/** The console process's one broker. */
export function selfSurfaceBroker(): SelfSurfaceBroker {
  broker ??= new SelfSurfaceBroker();
  return broker;
}

const selfToken = randomBytes(32).toString('hex');

export function selfTokenMatches(value: string | undefined | null): boolean {
  if (typeof value !== 'string' || value.length !== selfToken.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(selfToken));
}

export interface SelfSurfaceEndpoint { schema: typeof SELF_SURFACE_ENDPOINT_SCHEMA; url: string; token: string; pid: number }

const endpointPath = (home: string) => join(home, 'self-surface', 'endpoint.json');

/** Publish this console's loopback URL and scoped token for local agents (0600); removed on exit. */
export function publishSelfSurfaceEndpoint(url: string, home: string = ashlrHome()): string | null {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) return null;
  const path = endpointPath(home);
  mkdirSync(join(home, 'self-surface'), { recursive: true, mode: 0o700 });
  const endpoint: SelfSurfaceEndpoint = { schema: SELF_SURFACE_ENDPOINT_SCHEMA, url: url.replace(/\/$/, ''), token: selfToken, pid: process.pid };
  writeFileSync(path, JSON.stringify(endpoint) + '\n', { mode: 0o600 });
  process.once('exit', () => {
    try { if (readSelfSurfaceEndpoint(home)?.pid === process.pid) rmSync(path, { force: true }); } catch { /* best effort */ }
  });
  return path;
}

export function readSelfSurfaceEndpoint(home: string = ashlrHome()): SelfSurfaceEndpoint | null {
  const path = endpointPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SelfSurfaceEndpoint>;
    if (raw.schema !== SELF_SURFACE_ENDPOINT_SCHEMA || typeof raw.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(raw.url)
      || typeof raw.token !== 'string' || !/^[0-9a-f]{64}$/.test(raw.token) || typeof raw.pid !== 'number') return null;
    return raw as SelfSurfaceEndpoint;
  } catch { return null; }
}
