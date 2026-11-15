/**
 * Unified live session roster (RQ-AGENTNET-VIEW-1).
 *
 * One probe per source, in parallel, each bounded by a short timeout.
 * A probe that times out, is missing, or has no documented machine-readable
 * shape degrades to unknown. It never invents sessions and never reads app
 * databases, session stores, or credential files.
 *
 * Claims come from the coordination table (claim-store). Message-id rows
 * project back to the bus message id. Fencing tokens never leave the store.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DevinSession, DevinSessionPage } from '../devin/client.js';
import { connectedClient } from '../devin/service.js';
import { scrubSecrets } from '../util/scrub.js';
import { listCoordination } from '../agents/claim-store.js';
import { inspectBusWorkClaims, type BusWorkClaimView } from './bus-work-claims.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from './runs-live-workers.js';

export const AGENT_ROSTER_SCHEMA = 'agent-roster.v1' as const;
export const ROSTER_PROBE_TIMEOUT_MS = 5_000;
export const ROSTER_SOURCES = [
  'phantom',
  'devin-cloud',
  'devin-desktop',
  'codex',
  'claude',
  'cursor',
  'grok',
  'ollama',
  'omlx',
] as const;
export type RosterSourceId = (typeof ROSTER_SOURCES)[number];

export interface RosterClaimRef {
  store: 'claim-store' | 'bus-work-fallback';
  id: string;
  owner: string;
  leaseUntil: string | null;
  completed: boolean;
}

export interface RosterSession {
  provider: RosterSourceId;
  sessionId: string;
  title: string | null;
  state: string;
  ownership: string | null;
  claims: RosterClaimRef[];
  lastActivity: string | null;
  blockers: string[];
  sourceKind?: 'local' | 'cloud';
  url?: string;
  org?: string;
  created?: string;
}

export interface RosterSource {
  source: RosterSourceId;
  ok: boolean;
  availability: 'known' | 'unknown';
  sessions: RosterSession[];
  error: string | null;
  observedAt: string;
  truncated: boolean;
}

type RosterClaimsInspection = { source: 'claim-store' | 'bus-work-fallback' | 'missing' | 'unavailable'; claims: BusWorkClaimView[] };

export interface AgentRoster {
  schema: typeof AGENT_ROSTER_SCHEMA;
  observedAt: string;
  latencyMs: number;
  sources: RosterSource[];
  sessions: RosterSession[];
  claims: { source: RosterClaimsInspection['source']; items: RosterClaimRef[] };
}

export interface RosterExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  missing: boolean;
}

export interface AgentRosterDeps {
  now?: () => number;
  timeoutMs?: number;
  listPhantom?: () => Promise<LiveWorkersSnapshot>;
  listDevinCloud?: () => Promise<DevinSessionPage | { unavailable: string }>;
  exec?: (argv: readonly string[], timeoutMs: number) => Promise<RosterExecResult>;
  fetchLoopback?: (url: string, timeoutMs: number) => Promise<{ status: number; body: string } | { unavailable: true }>;
  readClaims?: () => RosterClaimsInspection;
  /** Phantom-owned ~/.ashlr-runs/queue/devin-session-roster.json, or null if absent. Tests must inject this so they never read the live Mac file. */
  readDevinCliRoster?: () => Promise<string | null>;
}

const OLLAMA_PS_URL = 'http://127.0.0.1:11434/api/ps';
const OMLX_MODELS_URL = 'http://127.0.0.1:8123/v1/models';
const MAX_SESSIONS = 100;
const MAX_TEXT = 200;

const DEVIN_DESKTOP_MISSING =
  'Phantom Devin session roster is not present yet. Run bin/devin-session-roster.py emit after a Devin job, or see DEVIN-UNIFY-1.';
const DEVIN_DESKTOP_UNREADABLE =
  'Phantom Devin session roster is unreadable.';
const CODEX_UNKNOWN =
  'codex agents opens an interactive command center and does not document a machine-readable session list (learn.chatgpt.com/docs/developer-commands).';
