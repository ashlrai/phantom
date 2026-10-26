/**
 * Per-run routing accounting (flagship slice 3).
 *
 * One append-only JSON line per finished run, under
 * ~/.ashlr/routing/accounting.jsonl. There is no swarmlog writer in this
 * repo; the line uses the same shape as the fleet journal (v, type, at,
 * one JSON object per line). It is not a receipt and this module never
 * imports the receipt store.
 *
 * The line carries the route (local or frontier), a closed escalation
 * reason, the engine id, tokens in and out per tier, and the estimated
 * frontier tokens saved (local tokens that did not go to a frontier
 * engine). No prompts, URLs, headers, or secret values are written.
 * An unclassified engine id is recorded as frontier: unknown ids get no
 * local-lane privileges and no savings credit.
 */
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import type { SeatCapacity } from './headroom.js';
import { classifyEngine, type EngineClass, type LocalRouteContext } from './local-route.js';
import type { EscalationReason } from './local-escalation.js';
import { readRoutingLedger, type RoutingLedger } from './routing-ledger.js';
import { routingDir } from './budget-store.js';

export const ROUTING_ACCOUNT_FILE = 'accounting.jsonl';
export const ROUTING_ACCOUNT_WINDOW_HOURS = 24;
export const ROUTING_ACCOUNT_MAX_RUNS = 20;
const WINDOW_MS = ROUTING_ACCOUNT_WINDOW_HOURS * 60 * 60 * 1000;
const MAX_ACCOUNT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024;

export type AccountReason = EscalationReason | 'policy-off' | 'unclassified';
export type AccountRoute = 'local' | 'frontier';

export interface RoutingTokenCounts {
  in: number;
  out: number;
}

export interface RoutingAccountLine {
  v: 1;
  type: 'routing-account';
  at: string;
  runId: string;
  route: AccountRoute;
  escalationReason: AccountReason;
  engineId: string;
  tokens: { local: RoutingTokenCounts; frontier: RoutingTokenCounts };
  frontierTokensSaved: number;
}

/** What `phm status --json` publishes under `routing`. */
export interface RoutingStatus {
  schemaVersion: 1;
  windowHours: 24;
  split: { local: number; frontier: number };
  tokens: { local: RoutingTokenCounts; frontier: RoutingTokenCounts };
  frontierTokensSaved: number;
  runs: RoutingAccountLine[];
  /** Slice 2 dispatch ledger (tier, engine, lane reason). Null when none was recorded. */
  ledger: RoutingLedger | null;
}

export interface TerminalRunRouting {
  id: string;
  engine: string;
  status: string;
  usage?: { tokensIn?: number; tokensOut?: number } | null;
  routeSnapshot?: { reason?: string } | null;
}

const TERMINAL = new Set(['done', 'failed', 'aborted']);
const ID_CHARS = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;
const SECRET_HINT = /sk-|phm_|bearer|api[_-]?key|token|secret|password/i;

export function routingAccountPath(): string {
  return join(routingDir(), ROUTING_ACCOUNT_FILE);
}

/** Closed reason codes. A new EscalationReason fails this switch until it is listed. */
export function isAccountReason(value: string): value is AccountReason {
  const reason = value as AccountReason;
  switch (reason) {
    case 'merge-to-main-frontier-only':
    case 'merge-rights-frontier-only':
    case 'credentials-frontier-only':
    case 'abliterated-with-credentials':
    case 'complex-task-kind':
    case 'protected-path':
    case 'verify-failures':
    case 'retry-cap':
    case 'context-over-local-limit':
    case 'local-unavailable':
    case 'local-ok':
    case 'policy-off':
    case 'unclassified':
      return true;
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return false;
    }
  }
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function zeroTokens(): { local: RoutingTokenCounts; frontier: RoutingTokenCounts } {
  return { local: { in: 0, out: 0 }, frontier: { in: 0, out: 0 } };
}

/** Ids that survive into a line. Anything secret-shaped or free-form becomes the fallback. */
export function safeAccountId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (!ID_CHARS.test(s) || SECRET_HINT.test(s) || scrubSecrets(s) !== s) return fallback;
  return s;
}

