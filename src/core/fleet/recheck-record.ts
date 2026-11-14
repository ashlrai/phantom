/**
 * core/fleet/recheck-record.ts: retained, sanitized as-of evidence for
 * `ashlr fleet recheck`. Projects a FleetRecheck verdict to a small row (no
 * claim task text, no message bodies) plus bounded per-section missing[]
 * reason lists and the task.lastVerified {id, owner, asOf} evidence triple,
 * and appends it to `<root>/fleet/recheck-log.jsonl`, capped at
 * 500 lines. Takes no lock beyond the atomic rename, sends nothing, and
 * grants no authority. Never throws.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetRecheck } from './fleet-recheck.js';
import { sanitizeIdentityText, UNKNOWN } from './runtime-identity.js';

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
    claims: {
      state: string;
      /** Live-claim count from the verdict; null when the ledger was
       * unreadable. Writes and reads both require a non-negative integer. */
      active: number | null;
      asOf: string;
    };
    bridge: { state: string; missingBridge: string | null; asOf: string };
    task: {
      state: string; id: string | null; owner: string | null; claimReceipt: string | null; asOf: string;
      /** Newest finished board item proven done at record time; the id+owner+asOf
       * triple is the evidence, never its claimReceipt or source. Absent on rows
       * recorded before it was retained; read back as null. */
      lastVerified?: { id: string; owner: string; asOf: string } | null;
    };
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

/** The finished-item evidence triple, each string capped like a reason; the
 * verdict's claimReceipt and source are deliberately not copied — the row
 * names which task was last proven done, not how. */
function boundLastVerified(lv: FleetRecheck['sections']['task']['lastVerified']): { id: string; owner: string; asOf: string } | null {
  if (lv === null || lv === undefined) return null;
  return {
    id: lv.id.slice(0, RECHECK_REASON_MAX),
    owner: lv.owner.slice(0, RECHECK_REASON_MAX),
    asOf: lv.asOf.slice(0, RECHECK_REASON_MAX),
  };
}

/** Stored string-or-null evidence: anything that is not a string collapses to
 * null so a malformed verdict can never write a wrong-typed row. */
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Stored claims.active evidence: a non-negative integer count or null. */
const activeOrNull = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Projection only: nothing beyond the named fields is copied from the verdict. */
export function projectRecheck(r: FleetRecheck): RecheckRecord {
  const { runtime, claims, bridge, task } = r.sections;
  const boardTask = task.task ?? null;
  return {
    schema: RECHECK_RECORD_SCHEMA,
    asOf: r.asOf,
    overall: r.overall.state,
    sections: {
      runtime: {
        state: runtime.state,
        host: textOrNull(runtime.host) ?? UNKNOWN,
        installedVersion: textOrNull(runtime.installedVersion) ?? UNKNOWN,
        asOf: runtime.asOf,
      },
      claims: { state: claims.state, active: activeOrNull(claims.active), asOf: claims.asOf },
      bridge: { state: bridge.state, missingBridge: textOrNull(bridge.missingBridge), asOf: bridge.asOf },
      task: {
        state: task.state,
        id: textOrNull(boardTask?.id),
        owner: textOrNull(boardTask?.owner),
        claimReceipt: textOrNull(boardTask?.claimReceipt),
        asOf: task.asOf,
        lastVerified: boundLastVerified(task.lastVerified),
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

function safeErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : fallback;
}

function reasonOf(error: unknown): string {
  return safeErrorCode(error, 'write error');
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

/** Outcome of the history read itself. Emitted on attempted reads: 'ok' means
 * the log was read — an empty file is a successful empty read, not absent
 * history; 'unreadable' means the read failed and rows/skipped/missing cannot
 * tell it apart from a fresh empty file. Absent history (ENOENT) keeps the
 * legacy {missing:true} shape with no outcome, so the three states stay
 * distinguishable through the result: missing → absent, outcome 'unreadable'
 * → failed read, otherwise a successful read. */
export type RecheckReadOutcome = 'ok' | 'unreadable';

export interface ReadRecords {
  rows: RecheckRecord[];
  skipped: number;
  missing: boolean;
  outcome?: RecheckReadOutcome;
  /** Bounded safe failure code when outcome is 'unreadable' (errno-style or
   * 'read error'); never an error message, stack, path or file content. */
  failure?: string;
}

function isMissing(v: unknown): v is RecheckMissing {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return ['overall', 'runtime', 'claims', 'bridge', 'task']
    .every(k => Array.isArray(m[k]) && (m[k] as unknown[]).every(x => typeof x === 'string'));
}

/** Stored lastVerified evidence: absent on pre-334 rows, null, or the
 * {id, owner, asOf} string triple. Anything else marks the row malformed. */
function isLastVerifiedField(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'object') return false;
  const lv = v as Record<string, unknown>;
  return typeof lv.id === 'string' && typeof lv.owner === 'string' && typeof lv.asOf === 'string';
}

function isRecord(v: unknown): v is RecheckRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const s = o.sections;
  if (o.schema !== RECHECK_RECORD_SCHEMA || typeof o.asOf !== 'string' || typeof o.overall !== 'string'
    || typeof s !== 'object' || s === null) return false;
  const sections = s as Record<string, unknown>;
  const part = (key: string): Record<string, unknown> | undefined => {
    const x = sections[key];
    return typeof x === 'object' && x !== null ? x as Record<string, unknown> : undefined;
  };
  const runtime = part('runtime');
  const claims = part('claims');
  const bridge = part('bridge');
  const task = part('task');
  if (runtime === undefined || claims === undefined || bridge === undefined || task === undefined) return false;
  const nullableString = (x: unknown): boolean => x === null || typeof x === 'string';
  const active = claims['active'];
  return typeof runtime['state'] === 'string'
    && typeof runtime['host'] === 'string' && typeof runtime['installedVersion'] === 'string'
    && typeof runtime['asOf'] === 'string'
    && typeof claims['state'] === 'string'
    && (active === null || (typeof active === 'number' && Number.isInteger(active) && active >= 0))
    && typeof claims['asOf'] === 'string'
    && typeof bridge['state'] === 'string' && nullableString(bridge['missingBridge'])
    && typeof bridge['asOf'] === 'string'
    && typeof task['state'] === 'string' && nullableString(task['id']) && nullableString(task['owner'])
    && nullableString(task['claimReceipt']) && typeof task['asOf'] === 'string'
    && isLastVerifiedField(task['lastVerified'])
    && (sections['missing'] === undefined || sections['missing'] === null || isMissing(sections['missing']));
}

/** Newest-first rows; unreadable or malformed lines are counted, not thrown. */
export function readRecheckRecords(root: string, last: number): ReadRecords {
  let text: string;
  try {
    text = readFileSync(recheckLogPath(root), 'utf8');
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return { rows: [], skipped: 0, missing: true };
    return { rows: [], skipped: 0, missing: false, outcome: 'unreadable', failure: safeErrorCode(error, 'read error') };
  }
  const rows: RecheckRecord[] = [];
  let skipped = 0;
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(l);
      if (isRecord(v)) {
        v.sections.missing ??= null;
        v.sections.task.lastVerified ??= null;
        rows.push(v);
      } else skipped++;
    } catch { skipped++; }
  }
  return { rows: rows.reverse().slice(0, last), skipped, missing: false, outcome: 'ok' };
}
