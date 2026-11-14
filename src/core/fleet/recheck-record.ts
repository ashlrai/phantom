/**
 * core/fleet/recheck-record.ts: retained, sanitized as-of evidence for
 * `ashlr fleet recheck`. Projects a FleetRecheck verdict to a small row (no
 * claim task text, no message bodies) plus bounded per-section missing[]
 * reason lists, and appends it to `<root>/fleet/recheck-log.jsonl`, capped at
 * 500 lines. Takes no lock beyond the atomic rename, sends nothing, and
 * grants no authority. Never throws.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetRecheck } from './fleet-recheck.js';
import { sanitizeIdentityText } from './runtime-identity.js';

export const RECHECK_RECORD_SCHEMA = 'fleet.recheck-record.v1';
export const RECHECK_LOG_MAX_LINES = 500;
/** Per-list reason cap and per-reason character cap, applied at record time. */
export const RECHECK_MISSING_MAX = 8;
export const RECHECK_REASON_MAX = 160;

/** Bounded, sanitized missing-reason evidence: why the verdict did not verify.
 * Lists mirror the verdict's own missing[] fields (overall is the flattened
 * cross-section list); nothing beyond those strings is copied. */
export interface RecheckMissing {
  overall: string[];
  runtime: string[];
  claims: string[];
  bridge: string[];
  task: string[];
}

export interface RecheckRecord {
  schema: typeof RECHECK_RECORD_SCHEMA;
  asOf: string;
  overall: string;
  sections: {
    runtime: { state: string; host: string; installedVersion: string; asOf: string };
    claims: { state: string; active: number | null; asOf: string };
    bridge: { state: string; missingBridge: string | null; asOf: string };
    task: { state: string; id: string | null; owner: string | null; claimReceipt: string | null; asOf: string };
    /** Reason evidence; null on rows recorded before reasons were retained. */
    missing: RecheckMissing | null;
  };
}

export type AppendResult = { ok: true; record: RecheckRecord } | { ok: false; reason: string };

export function recheckLogPath(root: string): string {
  return join(root, 'fleet', 'recheck-log.jsonl');
}

/** Copy at most RECHECK_MISSING_MAX non-empty strings, each capped at
 * RECHECK_REASON_MAX characters; anything else is dropped, never serialized. */
function boundReasons(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const reason of list) {
    if (typeof reason !== 'string' || reason === '') continue;
    out.push(reason.slice(0, RECHECK_REASON_MAX));
    if (out.length >= RECHECK_MISSING_MAX) break;
  }
  return out;
}

/** Projection only: nothing beyond the named fields is copied from the verdict. */
export function projectRecheck(r: FleetRecheck): RecheckRecord {
  const { runtime, claims, bridge, task } = r.sections;
  return {
    schema: RECHECK_RECORD_SCHEMA,
    asOf: r.asOf,
    overall: r.overall.state,
    sections: {
      runtime: { state: runtime.state, host: runtime.host, installedVersion: runtime.installedVersion, asOf: runtime.asOf },
      claims: { state: claims.state, active: claims.active, asOf: claims.asOf },
      bridge: { state: bridge.state, missingBridge: bridge.missingBridge, asOf: bridge.asOf },
      task: {
        state: task.state, id: task.task?.id ?? null, owner: task.task?.owner ?? null,
        claimReceipt: task.task?.claimReceipt ?? null, asOf: task.asOf,
      },
      missing: {
        overall: boundReasons(r.overall.missing),
        runtime: boundReasons(runtime.missing),
        claims: boundReasons(claims.missing),
        bridge: boundReasons(bridge.missing),
        task: boundReasons(task.missing),
      },
    },
  };
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'write error';
}

export function appendRecheckRecord(root: string, recheck: FleetRecheck, home: string): AppendResult {
  try {
    const record = projectRecheck(recheck);
    const line = sanitizeIdentityText(JSON.stringify(record), home);
    const parsed = JSON.parse(line) as RecheckRecord; // sanitizing must keep the row valid JSON
    const file = recheckLogPath(root);
    mkdirSync(join(root, 'fleet'), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l !== '');
    if (lines.length > RECHECK_LOG_MAX_LINES) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${lines.slice(-RECHECK_LOG_MAX_LINES).join('\n')}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    }
    return { ok: true, record: parsed };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

export interface ReadRecords { rows: RecheckRecord[]; skipped: number; missing: boolean }

function isMissing(v: unknown): v is RecheckMissing {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return ['overall', 'runtime', 'claims', 'bridge', 'task']
    .every(k => Array.isArray(m[k]) && (m[k] as unknown[]).every(x => typeof x === 'string'));
}

function isRecord(v: unknown): v is RecheckRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const s = o.sections as Record<string, unknown> | undefined;
  return o.schema === RECHECK_RECORD_SCHEMA && typeof o.asOf === 'string' && typeof o.overall === 'string'
    && typeof s === 'object' && s !== null
    && ['runtime', 'claims', 'bridge', 'task'].every(k => typeof (s[k] as Record<string, unknown> | undefined)?.state === 'string')
    && (s['missing'] === undefined || s['missing'] === null || isMissing(s['missing']));
}

/** Newest-first rows; unreadable or malformed lines are counted, not thrown. */
export function readRecheckRecords(root: string, last: number): ReadRecords {
  let text: string;
  try {
    text = readFileSync(recheckLogPath(root), 'utf8');
  } catch (error) {
    return { rows: [], skipped: 0, missing: (error as { code?: unknown })?.code === 'ENOENT' };
  }
  const rows: RecheckRecord[] = [];
  let skipped = 0;
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(l);
      if (isRecord(v)) { v.sections.missing ??= null; rows.push(v); } else skipped++;
    } catch { skipped++; }
  }
  return { rows: rows.reverse().slice(0, last), skipped, missing: false };
}