function savedFor(route: AccountRoute, tokens: RoutingAccountLine['tokens']): number {
  return route === 'local' ? tokens.local.in + tokens.local.out : 0;
}

/**
 * Pure. One accounting line for a finished run, or null when the run is
 * still going. Unknown engine ids are frontier with reason `unclassified`.
 */
export function routingAccountLine(
  run: TerminalRunRouting,
  engines?: LocalRouteContext['engines'],
  now: Date = new Date(),
): RoutingAccountLine | null {
  if (!TERMINAL.has(run.status)) return null;
  const engineId = safeAccountId(run.engine, 'redacted');
  const cls: EngineClass = classifyEngine({ engine: run.engine as SeatCapacity['engine'] }, engines);
  const route: AccountRoute = cls === 'local' ? 'local' : 'frontier';
  const snapshot = typeof run.routeSnapshot?.reason === 'string' ? run.routeSnapshot.reason : '';
  let escalationReason: AccountReason = isAccountReason(snapshot) ? snapshot : (route === 'local' ? 'local-ok' : 'policy-off');
  if (cls === 'unclassified') escalationReason = 'unclassified';
  else if (route === 'frontier' && escalationReason === 'local-ok') escalationReason = 'policy-off';
  else if (route === 'local' && escalationReason !== 'local-ok') escalationReason = 'local-ok';
  const inn = count(run.usage?.tokensIn);
  const out = count(run.usage?.tokensOut);
  const tokens = zeroTokens();
  tokens[route] = { in: inn, out };
  const line: RoutingAccountLine = {
    v: 1,
    type: 'routing-account',
    at: now.toISOString(),
    runId: safeAccountId(run.id, 'redacted'),
    route,
    escalationReason,
    engineId,
    tokens,
    frontierTokensSaved: savedFor(route, tokens),
  };
  if (scrubSecrets(JSON.stringify(line)) !== JSON.stringify(line)) return null;
  return line;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function rotateIfLarge(file: string): void {
  let size = 0;
  try { size = statSync(file).size; } catch { return; }
  if (size < MAX_ACCOUNT_BYTES) return;
  const previous = file.replace(/\.jsonl$/, '.1.jsonl');
  try { rmSync(previous, { force: true }); } catch { /* best effort */ }
  try { renameSync(file, previous); } catch { /* keep appending to the live file */ }
}

/** Append one line. Never throws. Returns false when the line was refused or the write failed. */
export function appendRoutingAccount(line: RoutingAccountLine, file = routingAccountPath()): boolean {
  try {
    const text = JSON.stringify(line);
    if (scrubSecrets(text) !== text) return false;
    const payload = `${text}\n`;
    if (Buffer.byteLength(payload) > MAX_LINE_BYTES) return false;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    rotateIfLarge(file);
    const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollowFlag(), 0o600);
    try {
      if (!fstatSync(fd).isFile()) return false;
      const bytes = Buffer.from(payload, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
        if (wrote <= 0) return false;
        offset += wrote;
      }
    } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

/** Record a finished run. Never throws. Skips non-terminal runs. Does not write receipts. */
export function recordTerminalRunRouting(
  run: TerminalRunRouting,
  engines?: LocalRouteContext['engines'],
  opts: { now?: Date; path?: string } = {},
): boolean {
  try {
    const line = routingAccountLine(run, engines, opts.now);
    if (!line) return false;
    return appendRoutingAccount(line, opts.path);
  } catch {
    return false;
  }
}

function readAccountText(file: string): string {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | noFollowFlag()); } catch { return ''; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0) return '';
    const start = st.size > MAX_ACCOUNT_BYTES ? st.size - MAX_ACCOUNT_BYTES : 0;
    const buf = Buffer.alloc(st.size - start);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch {
    return '';
  } finally { closeSync(fd); }
}

