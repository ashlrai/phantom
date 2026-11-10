/**
 * Direct create/update for the local intent ledger. Recovered from the
 * retained addIntent/updateIntent (PR #4235, 80f1d451) against the current
 * schema and store only. Each call reads, edits in memory and writes once via
 * writeLedger, so any refusal leaves the persisted bytes unchanged.
 */
import { randomBytes } from 'node:crypto';
import { readLedger, writeLedger } from './store.js';
import {
  DEFAULT_STALE_AFTER_MS, IntentError, MAX_EVIDENCE, MAX_INTENT_ITEMS, MAX_OWNER, MAX_PROVENANCE, MAX_PRS, MAX_RQ,
  MAX_SOURCE, MAX_TITLE, isIntentStatus, normalizeRq, pullKey, sameDirective, titleIsPartial, validIntentId,
  type IntentItem, type IntentLedger, type IntentProvenance, type IntentStatus,
} from './schema.js';

export interface IntentAddInput {
  /**
   * Stable caller-supplied source ID, validated with validIntentId. Omitted means a
   * generated ID. If it collides with a different directive, a fresh ID is generated
   * and the existing record is left untouched. Same-directive dedup keeps the existing ID.
   */
  id?: string;
  title: string;
  source: string;
  owner?: string;
  rq?: string[];
  status?: IntentStatus;
  staleAfterMs?: number;
  verbatim?: boolean;
  date?: string | null;
  partial?: boolean;
  now?: string;
}

export interface IntentUpdateInput {
  title?: string;
  source?: string;
  owner?: string;
  status?: IntentStatus;
  /** Added to the existing keys, never replacing them. */
  rq?: string[];
  /** Caller-reported verification note; it is tracking, not proof of deployment. */
  evidence?: { ref: string; note?: string };
  partial?: boolean;
  now?: string;
}

const RANK: Record<IntentStatus, number> = {
  unknown: 0, proposed: 1, queued: 2, 'in-progress': 3, merged: 4, shipped: 5, verified: 6, closed: 7, superseded: 8,
};

function nowIso(now?: string): string {
  const value = now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(value))) throw new IntentError('Time must be an ISO timestamp.');
  return value;
}

function clip(value: string, max: number, label: string): string {
  const text = value.replace(/[\r\n]+/g, ' ').trim();
  if (!text || text.length > max) throw new IntentError(`${label} must be 1 to ${max} characters.`);
  return text;
}

function status(value: string): IntentStatus {
  if (!isIntentStatus(value)) throw new IntentError('Unknown status.');
  return value;
}

function unionRq(current: string[], extra: string[]): string[] {
  const rq = [...new Set([...current, ...extra.map(normalizeRq)])];
  if (rq.length > MAX_RQ) throw new IntentError(`An intent can track at most ${MAX_RQ} RQ keys.`);
  return rq;
}

function preferStatus(current: IntentStatus, incoming: IntentStatus): IntentStatus {
  if (current === 'verified' || incoming === 'verified') return 'verified';
  if (current === 'superseded' || incoming === 'superseded') return 'superseded';
  if (current === 'closed' || incoming === 'closed') return 'closed';
  return RANK[incoming] > RANK[current] ? incoming : current;
}

function generatedId(): string {
  return `int-${randomBytes(8).toString('hex')}`;
}

function freshId(ledger: IntentLedger): string {
  let id = generatedId();
  while (ledger.items.some(item => item.id === id)) id = generatedId();
  return id;
}

function draft(input: IntentAddInput, at: string): IntentItem {
  if (input.id !== undefined && (typeof input.id !== 'string' || !validIntentId(input.id))) {
    throw new IntentError('Intent id must be 1 to 81 letters, digits, or . _ : -.');
  }
  const title = clip(input.title, MAX_TITLE, 'Title');
  const source = clip(input.source, MAX_SOURCE, 'Source');
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 365 * 24 * 60 * 60 * 1000) {
    throw new IntentError('Stale timer must be between 1 minute and 365 days, in milliseconds.');
  }
  const date = input.date === undefined ? at : input.date;
  if (date !== null && Number.isNaN(Date.parse(date))) throw new IntentError('Date must be an ISO timestamp.');
  const partial = input.partial === true || titleIsPartial(title);
  return {
    id: input.id ?? generatedId(), title, source, owner: clip(input.owner ?? 'owner', MAX_OWNER, 'Owner'),
    rq: unionRq([], input.rq ?? []), prs: [], status: status(input.status ?? 'proposed'), evidence: [],
    provenance: [{ source, date, verbatim: input.verbatim === true, partial }],
    partial, closureProposal: null, lastTouchedAt: at, staleAfterMs, createdAt: at, updatedAt: at,
  };
}

