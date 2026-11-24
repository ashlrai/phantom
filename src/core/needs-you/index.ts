/**
 * The "Needs you" list over the NEEDS-MASON.md ledger, split by classifyNeedsYou:
 *
 *   listNeedsYou()            → hard_limit items as one short list, plus auto items
 *   resolveAutoNeedsYou(opts) → each auto item takes its default forward action
 *                               (an approval's first option, else "go ahead") and
 *                               one audit record {item, action, at, reason} is
 *                               appended to <runs>/needs-you-auto.jsonl
 *   readNeedsYouAudit()       → those audit records, newest last
 *
 * Resolving goes through resolveNeedsMason with source 'leader', the same path
 * `ashlr fleet needs-triage --apply` uses, so the bus envelope never claims
 * Mason answered. A dry run reads only.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { approvalOfLine } from '../fleet/approvals.js';
import { askOfLine, shortIds } from '../fleet/asks.js';
import {
  readNeedsMasonLedger, resolveNeedsMason, type NeedsMasonOptions,
} from '../fleet/needs-mason-resolve.js';
import { scrubSecrets } from '../util/scrub.js';
import { classifyNeedsYou, needsYouWords, type NeedsYouClass, type NeedsYouLimit } from './classify.js';

export * from './classify.js';

export const NEEDS_YOU_SCHEMA = 'phantom.needs-you.v1';
export const NEEDS_YOU_RESOLVE_SCHEMA = 'phantom.needs-you.resolve.v1';
export const NEEDS_YOU_BATCH_SCHEMA = 'phantom.needs-you.batch.v1';
export const NEEDS_YOU_AUDIT_FILE = 'needs-you-auto.jsonl';
const TITLE_MAX = 80;
const AUDIT_READ_MAX = 256 * 1024;

export interface NeedsYouItem {
  /** Ledger id, `nm-` + 12 hex. */
  id: string;
  /** Shortest unique hex prefix, for a one-word reply. */
  ref: string;
  /** Plain words, at most 80 characters. */
  title: string;
  class: NeedsYouClass;
  limit: NeedsYouLimit | null;
  reason: string;
  /** One-tap answers. */
  answers: string[];
  /** What `resolve --auto` does for an auto item: an approval's first option, else "go ahead". */
  forward: string;
  /** The existing command that records an answer (its own checks still apply). */
  answer: string;
}

export interface NeedsYouList {
  schema: typeof NEEDS_YOU_SCHEMA;
  /** missing = no ledger yet; unavailable = unreadable, so the list is unknown. */
  ledger: 'available' | 'missing' | 'unavailable';
  counts: { hardLimit: number; auto: number };
  /** Only these wait on Mason. */
  hardLimit: NeedsYouItem[];
  /** These resolve themselves with `phm needs-you resolve --auto`. */
  auto: NeedsYouItem[];
}

export interface NeedsYouAuditRecord {
  item: { id: string; title: string };
  action: string;
  at: string;
  reason: string;
}

export interface NeedsYouResolveReport {
  schema: typeof NEEDS_YOU_RESOLVE_SCHEMA;
  dryRun: boolean;
  ledger: NeedsYouList['ledger'];
  resolved: NeedsYouAuditRecord[];
  failed: Array<{ id: string; error: string }>;
  /** Still waiting on Mason after this run. */
  hardLimit: number;
}

export interface NeedsYouBatch {
  schema: typeof NEEDS_YOU_BATCH_SCHEMA;
  ledger: NeedsYouList['ledger'];
  count: number;
  /** One message for one phone tap; empty when nothing needs Mason. */
  message: string;
  /** Numbered as in the message: reply "<n> <answer>" per item. */
  items: Array<{ n: number; id: string; ref: string; title: string; reason: string; answers: string[] }>;
}

export interface NeedsYouOptions extends Pick<NeedsMasonOptions, 'runsDir' | 'bus'> {
  now?: () => number;
  resolve?: typeof resolveNeedsMason;
}

const runsDirOf = (options: NeedsYouOptions): string =>
  options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
const cap = (text: string): string => (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text);

function itemOf(id: string, ref: string, text: string): NeedsYouItem {
  const verdict = classifyNeedsYou({ text });
  const approval = approvalOfLine(text);
  const ask = approval ? null : askOfLine(text);
  const answers = approval ? approval.options : ['yes', 'no'];
  const answer = approval ? `phm approvals answer ${approval.number} <${approval.options.join('|')}>`
    : ask ? `phm asks answer ${ref} yes|no`
      : `ashlr fleet needs-resolve ${id} --reply yes|no`;
  return {
    id, ref, title: cap(scrubSecrets(needsYouWords(text)) || 'Untitled item'),
    class: verdict.class, limit: verdict.limit, reason: verdict.reason, answers,
    forward: approval ? approval.options[0]! : 'go ahead', answer,
  };
}