const CURSOR_UNKNOWN =
  'cursor-agent ls opens an interactive chat picker and does not document a machine-readable session list (cursor.com/docs/cli/reference/parameters).';
const GROK_UNKNOWN =
  'grok sessions list prints a human table for the current directory and does not document a machine-readable schema (docs.x.ai/build/features/sessions).';

function stripControls(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 32 && code !== 127) out += char;
  }
  return out;
}

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const scrubbed = stripControls(scrubSecrets(value)).trim();
  if (!scrubbed) return null;
  return scrubbed.slice(0, max);
}

function isoMillis(ms: number): string | null {
  if (!Number.isSafeInteger(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Live coordination leases in the bus-work claim shape the roster already renders. */
export function readRosterClaims(now = Date.now(), root?: string): RosterClaimsInspection {
  const listed = listCoordination(root, now);
  if (listed.source !== 'available') {
    const fallback = inspectBusWorkClaims(root);
    return fallback.source === 'available'
      ? { source: 'bus-work-fallback', claims: fallback.claims }
      : { source: listed.source === 'unavailable' || fallback.source === 'unavailable' ? 'unavailable' : 'missing', claims: [] };
  }
  const claims: BusWorkClaimView[] = [];
  for (const row of listed.claims) {
    if (!row.live) continue;
    const id = row.origin === 'message' && row.key.startsWith('queue:') ? row.key.slice('queue:'.length) : row.key;
    claims.push({ id, cursor: 0, receivedAt: 0, owner: row.owner, leaseUntil: row.leaseUntil, completedAt: null });
  }
  return { source: 'claim-store', claims };
}

function claimRef(row: BusWorkClaimView, source: RosterClaimsInspection['source']): RosterClaimRef | null {
  const id = text(row.id, 128);
  const owner = text(row.owner, 128);
  if (!id || !owner) return null;
  return {
    store: source === 'claim-store' ? 'claim-store' : 'bus-work-fallback',
    id,
    owner,
    leaseUntil: isoMillis(row.leaseUntil),
    completed: row.completedAt !== null,
  };
}

function session(input: RosterSession): RosterSession | null {
  const sessionId = text(input.sessionId, 128);
  const state = text(input.state, 80);
  if (!sessionId || !state) return null;
  const next: RosterSession = {
    provider: input.provider,
    sessionId,
    title: text(input.title),
    state,
    ownership: text(input.ownership, 128),
    claims: [],
    lastActivity: text(input.lastActivity, 40),
    blockers: input.blockers.map((item) => text(item)).filter((item): item is string => item !== null).slice(0, 5),
  };
  if (input.sourceKind === 'local' || input.sourceKind === 'cloud') next.sourceKind = input.sourceKind;
  const url = text(input.url);
  if (url) next.url = url;
  const org = text(input.org, 128);
  if (org) next.org = org;
  const created = text(input.created, 40);
  if (created) next.created = created;
  return next;
}

function known(sourceId: RosterSourceId, observedAt: string, sessions: RosterSession[], truncated = false): RosterSource {
  return {
    source: sourceId,
    ok: true,
    availability: 'known',
    sessions: sessions.slice(0, MAX_SESSIONS),
    error: null,
    observedAt,
    truncated,
  };
}

function unknown(sourceId: RosterSourceId, observedAt: string, error: string): RosterSource {
  return {
    source: sourceId,
    ok: false,
    availability: 'unknown',
    sessions: [],
    error,
    observedAt,
    truncated: false,
  };
}

function helpOf(result: RosterExecResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultExec(argv: readonly string[], timeoutMs: number): Promise<RosterExecResult> {
  return new Promise((resolve) => {
    execFile(argv[0] ?? '', argv.slice(1), {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        USERPROFILE: process.env['USERPROFILE'] ?? '',
        LANG: 'C',
        TMPDIR: process.env['TMPDIR'] ?? '/tmp',
      },
    }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const missing = err?.code === 'ENOENT';
      const timedOut = err?.code === 'ETIMEDOUT' || err?.killed === true;
      const exit = typeof err?.code === 'number' ? err.code : (error ? 1 : 0);
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: missing || timedOut ? null : exit,
        timedOut,
        missing,
      });
    });
  });
}