function addProvenance(item: IntentItem, row: IntentProvenance): void {
  const known = item.provenance.some(old => old.source === row.source && old.date === row.date && old.verbatim === row.verbatim);
  if (!known) item.provenance = [...item.provenance, row].slice(-MAX_PROVENANCE);
}

function absorb(target: IntentItem, incoming: IntentItem, at: string): void {
  target.rq = unionRq(target.rq, incoming.rq);
  const seen = new Set(target.prs.map(pullKey));
  for (const pull of incoming.prs) if (!seen.has(pullKey(pull)) && target.prs.length < MAX_PRS) target.prs.push(pull);
  target.status = preferStatus(target.status, incoming.status);
  target.partial = target.partial || incoming.partial;
  if (incoming.closureProposal === 'superseded') target.closureProposal = 'superseded';
  for (const row of incoming.provenance) addProvenance(target, row);
  target.evidence = [...target.evidence, ...incoming.evidence].slice(-MAX_EVIDENCE);
  if (Date.parse(incoming.lastTouchedAt) > Date.parse(target.lastTouchedAt)) target.lastTouchedAt = incoming.lastTouchedAt;
  target.updatedAt = at;
}

function place(ledger: IntentLedger, incoming: IntentItem, at: string): IntentItem {
  const matches = ledger.items.filter(item => sameDirective(item, incoming));
  if (matches.length === 0) {
    if (ledger.items.length >= MAX_INTENT_ITEMS) throw new IntentError(`The intent ledger holds at most ${MAX_INTENT_ITEMS} items.`);
    // A supplied ID that names a different directive never overwrites that record.
    if (ledger.items.some(item => item.id === incoming.id)) incoming.id = freshId(ledger);
    ledger.items.push(incoming);
    return incoming;
  }
  const target = matches[0]!;
  absorb(target, incoming, at);
  for (const extra of matches.slice(1)) {
    absorb(target, extra, at);
    ledger.items = ledger.items.filter(item => item.id !== extra.id);
  }
  return target;
}

/** Record a directive. A matching RQ key or normalized title merges into the existing record. */
export async function addIntent(input: IntentAddInput, root?: string): Promise<IntentItem> {
  const at = nowIso(input.now);
  const ledger = await readLedger(root);
  const item = place(ledger, draft(input, at), at);
  await writeLedger(ledger, root);
  return item;
}

/** Edit named fields, add RQ keys and append verification evidence (merged/shipped then become verified). */
export async function updateIntent(id: string, patch: IntentUpdateInput, root?: string): Promise<IntentItem> {
  const at = nowIso(patch.now);
  const ledger = await readLedger(root);
  const item = ledger.items.find(row => row.id === id);
  if (!item) throw new IntentError('Intent not found. Run ashlr fleet intent-read list.');
  if (patch.title !== undefined) {
    item.title = clip(patch.title, MAX_TITLE, 'Title');
    if (titleIsPartial(item.title)) item.partial = true;
  }
  if (patch.source !== undefined) item.source = clip(patch.source, MAX_SOURCE, 'Source');
  if (patch.owner !== undefined) item.owner = clip(patch.owner, MAX_OWNER, 'Owner');
  if (patch.status !== undefined) item.status = status(patch.status);
  if (patch.partial !== undefined) item.partial = patch.partial;
  if (patch.rq) item.rq = unionRq(item.rq, patch.rq);
  if (patch.evidence) {
    const ref = clip(patch.evidence.ref, MAX_SOURCE, 'Evidence');
    const note = patch.evidence.note ? { note: clip(patch.evidence.note, MAX_TITLE, 'Evidence note') } : {};
    item.evidence = [...item.evidence, { at, kind: 'verification' as const, ref, ...note }].slice(-MAX_EVIDENCE);
    if (item.status === 'shipped' || item.status === 'merged') item.status = 'verified';
  }
  item.lastTouchedAt = at;
  item.updatedAt = at;
  await writeLedger(ledger, root);
  return item;
}
