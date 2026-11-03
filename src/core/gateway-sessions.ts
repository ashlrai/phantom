/**
 * Gateway sessions: one id per running `phm mcp` gateway, a revoke switch the
 * owner flips from the CLI, and one JSONL activity log (caller, tool, verdict).
 *
 * Files live under `<ASHLR_HOME>/gateway/`. Revoking writes `revokedAt` into the
 * session record; the gateway re-reads its record on every tool call, so the
 * very next call is refused. Tool arguments never reach disk: the log keeps
 * argument names only, with every value replaced.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from './cloud/store.js';
import { scrubSecrets } from './util/scrub-secrets.js';

export const ACTIVITY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^gs_[0-9a-f]{12}$/;
const MAX_ARG_NAMES = 20;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export type GatewayVerdict = 'allow' | 'deny' | 'approval_required' | 'revoked';
export type GatewaySessionStatus = 'active' | 'revoked' | 'ended';

export interface GatewaySessionRecord {
  id: string;
  caller: string;
  groups: string[];
  pid: number;
  startedAt: string;
  endedAt?: string;
  revokedAt?: string;
}
export interface GatewaySessionView extends GatewaySessionRecord { status: GatewaySessionStatus }
export interface GatewayActivityEntry {
  ts: string;
  session: string;
  caller: string;
  tool: string;
  verdict: GatewayVerdict;
  args: Record<string, '[redacted]'>;
}

export const gatewayDir = (): string => join(ashlrHome(), 'gateway');
const sessionsDir = (): string => join(gatewayDir(), 'sessions');
const sessionFile = (id: string): string => join(sessionsDir(), `${id}.json`);
export const activityLogPath = (): string => join(gatewayDir(), 'activity.jsonl');

export const isGatewaySessionId = (id: string): boolean => ID_PATTERN.test(id);

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

function readRecord(id: string): GatewaySessionRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(id), 'utf8')) as Partial<GatewaySessionRecord>;
    if (raw.id !== id || typeof raw.caller !== 'string' || typeof raw.pid !== 'number' || typeof raw.startedAt !== 'string') return undefined;
    return {
      id, caller: raw.caller, pid: raw.pid, startedAt: raw.startedAt,
      groups: Array.isArray(raw.groups) ? raw.groups.filter((g): g is string => typeof g === 'string') : [],
      ...(typeof raw.endedAt === 'string' ? { endedAt: raw.endedAt } : {}),
      ...(typeof raw.revokedAt === 'string' ? { revokedAt: raw.revokedAt } : {}),
    };
  } catch { return undefined; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function view(record: GatewaySessionRecord): GatewaySessionView {
  const status: GatewaySessionStatus = record.revokedAt ? 'revoked'
    : record.endedAt || !pidAlive(record.pid) ? 'ended' : 'active';
  return { ...record, status };
}

/** Create a session record for this gateway process. */
export function registerGatewaySession(identity: { agent?: string; groups: string[] }, now = new Date()): GatewaySessionRecord {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  const record: GatewaySessionRecord = {
    id: `gs_${randomBytes(6).toString('hex')}`,
    caller: identity.agent ?? 'unknown',
    groups: identity.groups,
    pid: process.pid,
    startedAt: now.toISOString(),
  };
  writeAtomic(sessionFile(record.id), `${JSON.stringify(record)}\n`);
  return record;
}

/** Mark a session finished. Never throws; a revoked record keeps its revokedAt. */
export function endGatewaySession(id: string, now = new Date()): void {
  try {
    const record = readRecord(id);
    if (record) writeAtomic(sessionFile(id), `${JSON.stringify({ ...record, endedAt: now.toISOString() })}\n`);
  } catch { /* best effort */ }
}

/**
 * True when the session may still make calls. A record that cannot be read is
 * treated as revoked: removing or damaging it must never widen access.
 */
export function isGatewaySessionAllowed(id: string): boolean {
  const record = readRecord(id);
  return record !== undefined && record.revokedAt === undefined;
}