function parseLine(raw: string): RoutingAccountLine | null {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v['v'] !== 1 || v['type'] !== 'routing-account' || typeof v['at'] !== 'string') return null;
  if (Number.isNaN(Date.parse(v['at']))) return null;
  if (v['route'] !== 'local' && v['route'] !== 'frontier') return null;
  if (typeof v['escalationReason'] !== 'string' || !isAccountReason(v['escalationReason'])) return null;
  if (safeAccountId(v['runId'], '') === '' || safeAccountId(v['engineId'], '') === '') return null;
  const tokens = v['tokens'];
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  const local = t['local'];
  const frontier = t['frontier'];
  if (!local || !frontier || typeof local !== 'object' || typeof frontier !== 'object') return null;
  const pair = (p: object): RoutingTokenCounts => ({
    in: count((p as Record<string, unknown>)['in']),
    out: count((p as Record<string, unknown>)['out']),
  });
  const route = v['route'];
  const built: RoutingAccountLine = {
    v: 1,
    type: 'routing-account',
    at: new Date(Date.parse(v['at'])).toISOString(),
    runId: safeAccountId(v['runId'], 'redacted'),
    route,
    escalationReason: v['escalationReason'],
    engineId: safeAccountId(v['engineId'], 'redacted'),
    tokens: { local: pair(local), frontier: pair(frontier) },
    frontierTokensSaved: 0,
  };
  built.frontierTokensSaved = savedFor(route, built.tokens);
  if (scrubSecrets(JSON.stringify(built)) !== JSON.stringify(built)) return null;
  return built;
}

function tokenSum(line: RoutingAccountLine): number {
  return line.tokens.local.in + line.tokens.local.out + line.tokens.frontier.in + line.tokens.frontier.out;
}

/** Pure. Last `windowHours` of lines, one row per run (the row with the most tokens wins). */
export function routingStatusFrom(
  lines: readonly RoutingAccountLine[],
  ledger: RoutingLedger | null,
  now: Date = new Date(),
): RoutingStatus {
  const cutoff = now.getTime() - WINDOW_MS;
  const byRun = new Map<string, RoutingAccountLine>();
  for (const line of lines) {
    if (Date.parse(line.at) < cutoff) continue;
    const prev = byRun.get(line.runId);
    if (!prev || tokenSum(line) > tokenSum(prev) || (tokenSum(line) === tokenSum(prev) && line.at >= prev.at)) {
      byRun.set(line.runId, line);
    }
  }
  const runs = [...byRun.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const tokens = zeroTokens();
  const split = { local: 0, frontier: 0 };
  let frontierTokensSaved = 0;
  for (const line of runs) {
    split[line.route] += 1;
    tokens.local.in += line.tokens.local.in;
    tokens.local.out += line.tokens.local.out;
    tokens.frontier.in += line.tokens.frontier.in;
    tokens.frontier.out += line.tokens.frontier.out;
    frontierTokensSaved += line.frontierTokensSaved;
  }
  return {
    schemaVersion: 1,
    windowHours: ROUTING_ACCOUNT_WINDOW_HOURS,
    split,
    tokens,
    frontierTokensSaved,
    runs: runs.slice(0, ROUTING_ACCOUNT_MAX_RUNS),
    ledger,
  };
}

export function readRoutingAccounts(file = routingAccountPath()): RoutingAccountLine[] {
  const lines: RoutingAccountLine[] = [];
  for (const raw of readAccountText(file).split('\n')) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (line) lines.push(line);
  }
  return lines;
}

/** The `routing` object for `phm status --json`. Never throws. */
export function readRoutingStatus(opts: { now?: Date; accountPath?: string; ledgerPath?: string } = {}): RoutingStatus {
  try {
    const lines = readRoutingAccounts(opts.accountPath);
    const ledger = readRoutingLedger(opts.ledgerPath);
    return routingStatusFrom(lines, ledger, opts.now ?? new Date());
  } catch {
    return routingStatusFrom([], null, opts.now ?? new Date());
  }
}

/** Human detail shared by the doctor row. Counts only, no ids beyond what the caller adds. */
export function routingSplitDetail(status: Pick<RoutingStatus, 'split' | 'frontierTokensSaved'>): string {
  return `local ${status.split.local} / frontier ${status.split.frontier}; frontier tokens saved ${status.frontierTokensSaved}`;
}