async function defaultFetchLoopback(url: string, timeoutMs: number): Promise<{ status: number; body: string } | { unavailable: true }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { unavailable: true };
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return { unavailable: true };
  if (parsed.pathname !== '/api/ps' && parsed.pathname !== '/v1/models') return { unavailable: true };
  try {
    const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const body = (await response.text()).slice(0, 1_000_000);
    return { status: response.status, body };
  } catch {
    return { unavailable: true };
  }
}

async function defaultListDevinCloud(): Promise<DevinSessionPage | { unavailable: string }> {
  try {
    const connected = await connectedClient();
    if ('error' in connected) return { unavailable: connected.error };
    return await connected.client.listSessions(connected.orgId, { first: 50 });
  } catch {
    return { unavailable: 'Devin cloud sessions could not be read.' };
  }
}

function fromDevin(row: DevinSession): RosterSession | null {
  return session({
    provider: 'devin-cloud',
    sessionId: row.sessionId,
    title: row.title,
    state: row.status,
    ownership: row.userId ?? row.orgId ?? null,
    claims: [],
    lastActivity: null,
    blockers: row.statusDetail ? [row.statusDetail] : [],
  });
}

/** Claude Code `claude agents --json`: pid, cwd, kind, startedAt, plus sessionId, name, and status when set. */
export function parseClaudeAgentsJson(raw: string): RosterSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const sessions: RosterSession[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const sessionId = typeof row['sessionId'] === 'string' && row['sessionId'].trim()
      ? row['sessionId']
      : typeof row['pid'] === 'number' && Number.isSafeInteger(row['pid'])
        ? `pid:${row['pid']}`
        : null;
    if (!sessionId) return null;
    const status = typeof row['status'] === 'string' ? row['status'] : null;
    const kind = typeof row['kind'] === 'string' ? row['kind'] : null;
    const blockers = status === 'waiting' && typeof row['waitingFor'] === 'string' ? [row['waitingFor']] : [];
    const next = session({
      provider: 'claude',
      sessionId,
      title: typeof row['name'] === 'string' ? row['name'] : null,
      state: status ?? kind ?? 'active',
      ownership: null,
      claims: [],
      lastActivity: typeof row['startedAt'] === 'string' ? row['startedAt'] : null,
      blockers,
    });
    if (!next) return null;
    sessions.push(next);
  }
  return sessions;
}

/** Ollama GET /api/ps on loopback. `models` are the models loaded right now. */
export function parseOllamaPs(raw: unknown): RosterSession[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const models = (raw as Record<string, unknown>)['models'];
  if (!Array.isArray(models)) return null;
  const sessions: RosterSession[] = [];
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'] : typeof row['model'] === 'string' ? row['model'] : null;
    if (!name) return null;
    const next = session({
      provider: 'ollama',
      sessionId: name,
      title: name,
      state: 'running',
      ownership: null,
      claims: [],
      lastActivity: null,
      blockers: [],
    });
    if (!next) return null;
    sessions.push(next);
  }
  return sessions;
}

/** oMLX OpenAI-compatible GET /v1/models on loopback. A listed model is status, not a live generation. */
export function parseOmlxModels(raw: unknown): RosterSession[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = (raw as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) return null;
  const sessions: RosterSession[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row['id'] !== 'string') return null;
    const next = session({
      provider: 'omlx',
      sessionId: row['id'],
      title: row['id'],
      state: 'listed',
      ownership: typeof row['owned_by'] === 'string' ? row['owned_by'] : null,
      claims: [],
      lastActivity: null,
      blockers: [],
    });
    if (!next) return null;
    sessions.push(next);
  }
  return sessions;
}


