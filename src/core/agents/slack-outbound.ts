/**
 * Slack bridge outbound observation journal.
 *
 * Bounded append-only JSONL under `<runs>/slack-bridge/outbound.jsonl`
 * (0600) — the send-side sibling of journal.jsonl. Two record kinds:
 *
 *   { at, kind: 'delivery', status, reason?, topic?, envelopeId? }
 *     one row per deliverSlackEnvelope outcome — 'sent', 'duplicate',
 *     'uncertain' or 'refused' with the transport's static reason code.
 *   { at, kind: 'notice-pass', status, reason?, planned?, sent?,
 *     failed?, skipped? }
 *     one row per claim-notice pass the channels slack run tick
 *     executed — 'completed', 'dry-run', the four unavailable halts,
 *     or 'error' when the pass threw.
 *
 * Until now every outbound outcome lived only in session memory: the
 * run loop's totals die with the process, the claim tick's health
 * projection is per-session, and the send store keeps only the
 * attempted→sent lifecycle of messages that reached its write — a
 * 'refused' or early 'uncertain' outcome leaves no durable trace at
 * all, and a pass that keeps halting on an unreadable board or ledger
 * looks identical to a healthy one once the session ends. This journal
 * is evidence, not a ledger: ids, timestamps, closed status and reason
 * vocabularies, and pass counts only. Message text, display names,
 * tokens, thread contents and credential references are never written.
 *
 * The file is capped (256 KiB): when an append would exceed the cap the
 * tail of whole rows (at most 192 KiB) is kept and older observations
 * drop. Same custody contract as journal.jsonl: private directory,
 * process-owner lock, whitelist sanitize on write, structural
 * validation on read, never throws.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { slackBridgeDir } from './slack-journal.js';

export const SLACK_OUTBOUND_MAX_BYTES = 256 * 1024;
const SLACK_OUTBOUND_KEEP_BYTES = 192 * 1024;
/** Pass counts are small tallies; anything past this is off-contract. */
const MAX_PASS_COUNT = 1_000_000;

export type SlackOutboundDeliveryStatus = 'sent' | 'duplicate' | 'uncertain' | 'refused';
/**
 * ClaimNoticePassResult statuses plus 'error' for a pass that threw
 * before producing a result — the tick journals it so a crashing pass
 * is as visible as a halting one.
 */
export type SlackOutboundPassStatus =
  | 'completed'
  | 'dry-run'
  | 'board-unavailable'
  | 'ledger-unavailable'
  | 'bindings-unavailable'
  | 'prev-unavailable'
  | 'error';

export interface SlackOutboundDelivery {
  /** ISO record time. */
  at: string;
  kind: 'delivery';
  status: SlackOutboundDeliveryStatus;
  /** The transport's static reason code; absent on unreasoned outcomes. */
  reason?: string;
  /** The bus topic the envelope was addressed to (envelope `to`). */
  topic?: string;
  /** The envelope's own id, when it satisfies the bounded id shape. */
  envelopeId?: string;
}

export interface SlackOutboundNoticePass {
  /** ISO record time. */
  at: string;
  kind: 'notice-pass';
  status: SlackOutboundPassStatus;
  /** The pass's static halt/thrown reason code, when one was recorded. */
  reason?: string;
  planned?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
}

export type SlackOutboundRow = SlackOutboundDelivery | SlackOutboundNoticePass;

export interface SlackOutboundRead {
  state: 'ok' | 'missing' | 'degraded';
  /** Newest-first, like the inbound journal's read. */
  entries: SlackOutboundRow[];
  /** Valid stored rows omitted solely by the projection limit. */
  projectionOmitted?: boolean;
}

export function slackOutboundJournalPath(runsDir?: string): string {
  return join(slackBridgeDir(runsDir), 'outbound.jsonl');
}

function boundedField(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PASS_COUNT;
}

const DELIVERY_STATUSES: ReadonlySet<string> = new Set(['sent', 'duplicate', 'uncertain', 'refused']);
const PASS_STATUSES: ReadonlySet<string> = new Set([
  'completed', 'dry-run', 'board-unavailable', 'ledger-unavailable',
  'bindings-unavailable', 'prev-unavailable', 'error',
]);

/** Whitelist copy: only the declared metadata fields, closed vocabularies. */
function sanitize(row: SlackOutboundRow): Record<string, unknown> | null {
  if (!boundedField(row.at) || !Number.isFinite(Date.parse(row.at))) return null;
  if (row.kind === 'delivery') {
    if (!DELIVERY_STATUSES.has(row.status)) return null;
    const out: Record<string, unknown> = { at: row.at, kind: 'delivery', status: row.status };
    if (boundedField(row.reason)) out['reason'] = row.reason;
    if (boundedField(row.topic)) out['topic'] = row.topic;
    if (boundedField(row.envelopeId)) out['envelopeId'] = row.envelopeId;
    return out;
  }
  if (row.kind === 'notice-pass') {
    if (!PASS_STATUSES.has(row.status)) return null;
    const out: Record<string, unknown> = { at: row.at, kind: 'notice-pass', status: row.status };
    if (boundedField(row.reason)) out['reason'] = row.reason;
    for (const key of ['planned', 'sent', 'failed', 'skipped'] as const) {
      const value = row[key];
      if (value !== undefined) {
        if (!safeCount(value)) return null;
        out[key] = value;
      }
    }
    return out;
  }
  return null;
}