/** Open items split by class, ledger order kept. Never throws. */
export function listNeedsYou(options: NeedsYouOptions = {}): NeedsYouList {
  const ledger = readNeedsMasonLedger({ runsDir: runsDirOf(options) });
  const open = ledger.items.filter(item => !item.resolved);
  const refs = shortIds(open);
  const items = open.map(item => itemOf(item.id, refs.get(item.id) ?? item.id.slice(3), item.text));
  const hardLimit = items.filter(item => item.class === 'hard_limit');
  const auto = items.filter(item => item.class === 'auto');
  return {
    schema: NEEDS_YOU_SCHEMA, ledger: ledger.status,
    counts: { hardLimit: hardLimit.length, auto: auto.length }, hardLimit, auto,
  };
}

/** Every hard-limit item as one message with a one-word reply each. Read-only; auto items never appear. */
export function batchNeedsYou(options: NeedsYouOptions = {}): NeedsYouBatch {
  const list = listNeedsYou(options);
  const items = list.hardLimit.map((item, i) => ({
    n: i + 1, id: item.id, ref: item.ref, title: item.title, reason: item.reason, answers: item.answers,
  }));
  const message = items.length ? [
    `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you:`,
    ...items.map(i => `${i.n}. ${i.title} (${i.reason}) — ${i.answers.join(' or ')}`),
    `Reply with one word each, like: ${items.map(i => `${i.n} ${i.answers[0]}`).join(', ')}`,
  ].join('\n') : '';
  return { schema: NEEDS_YOU_BATCH_SCHEMA, ledger: list.ledger, count: items.length, message, items };
}

/** Resolve every auto item with its forward action; a dry run reports the same records and writes nothing. */
export function resolveAutoNeedsYou(options: NeedsYouOptions & { dryRun?: boolean } = {}): NeedsYouResolveReport {
  const dryRun = options.dryRun === true;
  const runsDir = runsDirOf(options);
  const now = options.now ?? Date.now;
  const list = listNeedsYou({ ...options, runsDir });
  const resolved: NeedsYouAuditRecord[] = [], failed: NeedsYouResolveReport['failed'] = [];
  for (const item of list.auto) {
    const record: NeedsYouAuditRecord = {
      item: { id: item.id, title: item.title }, action: item.forward, at: new Date(now()).toISOString(), reason: item.reason,
    };
    if (dryRun) { resolved.push(record); continue; }
    let outcome: ReturnType<typeof resolveNeedsMason>;
    try {
      outcome = (options.resolve ?? resolveNeedsMason)(
        { itemId: item.id, reply: `auto: ${record.action} (${record.reason})` },
        { runsDir, bus: options.bus, now, source: 'leader' },
      );
    } catch { outcome = { ok: false, code: 'unavailable', error: 'The resolve step threw.' }; }
    if (!outcome.ok && outcome.code !== 'already-resolved') { failed.push({ id: item.id, error: outcome.error }); continue; }
    try { appendFileSync(join(runsDir, NEEDS_YOU_AUDIT_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 }); }
    catch { failed.push({ id: item.id, error: 'Resolved, but the audit record could not be written.' }); continue; }
    resolved.push(record);
  }
  return { schema: NEEDS_YOU_RESOLVE_SCHEMA, dryRun, ledger: list.ledger, resolved, failed, hardLimit: list.counts.hardLimit };
}

const isRecord = (value: unknown): value is NeedsYouAuditRecord => {
  const r = value as NeedsYouAuditRecord | null;
  return !!r && typeof r === 'object' && typeof r.action === 'string' && typeof r.at === 'string'
    && typeof r.reason === 'string' && !!r.item && typeof r.item.id === 'string' && typeof r.item.title === 'string';
};

/** Audit records of auto-resolved items, oldest first; malformed lines are skipped. */
export function readNeedsYouAudit(options: Pick<NeedsYouOptions, 'runsDir'> = {}): NeedsYouAuditRecord[] {
  let text: string;
  try { text = readFileSync(join(runsDirOf(options), NEEDS_YOU_AUDIT_FILE), 'utf8'); } catch { return []; }
  const records: NeedsYouAuditRecord[] = [];
  for (const line of text.slice(-AUDIT_READ_MAX).split('\n')) {
    try { const parsed: unknown = JSON.parse(line); if (isRecord(parsed)) records.push(parsed); } catch { /* skip */ }
  }
  return records;
}
