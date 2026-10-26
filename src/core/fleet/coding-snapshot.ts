/** Versioned, read-only coding fleet projection. Unknown is null, never zero. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadSchedulerConfig, type SchedulerConfig } from '../providers/coding-cli/scheduler/defaults.js';
import { parseRouterDecision } from '../providers/coding-cli/scheduler/log.js';
import { readOutcomes, computeRegret } from '../providers/coding-cli/scheduler/regret.js';
import { emptyBandit, updateBandit } from '../providers/coding-cli/scheduler/learn.js';
import { readFleetBoard } from './coordination.js';
import { parseSpendDecision } from '../providers/coding-cli/ledger.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { redactKnownValues, scrubPrivateText } from '../util/scrub.js';
export const FLEET_POOL_IDS = ['grok-ultra-weekly', 'codex-cmp', 'codex-personal', 'claude-max', 'devin', 'grok-build', 'cursor', 'omlx'] as const;
export type FleetPoolId = (typeof FLEET_POOL_IDS)[number];
const REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin'].map((name) => `ashlrai/${name}`);
const MAX_BYTES = 4 * 1024 * 1024;
const execute = promisify(execFile);
const ALIASES: Record<string, FleetPoolId> = {
  'codex-primary': 'codex-cmp',
  'codex-secondary': 'codex-personal',
  'codex:codex-primary': 'codex-cmp',
  'codex:codex-secondary': 'codex-personal',
  claude: 'claude-max',
  'claude-max': 'claude-max',
  local: 'omlx',
  'local-omlx': 'omlx',
  'devin-acu': 'devin',
  'grok-build-tokens': 'grok-build'
};
type Row = Record<string, unknown>;
type State = 'known' | 'unknown' | 'partial';
export interface FleetReading {
  pool: FleetPoolId;
  used_pct: number;
  at: string;
  source: 'manual';
  age_seconds: number;
}
export interface FleetWindow {
  pool: FleetPoolId;
  start: string;
  reset: string;
  reset_every_days: number | null;
  timezone: string | null;
}
export interface FleetPoint {
  at: string;
  used_pct: number;
}
export interface CodingFleetPool {
  id: FleetPoolId;
  shared_with: FleetPoolId | null;
  source: 'manual' | 'estimate' | 'unknown';
  used_pct: number | null;
  remaining_pct: number | null;
  reading_at: string | null;
  age_seconds: number | null;
  reset_at: string | null;
  window_start: string | null;
  burn_pct_per_hour: number | null;
  runway_hours: number | null;
  ideal_pct: number | null;
  projected_pct: number | null;
  uncertainty: 'linear estimate; future usage unknown' | 'unknown';
  actual: FleetPoint[];
  ideal: FleetPoint[];
  planner: FleetPoint[];
}
export interface FleetPullRequest {
  number: number;
  state: 'open' | 'merged';
  title: string;
  url: string;
  ci: 'passed' | 'failed' | 'pending' | 'unknown';
  cost: {
    pool: FleetPoolId;
    value: number;
    unit: 'pool-unit';
  }[] | null;
}
export interface FleetRepo {
  repo: string;
  source: State;
  open: FleetPullRequest[] | null;
  merged: FleetPullRequest[] | null;
  complete: boolean;
}
export interface FleetAgent {
  agent: string;
  repo: string;
  task: string;
  claim_id: string | null;
  expires_at: string | null;
}
export interface CodingFleetSnapshot {
  schema: 'fleet.v1';
  generated_at: string;
  readings: FleetReading[];
  windows: FleetWindow[];
  pools: CodingFleetPool[];
  router: {
    source: State;
    decisions: Row[] | null;
    regret: Row[] | null;
  };
  agents: FleetAgent[] | null;
  repos: FleetRepo[];
  coordination: {
    state: State;
    claims: Row[];
    messages: Row[];
    proposals: Row[];
    expiredClaims: number | null;
  };
  sources: {
    shared: State;
    github: State;
    spend: State;
    router: State;
    planner: State;
  };
}
const snapshotSources = new WeakMap<CodingFleetSnapshot, { path: string; digest: string | null }>();
function sourceDigest(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text).digest('hex');
}
export interface CodingFleetOptions {
  path?: string;
  nowMs?: number;
  home?: string;
  schedulerConfig?: SchedulerConfig;
  gh?: (args: string[]) => Promise<unknown>;
  fetchGithub?: boolean;
  coordination?: unknown;
  knownSecrets?: readonly string[];
}
export function codingFleetPath(): string {
  return process.env['PHANTOM_FLEET_PATH'] ?? join(process.env['ASHLR_HOME'] ?? join(homedir(), '.ashlr'), 'fleet', 'fleet.json');
}
function row(v: unknown): Row {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v.slice(0, 1000) : [];
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
function date(v: unknown): string | null {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}
function pool(v: unknown): FleetPoolId | null {
  return typeof v === 'string' ? ALIASES[v] ?? (FLEET_POOL_IDS.includes(v as FleetPoolId) ? v as FleetPoolId : null) : null;
}
function state(v: unknown): State {
  return v === 'known' || v === 'partial' ? v : 'unknown';
}
interface PublicTextContext {
  environmentValues: string[];
  cache: Map<string, string>;
}
const textContexts = new WeakMap<readonly string[], PublicTextContext>();
function secrets(extra: readonly string[] = []): string[] {
  const entries = Object.entries(process.env);
  const deny = [...extra, ...entries.filter(([key]) => /key|token|secret|password|credential|auth/i.test(key))
      .map(([, value]) => value ?? '')].filter((value) => value.length > 0);
  textContexts.set(deny, {
    environmentValues: entries.map(([, value]) => value ?? '').filter((value) => value.length >= 8),
    cache: new Map(),
  });
  return deny;
}
function safe(value: unknown, deny: readonly string[], max = 240): string {
  if (typeof value !== 'string')
    return '';
  const context = textContexts.get(deny);
  const cacheKey = `${max}:${value}`;
  const cached = context?.cache.get(cacheKey);
  if (cached !== undefined)
    return cached;
  let text = value;
  // Nonsecret environment values are removed literally: substring redaction
  // would erase harmless repo names that also occur inside PWD.
  for (const environmentValue of context?.environmentValues ?? [])
    text = text.split(environmentValue).join('[REDACTED]');
  for (const secret of deny)
    text = text.split(secret).join('[REDACTED]');
  text = redactKnownValues(scrubPrivateText(text, {
    emails: true
  }), deny);
  const result = Array.from(text, (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('').slice(0, max);
  context?.cache.set(cacheKey, result);
  return result;
}
/** Pin a bounded regular-file snapshot. NONBLOCK closes the lstat-to-open FIFO race. */
function readText(file: string): string | null {
  let fd: number | undefined;
  try {
    const target = resolve(file);
    const parent = dirname(target);
    const directory = lstatSync(parent);
    const realParent = realpathSync(parent);
    const before = lstatSync(target);
    const owned = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();
    if (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory.uid) || (directory.mode & 0o022) !== 0 ||
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !owned(before.uid) || (before.mode & 0o022) !== 0 || before.size > MAX_BYTES)
      return null;
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > MAX_BYTES)
      return null;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0)
        return null;
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0)
      return null;
    const after = fstatSync(fd);
    const named = lstatSync(target);
    const parentAfter = lstatSync(parent);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      named.dev !== after.dev || named.ino !== after.ino || !named.isFile() || named.nlink !== 1 || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs ||
      !parentAfter.isDirectory() || parentAfter.isSymbolicLink() || parentAfter.dev !== directory.dev || parentAfter.ino !== directory.ino || parentAfter.mtimeMs !== directory.mtimeMs || parentAfter.ctimeMs !== directory.ctimeMs || realpathSync(parent) !== realParent)
      return null;
    return buffer.toString('utf8');
  }
  catch {
    return null;
  }
  finally {
    if (fd !== undefined)
      closeSync(fd);
  }
}
function json(text: string | null): Row {
  try {
    return row(JSON.parse(text ?? ''));
  }
  catch {
    return {};
  }
}
function readings(v: unknown, now: number): FleetReading[] {
  return (Array.isArray(v) ? v.slice(-1000) : []).flatMap((item) => {
    const r = row(item);
    const id = pool(r.pool);
    const used = num(r.used_pct);
    const at = date(r.at);
    return id && used !== null && used <= 100 && at && Date.parse(at) <= now && r.source === 'manual'
      ? [{
          pool: id,
          used_pct: used,
          at,
          source: 'manual' as const,
          age_seconds: Math.floor((now - Date.parse(at)) / 1000)
        }] : [];
  }).sort((a, b) => a.at.localeCompare(b.at));
}
function points(v: unknown): FleetPoint[] {
  return list(v).flatMap((item) => {
    const r = row(item);
    const at = date(r.at);
    const used = num(r.used_pct);
    return at && used !== null ? [{
        at,
        used_pct: used
      }] : [];
  }).sort((a, b) => a.at.localeCompare(b.at));
}
/** Weekly wall-clock recurrence follows the configured timezone through DST. */
function shiftDays(ms: number, days: number, zone: string | null): number {
  if (!zone)
    return ms + days * 86400000;
  try {
    const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(t).map((p) => [p.type, p.value]));
    const p = parts(ms);
    const target = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + days, Number(p.hour), Number(p.minute), Number(p.second));
    let candidate = target;
    for (let i = 0; i < 3; i++) {
      const q = parts(candidate);
      const local = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute), Number(q.second));
      candidate += target - local;
    }
    return candidate;
  }
  catch {
    return NaN;
  }
}
function windows(v: unknown, config: SchedulerConfig, now: number): FleetWindow[] {
  const base: unknown[] = [{
      pool: 'grok-ultra-weekly',
      reset: config.grokUltraWeekly.resetAt,
      reset_every_days: config.grokUltraWeekly.resetEveryDays,
      timezone: config.grokUltraWeekly.resetTimezone
    }, ...list(v)];
  const byPool = new Map<FleetPoolId, FleetWindow>();
  for (const item of base) {
    const r = row(item);
    const id = pool(r.pool);
    const reset = date(r.reset);
    const days = num(r.reset_every_days);
    const timezone = typeof r.timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(r.timezone) ? r.timezone : null;
    if (!id || !reset)
      continue;
    let end = Date.parse(reset);
    let start = date(r.start) ? Date.parse(String(r.start)) : days !== null && days > 0 ? shiftDays(end, -days, timezone) : NaN;
    if (days !== null && days > 0 && days <= 366) {
      let steps = 0;
      while (end <= now && steps++ < 1000) {
        start = end;
        end = shiftDays(end, days, timezone);
      }
    }
    if (!Number.isFinite(start) || start >= end || end <= now || start > now)
      continue;
    byPool.set(id, {
      pool: id,
      start: new Date(start).toISOString(),
      reset: new Date(end).toISOString(),
      reset_every_days: days,
      timezone
    });
  }
  return [...byPool.values()];
}
function buildPools(readingRows: FleetReading[], windowRows: FleetWindow[], config: SchedulerConfig, now: number, planner: unknown): CodingFleetPool[] {
  return FLEET_POOL_IDS.map((id) => {
    const shared = id === 'cursor' ? 'grok-ultra-weekly' as const : null;
    const w = windowRows.find((r) => r.pool === (shared ?? id));
    const actual = readingRows.filter((r) => r.pool === id && (!w || Date.parse(r.at) >= Date.parse(w.start))).map(({ at, used_pct }) => ({
      at,
      used_pct
    }));
    const latest = actual.at(-1);
    let used = latest?.used_pct ?? null;
    let at = latest?.at ?? null;
    let source: CodingFleetPool['source'] = latest ? 'manual' : 'unknown';
    if (!latest && id === 'grok-ultra-weekly') {
      const stamp = Date.parse(config.grokUltraWeekly.usedFractionAsOf);
      if (w && stamp >= Date.parse(w.start) && stamp <= now && stamp < Date.parse(w.reset)) {
        // The scheduler's snapshot is reused only within the DST-aware window.
        used = config.grokUltraWeekly.usedFraction * 100;
        at = new Date(stamp).toISOString();
        source = 'estimate';
      }
    }
    const previous = actual.length >= 2 ? actual[actual.length - 2] : undefined;
    // No quota consumption is invented between manual observations. Two points
    // are necessary for a rate, even when the reset time is known.
    const elapsed = latest && previous ? (Date.parse(latest.at) - Date.parse(previous.at)) / 3600000 : 0;
    const burn = latest && previous && elapsed > 0 && latest.used_pct >= previous.used_pct ? (latest.used_pct - previous.used_pct) / elapsed : null;
    const ideal = w ? Math.max(0, Math.min(100, (now - Date.parse(w.start)) / (Date.parse(w.reset) - Date.parse(w.start)) * 100)) : null;
    const projected = used !== null && burn !== null && w && at ? used + burn * (Date.parse(w.reset) - Date.parse(at)) / 3600000 : null;
    return {
      id,
      shared_with: shared,
      source,
      used_pct: used,
      remaining_pct: used === null ? null : 100 - used,
      reading_at: at,
      age_seconds: at ? Math.floor((now - Date.parse(at)) / 1000) : null,
      reset_at: w?.reset ?? null,
      window_start: w?.start ?? null,
      burn_pct_per_hour: burn,
      runway_hours: used !== null && burn !== null && burn > 0 ? Math.max(0, (100 - used) / burn - (at ? (now - Date.parse(at)) / 3600000 : 0)) : null,
      ideal_pct: ideal,
      projected_pct: projected,
      uncertainty: projected === null ? 'unknown' : 'linear estimate; future usage unknown',
      actual,
      ideal: w ? [{
          at: w.start,
          used_pct: 0
        }, {
          at: w.reset,
          used_pct: 100
        }] : [],
      planner: points(row(planner)[id])
    };
  });
}
function publicCoordination(value: unknown, deny: readonly string[], now: number): CodingFleetSnapshot['coordination'] {
  const r = row(value);
  const clean = (v: unknown, keys: string[]) => list(v).filter((item) => {
    const expires = date(row(item).expiresAt);
    return expires !== null && Date.parse(expires) > now;
  }).map((item) => {
    const input = row(item);
    return Object.fromEntries(keys.map((key) => [key, ['at', 'claimedAt', 'expiresAt'].includes(key) ? date(input[key]) : safe(input[key], deny, key === 'body' ? 2000 : 240)]));
  });
  return {
    state: state(r.state),
    claims: clean(r.claims, ['id', 'repo', 'task', 'agent', 'claimedAt', 'expiresAt']),
    messages: clean(r.messages, ['id', 'from', 'to', 'body', 'at', 'expiresAt']),
    proposals: clean(r.proposals, ['id', 'repo', 'task', 'to', 'at', 'expiresAt']),
    expiredClaims: num(r.expiredClaims)
  };
}
function ci(value: unknown): FleetPullRequest['ci'] {
  const checks = list(value);
  if (!checks.length)
    return 'unknown';
  const values = checks.map((v) => row(v));
  if (values.some((v) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'failure', 'error'].includes(String(v.conclusion ?? v.state))))
    return 'failed';
  if (values.some((v) => ['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED', 'pending'].includes(String(v.status ?? v.state))))
    return 'pending';
  return values.every((v) => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'success'].includes(String(v.conclusion ?? v.state))) ? 'passed' : 'unknown';
}
function costs(v: unknown): FleetPullRequest['cost'] {
  const values = list(v).flatMap((item) => {
    const r = row(item);
    const id = pool(r.pool);
    const value = num(r.value);
    return id && value !== null && r.unit === 'pool-unit' ? [{
        pool: id,
        value,
        unit: 'pool-unit' as const
      }] : [];
  });
  return values.length ? values : null;
}
function publicPr(v: unknown, status: 'open' | 'merged', repo: string, deny: readonly string[], ledger?: Row[]): FleetPullRequest | null {
  const r = row(v);
  const n = num(r.number);
  if (n === null || !Number.isSafeInteger(n) || n < 1)
    return null;
  let cost = costs(r.cost);
  if (ledger) {
    const matched = ledger.filter((l) => l.repo === repo && l.pr === n);
    const grouped = new Map<FleetPoolId, number>();
    let unknown = false;
    for (const l of matched) {
      const id = pool(l.poolId);
      const value = num(l.cost);
      if (!id || value === null)
        unknown = true;
      else
        grouped.set(id, (grouped.get(id) ?? 0) + value);
    }
    cost = matched.length && !unknown ? [...grouped].map(([id, value]) => ({
      pool: id,
      value,
      unit: 'pool-unit'
    })) : null;
  }
  return {
    number: n,
    state: status,
    title: safe(r.title, deny),
    url: `https://github.com/${repo}/pull/${n}`,
    ci: ['passed', 'failed', 'pending', 'unknown'].includes(String(r.ci)) ? r.ci as FleetPullRequest['ci'] : ci(r.statusCheckRollup),
    cost
  };
}
async function github(gh: (args: string[]) => Promise<unknown>, deny: readonly string[], ledger: Row[] | null): Promise<FleetRepo[]> {
  return Promise.all(REPOS.map(async (repo) => {
    const results = await Promise.allSettled((['open', 'merged'] as const).map(async (status) => {
      const value = await gh(['pr', 'list', '--repo', repo, '--state', status, '--limit', '100', '--json', 'number,title,statusCheckRollup']);
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(parsed))
        throw new Error('invalid github result');
      const prs = parsed.map((v) => publicPr(v, status, repo, deny, ledger ?? [])).filter((v): v is FleetPullRequest => v !== null);
      if (prs.length !== parsed.length)
        throw new Error('invalid github row');
      return prs;
    }));
    const open = results[0].status === 'fulfilled' ? results[0].value : null;
    const merged = results[1].status === 'fulfilled' ? results[1].value : null;
    return {
      repo,
      source: open && merged ? 'known' : open || merged ? 'partial' : 'unknown',
      open,
      merged,
      complete: open !== null && merged !== null && open.length < 100 && merged.length < 100
    };
  }));
}
export async function buildCodingFleetSnapshot(options: CodingFleetOptions = {}): Promise<CodingFleetSnapshot> {
  const now = options.nowMs ?? Date.now();
  const file = resolve(options.path ?? codingFleetPath());
  const rawText = readText(file);
  const digest = sourceDigest(rawText);
  const input = json(rawText);
  const config = options.schedulerConfig ?? loadSchedulerConfig();
  const deny = secrets([...(options.knownSecrets ?? []), ...(config.posthog.apiKey ? [config.posthog.apiKey] : [])]);
  const home = options.home ?? process.env['ASHLR_HOME'] ?? join(homedir(), '.ashlr');
  const readingRows = readings(input.readings, now);
  const windowRows = windows(input.windows, config, now);
  const routerText = readText(join(home, 'router', 'decisions.jsonl'));
  const outcomeText = readText(join(home, 'router', 'outcomes.jsonl'));
  const decisions = routerText === null ? null : routerText.split('\n').filter((s) => s.trim()).map(parseRouterDecision);
  const routerBad = decisions?.some((v) => v === null) ?? false;
  const outcomes = outcomeText === null ? null : readOutcomes(outcomeText);
  const outcomeBad = outcomeText !== null && outcomes?.length !== outcomeText.split('\n').filter((s) => s.trim()).length;
  let bandit = emptyBandit();
  for (const outcome of outcomes ?? [])
    bandit = updateBandit(bandit, outcome);
  const regret = outcomes && !outcomeBad ? computeRegret({
    outcomes,
    bandit,
    config
  }) : null;
  const spendText = readText(join(home, 'router', 'spend.jsonl'));
  const spendRows = spendText === null ? null : spendText.split('\n').filter((s) => s.trim()).map((line) => {
    const parsed = parseSpendDecision(line);
    if (!parsed) return null;
    // The router owns its ledger format. Validate optional PR attribution at
    // the fleet boundary without changing the router's parser or writer.
    const identity = row(JSON.parse(line));
    const { repo, pr } = identity;
    if ((repo !== undefined || pr !== undefined) &&
      (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ||
        typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1)) return null;
    return { ...parsed, ...(typeof repo === 'string' && typeof pr === 'number' ? { repo, pr } : {}) };
  });
  const spendBad = spendRows?.some((v) => v === null) ?? false;
  const ledger = spendBad ? null : spendRows as Row[] | null;
  const runGh = options.gh ?? (async (args: string[]) => {
    const result = await execute('gh', args, {
      timeout: 10000,
      maxBuffer: MAX_BYTES,
      encoding: 'utf8'
    });
    return result.stdout;
  });
  const repos = options.fetchGithub === false ? REPOS.map((repo): FleetRepo => ({
    repo,
    source: 'unknown',
    open: null,
    merged: null,
    complete: false
  })) : await github(runGh, deny, ledger);
  const coordination = publicCoordination(options.coordination ?? readFleetBoard({
    now,
    ...(options.home ? {
      path: join(home, 'fleet', 'coordination.jsonl')
    } : {})
  }), deny, now);
  const agentText = readText(join(home, 'verse', 'agents', 'agents.json'));
  const storedAgents = json(agentText);
  const agents: FleetAgent[] = coordination.claims.map((claim) => ({
    agent: String(claim.agent),
    repo: String(claim.repo),
    task: String(claim.task),
    claim_id: String(claim.id),
    expires_at: date(claim.expiresAt)
  }));
  for (const item of list(storedAgents.agents)) {
    const a = row(item);
    if (typeof a.id !== 'string' || !/^ag_[a-z0-9]{8,32}$/.test(a.id) || a.archived || agents.some((agent) => agent.agent === a.id))
      continue;
    // A checkout basename does not establish its canonical GitHub origin.
    agents.push({
      agent: safe(a.id, deny),
      repo: 'unknown',
      task: 'unknown',
      claim_id: null,
      expires_at: null
    });
  }
  const routerState: State = routerText !== null && !routerBad && outcomeText !== null && !outcomeBad ? 'known' : routerText !== null || outcomeText !== null ? 'partial' : 'unknown';
  const snapshot = sanitizeSnapshot({
    schema: 'fleet.v1',
    generated_at: new Date(now).toISOString(),
    readings: readingRows,
    windows: windowRows,
    pools: buildPools(readingRows, windowRows, config, now, Object.keys(row(row(input.planner).series)).length ? row(input.planner).series : Object.fromEntries(list(input.pools).map(row).map((p) => [String(p.id), p.planner]))),
    router: {
      source: routerState,
      decisions: routerBad ? null : decisions,
      regret
    },
    agents: coordination.state === 'unknown' && !Array.isArray(storedAgents.agents) ? null : agents,
    repos,
    coordination,
    sources: {
      shared: rawText === null || !Object.keys(input).length ? 'unknown' : 'known',
      github: repos.every((r) => r.source === 'known') ? 'known' : repos.some((r) => r.source !== 'unknown') ? 'partial' : 'unknown',
      spend: ledger === null ? 'unknown' : 'known',
      router: routerState,
      planner: Object.keys(row(row(input.planner).series)).length || list(input.pools).map(row).some((p) => points(p.planner).length > 0) ? 'known' : 'unknown'
    }
  }, now, deny);
  // Collection can await slow GitHub reads. Keep private source provenance off
  // the public document so a later refresh cannot overwrite an intervening edit.
  snapshotSources.set(snapshot, { path: file, digest });
  return snapshot;
}
/** Positive projection protects remote readers even if the shared file was edited. */
function sanitizeSnapshot(value: unknown, now: number, deny: readonly string[]): CodingFleetSnapshot {
  const r = row(value);
  const coordination = publicCoordination(r.coordination, deny, now);
  const router = row(r.router);
  const routerTruncated = [router.decisions, router.regret].some((rows) => Array.isArray(rows) && rows.length > 1000);
  const routerSource = routerTruncated ? 'partial' : state(router.source);
  const pools = FLEET_POOL_IDS.map((id): CodingFleetPool => {
    const p = list(r.pools).map(row).find((v) => v.id === id) ?? {};
    const numeric = (key: string) => num(p[key]);
    return {
      id,
      shared_with: id === 'cursor' ? 'grok-ultra-weekly' : null,
      source: p.source === 'manual' || p.source === 'estimate' ? p.source : 'unknown',
      used_pct: numeric('used_pct'),
      remaining_pct: numeric('remaining_pct'),
      reading_at: date(p.reading_at),
      age_seconds: date(p.reading_at) ? Math.max(0, Math.floor((now - Date.parse(String(p.reading_at))) / 1000)) : null,
      reset_at: date(p.reset_at),
      window_start: date(p.window_start),
      burn_pct_per_hour: numeric('burn_pct_per_hour'),
      runway_hours: numeric('runway_hours'),
      ideal_pct: numeric('ideal_pct'),
      projected_pct: numeric('projected_pct'),
      uncertainty: p.uncertainty === 'linear estimate; future usage unknown' ? 'linear estimate; future usage unknown' : 'unknown',
      actual: points(p.actual),
      ideal: points(p.ideal),
      planner: points(p.planner)
    };
  });
  const safeRows = (v: unknown, keys: string[]) => Array.isArray(v) ? v.slice(-1000).map((item) => {
    const itemRow = row(item);
    return Object.fromEntries(keys.map((key) => [key, key === 'grantsMergeAuthority' ? false : itemRow[key] === null ? null : typeof itemRow[key] === 'number' ? (Number.isFinite(itemRow[key]) ? itemRow[key] : null) : typeof itemRow[key] === 'boolean' ? itemRow[key] : safe(itemRow[key], deny)]));
  }) : null;
  const repos = REPOS.map((repo): FleetRepo => {
    const raw = list(r.repos).map(row).find((v) => v.repo === repo) ?? {};
    const project = (v: unknown, status: 'open' | 'merged') => Array.isArray(v) ? list(v).map((pr) => publicPr(pr, status, repo, deny)).filter((v): v is FleetPullRequest => v !== null) : null;
    return {
      repo,
      source: state(raw.source),
      open: project(raw.open, 'open'),
      merged: project(raw.merged, 'merged'),
      complete: raw.complete === true
    };
  });
  const agentRows = Array.isArray(r.agents) ? list(r.agents).filter((item) => {
    const a = row(item);
    const expiry = date(a.expires_at);
    return a.claim_id === null || expiry !== null && Date.parse(expiry) > now;
  }).map((item) => {
    const a = row(item);
    return {
      agent: safe(a.agent, deny),
      repo: safe(a.repo, deny),
      task: safe(a.task, deny),
      claim_id: typeof a.claim_id === 'string' ? safe(a.claim_id, deny) : null,
      expires_at: date(a.expires_at)
    };
  }) : null;
  const source = row(r.sources);
  return {
    schema: 'fleet.v1',
    generated_at: date(r.generated_at) ?? new Date(now).toISOString(),
    readings: readings(r.readings, now),
    windows: list(r.windows).flatMap((item) => {
      const w = row(item);
      const id = pool(w.pool);
      const start = date(w.start);
      const reset = date(w.reset);
      return id && start && reset ? [{
          pool: id,
          start,
          reset,
          reset_every_days: num(w.reset_every_days),
          timezone: typeof w.timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(w.timezone) ? w.timezone : null
        }] : [];
    }),
    pools,
    router: {
      source: routerSource,
      decisions: safeRows(router.decisions, ['ts', 'jobId', 'jobType', 'poolId', 'consumer', 'policyId', 'canary', 'propensity', 'solver', 'fallback', 'grantsMergeAuthority', 'netValue']),
      regret: safeRows(router.regret, ['jobId', 'jobType', 'chosenPool', 'chosenConsumer', 'betterPool', 'betterConsumer', 'chosenValue', 'betterValue', 'regret'])
    },
    agents: agentRows,
    repos,
    coordination,
    sources: {
      shared: state(source.shared),
      github: state(source.github),
      spend: state(source.spend),
      router: routerTruncated ? 'partial' : state(source.router),
      planner: state(source.planner)
    }
  };
}
export function readCodingFleetSnapshot(path = codingFleetPath(), options: {
  nowMs?: number;
  knownSecrets?: readonly string[];
} = {}): CodingFleetSnapshot | null {
  const raw = json(readText(path));
  if (raw.schema !== 'fleet.v1' || date(raw.generated_at) === null)
    return null;
  return sanitizeSnapshot(raw, options.nowMs ?? Date.now(), secrets(options.knownSecrets));
}
export function writeCodingFleetSnapshot(snapshot: CodingFleetSnapshot, path = codingFleetPath()): void {
  const target = resolve(path);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const before = lstatSync(parent);
  const realParent = realpathSync(parent);
  const owned = typeof process.getuid !== 'function' || before.uid === process.getuid();
  if (!before.isDirectory() || before.isSymbolicLink() || !owned || (before.mode & 0o077) !== 0) {
    throw new Error('fleet snapshot directory must be an owned private directory');
  }
  const verifyParent = () => {
    const current = lstatSync(parent);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev ||
      current.ino !== before.ino || current.uid !== before.uid || (current.mode & 0o077) !== 0 ||
      realpathSync(parent) !== realParent) throw new Error('fleet snapshot directory changed');
  };
  const clean = sanitizeSnapshot(snapshot, Date.parse(snapshot.generated_at), secrets());
  const encoded = `${JSON.stringify(clean, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) throw new Error('fleet snapshot exceeds byte limit');
  verifyParent();
  let existing = false;
  try {
    lstatSync(target);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let priorText: string | null = null;
  if (existing) {
    // A rejected read is not an empty source: replacing it would destroy the
    // operator's hand-edited readings/windows after a typo or unsafe edit.
    priorText = readText(target);
    const prior = json(priorText);
    if (prior.schema !== 'fleet.v1' || date(prior.generated_at) === null ||
      !Array.isArray(prior.readings) || !Array.isArray(prior.windows)) {
      throw new Error('refusing to overwrite an unreadable or invalid fleet snapshot');
    }
  }
  const source = snapshotSources.get(snapshot);
  if (source?.path === target && source.digest !== sourceDigest(priorText)) {
    throw new Error('fleet snapshot source changed; refresh before publication');
  }
  verifyParent();
  writePrivateFileAtomically(join(parent, `.fleet-${randomUUID()}.tmp`), target,
    encoded, { anchorPath: parent, label: 'fleet snapshot' });
  verifyParent();
  if (source?.path === target) source.digest = sourceDigest(encoded);
}

export function formatCodingFleetSnapshot(snapshot: CodingFleetSnapshot): string {
  const number = (value: number | null, suffix = '') => value === null ? 'unknown' : `${Math.round(value * 100) / 100}${suffix}`;
  const lines = [`Coding fleet (${snapshot.schema})`, snapshot.generated_at];
  for (const pool of snapshot.pools) {
    const freshness = pool.age_seconds === null ? '' : `, ${pool.age_seconds}s old`;
    const shared = pool.shared_with ? `; shares ${pool.shared_with}` : '';
    lines.push(`${pool.id}: ${number(pool.used_pct, '%')} used (${pool.source}${freshness}); ` +
      `burn ${number(pool.burn_pct_per_hour, '%/h')}; runway ${number(pool.runway_hours, 'h')}; ` +
      `reset ${pool.reset_at ?? 'unknown'}; projected ${number(pool.projected_pct, '%')}${shared}`);
  }
  lines.push(`Agents: ${snapshot.agents === null ? 'unknown' : snapshot.agents.length}`);
  for (const agent of snapshot.agents ?? [])
    lines.push(`  ${agent.agent}: ${agent.repo} ${agent.task}`);
  for (const repo of snapshot.repos) {
    lines.push(`${repo.repo}: ${repo.open === null ? 'unknown' : repo.open.length} open; ` +
      `${repo.merged === null ? 'unknown' : repo.merged.length} recent merged (${repo.source}${repo.complete ? '' : '; bounded or incomplete'})`);
    for (const pr of [...(repo.open ?? []), ...(repo.merged ?? [])]) {
      const cost = pr.cost?.map((cost) => `${cost.pool} ${number(cost.value)} ${cost.unit}`).join(', ') ?? 'unknown';
      lines.push(`  #${pr.number} ${pr.state}: ${pr.title}; CI ${pr.ci}; cost ${cost}`);
    }
  }
  lines.push(`Router: ${snapshot.router.source}; regret ${snapshot.router.regret === null ? 'unknown' : snapshot.router.regret.length}`);
  for (const decision of snapshot.router.decisions ?? []) {
    lines.push(`  ${decision.jobId}: ${decision.poolId ?? 'unknown'}; value ${decision.netValue ?? 'unknown'}`);
  }
  return lines.join('\n');
}