/** Distinguish absence from unreadable, oversized or short-read evidence. */
function journalContents(path: string): string | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const read = readPrivateFileCapped(path, SLACK_OUTBOUND_MAX_BYTES);
  if (read === null || read.truncated || Buffer.byteLength(read.text, 'utf8') !== read.bytes) {
    throw new Error('unreadable Slack outbound journal');
  }
  return read.text;
}

/**
 * Serialize read/append/whole-row retention with the repository's
 * process-owner lock, exactly like the inbound journal. Never throws —
 * journaling must not take the send or pass path down.
 */
export function recordSlackOutbound(
  row: SlackOutboundRow,
  options: { runsDir?: string } = {},
): 'recorded' | 'failed' {
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    const clean = sanitize(row);
    if (clean === null) return 'failed';
    const dir = slackBridgeDir(options.runsDir);
    const path = slackOutboundJournalPath(options.runsDir);
    ensurePrivateDirectory(dir);
    lock = acquireLocalStoreLock(`${path}.lock`, 250);
    if (lock === null) return 'failed';
    const existing = journalContents(path) ?? '';
    if (parseJournal(existing, 0).state === 'degraded') return 'failed';
    let body = `${existing}${JSON.stringify(clean)}\n`;
    if (Buffer.byteLength(body, 'utf8') > SLACK_OUTBOUND_MAX_BYTES) {
      const lines = body.split('\n').filter((line) => line.length > 0);
      const kept: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = `${lines[i]!}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        if (bytes + size > SLACK_OUTBOUND_KEEP_BYTES) break;
        kept.push(line);
        bytes += size;
      }
      body = kept.reverse().join('');
    }
    writePrivateFileAtomic(path, body);
    return 'recorded';
  } catch {
    return 'failed';
  } finally {
    if (lock !== null) releaseLocalStoreLock(lock);
  }
}

/**
 * Structural validation of one persisted row against the contract
 * `sanitize` writes: required `at`/`kind`/`status` well-formed, the
 * kind's own status inside its closed vocabulary, optional fields
 * present only as bounded strings or safe counts. Returns null for a
 * corrupted row so the caller marks the read degraded.
 */
function projectRow(row: Record<string, unknown>): SlackOutboundRow | null {
  const at = row['at'];
  const kind = row['kind'];
  const status = row['status'];
  if (!boundedField(at) || !Number.isFinite(Date.parse(at))) return null;
  if (kind === 'delivery') {
    if (typeof status !== 'string' || !DELIVERY_STATUSES.has(status)) return null;
    for (const key of ['reason', 'topic', 'envelopeId'] as const) {
      const value = row[key];
      if (value !== undefined && !boundedField(value)) return null;
    }
    const out: SlackOutboundDelivery = { at, kind: 'delivery', status: status as SlackOutboundDeliveryStatus };
    if (typeof row['reason'] === 'string') out.reason = row['reason'];
    if (typeof row['topic'] === 'string') out.topic = row['topic'];
    if (typeof row['envelopeId'] === 'string') out.envelopeId = row['envelopeId'];
    return out;
  }
  if (kind === 'notice-pass') {
    if (typeof status !== 'string' || !PASS_STATUSES.has(status)) return null;
    if (row['reason'] !== undefined && !boundedField(row['reason'])) return null;
    for (const key of ['planned', 'sent', 'failed', 'skipped'] as const) {
      if (row[key] !== undefined && !safeCount(row[key])) return null;
    }
    const out: SlackOutboundNoticePass = { at, kind: 'notice-pass', status: status as SlackOutboundPassStatus };
    if (typeof row['reason'] === 'string') out.reason = row['reason'];
    for (const key of ['planned', 'sent', 'failed', 'skipped'] as const) {
      const value = row[key];
      if (safeCount(value)) out[key] = value;
    }
    return out;
  }
  return null;
}

/** Newest-first bounded read. Never takes a lock, repairs or creates files. */
export function readSlackOutboundJournal(
  options: { runsDir?: string; limit?: number } = {},
): SlackOutboundRead {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 4096));
  try {
    const text = journalContents(slackOutboundJournalPath(options.runsDir));
    return text === null ? { state: 'missing', entries: [] } : parseJournal(text, limit);
  } catch {
    return { state: 'degraded', entries: [] };
  }
}

function parseJournal(text: string, limit: number): SlackOutboundRead {
  const entries: SlackOutboundRow[] = [];
  let projectionOmitted = false;
  let degraded = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n').filter((line) => line.length > 0);
  // Validate every bounded row even when the projection limit is reached.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        degraded = true;
        continue;
      }
      const row = projectRow(parsed as Record<string, unknown>);
      if (row === null) {
        degraded = true;
        continue;
      }
      if (entries.length < limit) entries.push(row);
      else projectionOmitted = true;
    } catch {
      degraded = true;
    }
  }
  return { state: degraded ? 'degraded' : 'ok', entries, projectionOmitted };
}