export const DEVIN_CLI_ROSTER_SCHEMA = 'ashlr.devin-session-roster.v1' as const;

/** Parse the Phantom-owned Devin CLI roster. Never calls the Devin API or `devin list`. */
export function parseDevinCliRoster(raw: string): RosterSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const bag = parsed as Record<string, unknown>;
  if (bag['schema'] !== DEVIN_CLI_ROSTER_SCHEMA) return null;
  if (!Array.isArray(bag['sessions'])) return null;
  const sessions: RosterSession[] = [];
  for (const item of bag['sessions']) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const sourceKind = row['sourceKind'] === 'cloud' || row['sourceKind'] === 'local' ? row['sourceKind'] : null;
    if (!sourceKind) continue;
    const next = session({
      provider: 'devin-desktop',
      sessionId: typeof row['id'] === 'string' ? row['id'] : '',
      title: typeof row['title'] === 'string' ? row['title'] : null,
      state: typeof row['status'] === 'string' ? row['status'] : '',
      ownership: typeof row['org'] === 'string' ? row['org'] : null,
      claims: [],
      lastActivity: typeof row['created'] === 'string' ? row['created'] : null,
      blockers: [],
      sourceKind,
      url: typeof row['url'] === 'string' ? row['url'] : undefined,
      org: typeof row['org'] === 'string' ? row['org'] : undefined,
      created: typeof row['created'] === 'string' ? row['created'] : undefined,
    });
    if (next) sessions.push(next);
  }
  return sessions;
}

async function defaultReadDevinCliRoster(): Promise<string | null> {
  try {
    return await readFile(join(homedir(), '.ashlr-runs', 'queue', 'devin-session-roster.json'), 'utf8');
  } catch {
    return null;
  }
}

interface ProbeCtx {
  observedAt: string;
  timeoutMs: number;
  deps: Required<Pick<AgentRosterDeps, 'exec' | 'fetchLoopback' | 'listPhantom' | 'listDevinCloud' | 'readDevinCliRoster'>>;
}

async function probePhantom(ctx: ProbeCtx): Promise<RosterSource> {
  const snap = await ctx.deps.listPhantom();
  if (snap.sourceState !== 'healthy') return unknown('phantom', ctx.observedAt, 'process table unavailable');
  const sessions = snap.workers.flatMap((worker) => {
    const next = session({
      provider: 'phantom',
      sessionId: worker.job,
      title: worker.repo,
      state: 'running',
      ownership: worker.lane,
      claims: [],
      lastActivity: ctx.observedAt,
      blockers: [],
    });
    return next ? [next] : [];
  });
  return known('phantom', ctx.observedAt, sessions);
}

async function probeDevinCloud(ctx: ProbeCtx): Promise<RosterSource> {
  const page = await ctx.deps.listDevinCloud();
  if ('unavailable' in page) {
    const reason = text(page.unavailable, 240) ?? 'Devin cloud sessions could not be read.';
    return unknown('devin-cloud', ctx.observedAt, reason.includes('[REDACTED]') ? 'Devin cloud sessions could not be read.' : reason);
  }
  const sessions = page.items.flatMap((item) => {
    const next = fromDevin(item);
    return next ? [next] : [];
  });
  return known('devin-cloud', ctx.observedAt, sessions, page.hasNextPage === true);
}

async function probeDevinDesktop(ctx: ProbeCtx): Promise<RosterSource> {
  const raw = await ctx.deps.readDevinCliRoster();
  if (raw === null) return unknown('devin-desktop', ctx.observedAt, DEVIN_DESKTOP_MISSING);
  const sessions = parseDevinCliRoster(raw);
  if (!sessions) return unknown('devin-desktop', ctx.observedAt, DEVIN_DESKTOP_UNREADABLE);
  return known('devin-desktop', ctx.observedAt, sessions, sessions.length > MAX_SESSIONS);
}