export function listGatewaySessions(): GatewaySessionView[] {
  let names: string[];
  try { names = readdirSync(sessionsDir()); } catch { return []; }
  return names
    .filter(name => name.endsWith('.json') && isGatewaySessionId(name.slice(0, -5)))
    .flatMap(name => { const record = readRecord(name.slice(0, -5)); return record ? [view(record)] : []; })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}

export type RevokeResult = { ok: true; session: GatewaySessionView; alreadyRevoked: boolean } | { ok: false; reason: 'invalid-id' | 'not-found' };

export function revokeGatewaySession(id: string, now = new Date()): RevokeResult {
  if (!isGatewaySessionId(id)) return { ok: false, reason: 'invalid-id' };
  const record = readRecord(id);
  if (!record) return { ok: false, reason: 'not-found' };
  if (record.revokedAt) return { ok: true, session: view(record), alreadyRevoked: true };
  const revoked = { ...record, revokedAt: now.toISOString() };
  writeAtomic(sessionFile(id), `${JSON.stringify(revoked)}\n`);
  return { ok: true, session: view(revoked), alreadyRevoked: false };
}

/** Argument names only. Values, and any key-like name, never reach the log. */
export function redactGatewayArgs(args: unknown): Record<string, '[redacted]'> {
  const out: Record<string, '[redacted]'> = {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return out;
  for (const name of Object.keys(args).sort().slice(0, MAX_ARG_NAMES)) {
    const safe = scrubSecrets(name).slice(0, 40);
    out[safe] = '[redacted]';
  }
  return out;
}

/** Append one activity row. Never throws: logging must not break a tool call. */
export function recordGatewayActivity(entry: { session: string; caller: string; tool: string; verdict: GatewayVerdict; args?: unknown }, now = new Date()): void {
  try {
    mkdirSync(gatewayDir(), { recursive: true, mode: 0o700 });
    const file = activityLogPath();
    const row: GatewayActivityEntry = {
      ts: now.toISOString(),
      session: entry.session,
      caller: scrubSecrets(entry.caller).slice(0, 80),
      tool: scrubSecrets(entry.tool).slice(0, 160),
      verdict: entry.verdict,
      args: redactGatewayArgs(entry.args),
    };
    appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    let size = 0;
    try { size = statSync(file).size; } catch { /* ignore */ }
    if (size > MAX_LOG_BYTES) rotateGatewayActivity(now);
  } catch { /* best effort */ }
}

export function readGatewayActivity(): GatewayActivityEntry[] {
  let text: string;
  try { text = readFileSync(activityLogPath(), 'utf8'); } catch { return []; }
  const rows: GatewayActivityEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line) as GatewayActivityEntry); } catch { /* skip torn line */ }
  }
  return rows;
}

/**
 * Drop activity older than 14 days (and, if still oversized, the oldest rows),
 * and delete session records that ended or were revoked more than 14 days ago.
 * Returns how many log rows were removed.
 */
export function rotateGatewayActivity(now = new Date()): number {
  const cutoff = now.getTime() - ACTIVITY_RETENTION_MS;
  let removed = 0;
  try {
    const rows = readGatewayActivity();
    let kept = rows.filter(row => Date.parse(row.ts) >= cutoff);
    let text = kept.map(row => `${JSON.stringify(row)}\n`).join('');
    while (Buffer.byteLength(text) > MAX_LOG_BYTES && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 10));
      text = kept.map(row => `${JSON.stringify(row)}\n`).join('');
    }
    removed = rows.length - kept.length;
    if (removed > 0) writeAtomic(activityLogPath(), text);
  } catch { /* best effort */ }
  for (const session of listGatewaySessions()) {
    const finished = session.revokedAt ?? session.endedAt ?? (session.status === 'ended' ? session.startedAt : undefined);
    if (finished !== undefined && Date.parse(finished) < cutoff) rmSync(sessionFile(session.id), { force: true });
  }
  return removed;
}