async function probeCodex(ctx: ProbeCtx): Promise<RosterSource> {
  const help = await ctx.deps.exec(['codex', 'agents', '--help'], ctx.timeoutMs);
  if (help.missing) return unknown('codex', ctx.observedAt, 'codex is not on PATH');
  if (help.timedOut) return unknown('codex', ctx.observedAt, 'timed out');
  if (help.code !== 0 && !/agents/.test(helpOf(help))) return unknown('codex', ctx.observedAt, 'codex agents is not advertised by --help');
  return unknown('codex', ctx.observedAt, CODEX_UNKNOWN);
}

async function probeClaude(ctx: ProbeCtx): Promise<RosterSource> {
  const help = await ctx.deps.exec(['claude', 'agents', '--help'], ctx.timeoutMs);
  if (help.missing) return unknown('claude', ctx.observedAt, 'claude is not on PATH');
  if (help.timedOut) return unknown('claude', ctx.observedAt, 'timed out');
  if (!/--json/.test(helpOf(help))) return unknown('claude', ctx.observedAt, 'claude agents does not advertise --json');
  const listed = await ctx.deps.exec(['claude', 'agents', '--json'], ctx.timeoutMs);
  if (listed.missing) return unknown('claude', ctx.observedAt, 'claude is not on PATH');
  if (listed.timedOut) return unknown('claude', ctx.observedAt, 'timed out');
  if (listed.code !== 0) return unknown('claude', ctx.observedAt, 'claude agents --json failed');
  const sessions = parseClaudeAgentsJson(listed.stdout);
  if (!sessions) return unknown('claude', ctx.observedAt, 'unrecognized output');
  return known('claude', ctx.observedAt, sessions);
}

async function probeCursor(ctx: ProbeCtx): Promise<RosterSource> {
  const help = await ctx.deps.exec(['cursor-agent', 'ls', '--help'], ctx.timeoutMs);
  if (help.timedOut) return unknown('cursor', ctx.observedAt, 'timed out');
  if (help.missing) {
    const agent = await ctx.deps.exec(['agent', '--help'], ctx.timeoutMs);
    if (agent.timedOut) return unknown('cursor', ctx.observedAt, 'timed out');
    if (agent.missing || !/Cursor/.test(helpOf(agent))) return unknown('cursor', ctx.observedAt, 'cursor-agent is not on PATH');
  }
  return unknown('cursor', ctx.observedAt, CURSOR_UNKNOWN);
}

async function probeGrok(ctx: ProbeCtx): Promise<RosterSource> {
  const help = await ctx.deps.exec(['grok', 'sessions', 'list', '--help'], ctx.timeoutMs);
  if (help.missing) return unknown('grok', ctx.observedAt, 'grok is not on PATH');
  if (help.timedOut) return unknown('grok', ctx.observedAt, 'timed out');
  if (help.code !== 0 && !/sessions/.test(helpOf(help))) return unknown('grok', ctx.observedAt, 'grok sessions list is not advertised by --help');
  return unknown('grok', ctx.observedAt, GROK_UNKNOWN);
}

async function probeHttp(sourceId: 'ollama' | 'omlx', url: string, parse: (raw: unknown) => RosterSession[] | null, ctx: ProbeCtx): Promise<RosterSource> {
  const response = await ctx.deps.fetchLoopback(url, ctx.timeoutMs);
  if ('unavailable' in response) return unknown(sourceId, ctx.observedAt, 'loopback status unavailable');
  if (response.status < 200 || response.status >= 300) return unknown(sourceId, ctx.observedAt, 'loopback status unavailable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return unknown(sourceId, ctx.observedAt, 'unrecognized output');
  }
  const sessions = parse(parsed);
  if (!sessions) return unknown(sourceId, ctx.observedAt, 'unrecognized output');
  return known(sourceId, ctx.observedAt, sessions);
}

const PROBES: Record<RosterSourceId, (ctx: ProbeCtx) => Promise<RosterSource>> = {
  phantom: probePhantom,
  'devin-cloud': probeDevinCloud,
  'devin-desktop': probeDevinDesktop,
  codex: probeCodex,
  claude: probeClaude,
  cursor: probeCursor,
  grok: probeGrok,
  ollama: (ctx) => probeHttp('ollama', OLLAMA_PS_URL, parseOllamaPs, ctx),
  omlx: (ctx) => probeHttp('omlx', OMLX_MODELS_URL, parseOmlxModels, ctx),
};

function attachClaims(sessions: RosterSession[], claims: RosterClaimRef[]): RosterSession[] {
  return sessions.map((item) => ({
    ...item,
    claims: claims.filter((claim) => claim.id === item.sessionId),
  }));
}

async function runBounded(sourceId: RosterSourceId, observedAt: string, timeoutMs: number, work: () => Promise<RosterSource>): Promise<RosterSource> {
  try {
    const result = await withTimeout(work(), timeoutMs);
    if (result === 'timeout') return unknown(sourceId, observedAt, 'timed out');
    if (result.availability !== 'known') return { ...result, ok: false, availability: 'unknown', sessions: [] };
    return { ...result, ok: true, error: null };
  } catch {
    return unknown(sourceId, observedAt, 'unavailable');
  }
}

export async function collectAgentRoster(deps: AgentRosterDeps = {}): Promise<AgentRoster> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? ROSTER_PROBE_TIMEOUT_MS;
  const started = now();
  let observedAt: string;
  try {
    observedAt = new Date(started).toISOString();
  } catch {
    observedAt = new Date(0).toISOString();
  }
  const ctx: ProbeCtx = {
    observedAt,
    timeoutMs,
    deps: {
      exec: deps.exec ?? defaultExec,
      fetchLoopback: deps.fetchLoopback ?? defaultFetchLoopback,
      listPhantom: deps.listPhantom ?? (() => listLiveWorkers()),
      listDevinCloud: deps.listDevinCloud ?? defaultListDevinCloud,
      readDevinCliRoster: deps.readDevinCliRoster ?? defaultReadDevinCliRoster,
    },
  };
  const sources = await Promise.all(ROSTER_SOURCES.map((sourceId) => runBounded(
    sourceId,
    observedAt,
    timeoutMs,
    () => PROBES[sourceId](ctx),
  )));
  let claims: AgentRoster['claims'];
  try {
    const inspection = (deps.readClaims ?? readRosterClaims)();
    claims = {
      source: inspection.source,
      items: inspection.claims.flatMap((row) => {
        const next = claimRef(row, inspection.source);
        return next ? [next] : [];
      }),
    };
  } catch {
    claims = { source: 'unavailable', items: [] };
  }
  const sessions = attachClaims(
    sources.flatMap((item) => item.sessions),
    claims.items,
  );
  const byId = new Map(sessions.map((item) => [`${item.provider}\0${item.sessionId}`, item]));
  const finished = now();
  return {
    schema: AGENT_ROSTER_SCHEMA,
    observedAt,
    latencyMs: Number.isSafeInteger(finished) && Number.isSafeInteger(started) ? Math.max(0, finished - started) : 0,
    sources: sources.map((item) => ({
      ...item,
      sessions: item.sessions.map((row) => byId.get(`${row.provider}\0${row.sessionId}`) ?? row),
    })),
    sessions,
    claims,
  };
}

export function formatAgentRoster(roster: AgentRoster): string {
  const lines = [
    `Agent roster ${roster.schema}`,
    `observed ${roster.observedAt}  latency ${roster.latencyMs}ms  sources ${roster.sources.length}`,
    '',
    'provider  session  title  state  owner  claims  last activity  blockers',
  ];
  if (roster.sessions.length === 0) lines.push('(no known sessions)');
  for (const item of roster.sessions) {
    lines.push([
      item.provider,
      item.sessionId,
      item.title ?? '',
      item.state,
      item.ownership ?? '',
      String(item.claims.length),
      item.lastActivity ?? '',
      item.blockers.join('; '),
    ].join('  '));
  }
  lines.push('', 'sources');
  for (const item of roster.sources) {
    lines.push(`${item.source}  ${item.availability}${item.error ? `  ${item.error}` : ''}`);
  }
  lines.push('', `claims  ${roster.claims.source}  ${roster.claims.items.length}`);
  return lines.join('\n');
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSession(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!ROSTER_SOURCES.includes(row['provider'] as RosterSourceId)) return false;
  if (typeof row['sessionId'] !== 'string' || !row['sessionId']) return false;
  if (!(row['title'] === null || typeof row['title'] === 'string')) return false;
  if (typeof row['state'] !== 'string' || !row['state']) return false;
  if (!(row['ownership'] === null || typeof row['ownership'] === 'string')) return false;
  if (!(row['lastActivity'] === null || typeof row['lastActivity'] === 'string')) return false;
  if (!Array.isArray(row['blockers']) || row['blockers'].some((item) => typeof item !== 'string')) return false;
  if (row['sourceKind'] !== undefined && row['sourceKind'] !== 'local' && row['sourceKind'] !== 'cloud') return false;
  if (row['url'] !== undefined && typeof row['url'] !== 'string') return false;
  if (row['org'] !== undefined && typeof row['org'] !== 'string') return false;
  if (row['created'] !== undefined && typeof row['created'] !== 'string') return false;
  if (!Array.isArray(row['claims'])) return false;
  return row['claims'].every((claim) => {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return false;
    const item = claim as Record<string, unknown>;
    return (item['store'] === 'claim-store' || item['store'] === 'bus-work-fallback')
      && typeof item['id'] === 'string'
      && typeof item['owner'] === 'string'
      && (item['leaseUntil'] === null || typeof item['leaseUntil'] === 'string')
      && typeof item['completed'] === 'boolean';
  });
}

/** Null when the roster matches agent-roster.v1. Otherwise a short field code. */
export function validateAgentRoster(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'roster';
  const roster = value as Record<string, unknown>;
  if (roster['schema'] !== AGENT_ROSTER_SCHEMA) return 'schema';
  if (!isIso(roster['observedAt'])) return 'observedAt';
  if (!Number.isSafeInteger(roster['latencyMs']) || (roster['latencyMs'] as number) < 0) return 'latencyMs';
  if (!Array.isArray(roster['sources']) || roster['sources'].length !== ROSTER_SOURCES.length) return 'sources';
  for (let i = 0; i < ROSTER_SOURCES.length; i += 1) {
    const item = roster['sources'][i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'source';
    const source = item as Record<string, unknown>;
    if (source['source'] !== ROSTER_SOURCES[i]) return 'source.id';
    if (source['availability'] !== 'known' && source['availability'] !== 'unknown') return 'source.availability';
    if (typeof source['ok'] !== 'boolean' || source['ok'] !== (source['availability'] === 'known')) return 'source.ok';
    if (!(source['error'] === null || typeof source['error'] === 'string')) return 'source.error';
    if (source['availability'] === 'unknown' && source['error'] === null) return 'source.error';
    if (source['availability'] === 'known' && source['error'] !== null) return 'source.error';
    if (!isIso(source['observedAt'])) return 'source.observedAt';
    if (typeof source['truncated'] !== 'boolean') return 'source.truncated';
    if (!Array.isArray(source['sessions']) || !source['sessions'].every(isSession)) return 'source.sessions';
    if (source['availability'] === 'unknown' && source['sessions'].length !== 0) return 'source.sessions';
  }
  if (!Array.isArray(roster['sessions']) || !roster['sessions'].every(isSession)) return 'sessions';
  const claims = roster['claims'];
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return 'claims';
  const bag = claims as Record<string, unknown>;
  if (bag['source'] !== 'missing' && bag['source'] !== 'claim-store' && bag['source'] !== 'bus-work-fallback' && bag['source'] !== 'unavailable') return 'claims.source';
  if (!Array.isArray(bag['items'])) return 'claims.items';
  return null;
}
