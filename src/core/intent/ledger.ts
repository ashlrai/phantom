/**
 * Intent ledger operations. Callers pass a clock and a state root so tests
 * never touch a real home directory. Linking a merged pull or a shipped
 * release updates the matching item. A stale sweep re-queues live work or
 * proposes superseded closure. Nothing here calls the network.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ledgerFilePresent, readLedger, writeLedger } from './store.js';
import {
  DEFAULT_STALE_AFTER_MS,
  INTENT_LEDGER_SCHEMA,
  IntentError,
  MAX_EVIDENCE,
  MAX_INTENT_ITEMS,
  MAX_OWNER,
  MAX_PROVENANCE,
  MAX_PRS,
  MAX_RQ,
  MAX_SOURCE,
  MAX_TITLE,
  isIntentStatus,
  normalizeRq,
  pullKey,
  rqKeysIn,
  sameDirective,
  titleIsPartial,
  validIntentId,
  validRepo,
  type IntentEvidence,
  type IntentItem,
  type IntentLedger,
  type IntentProvenance,
  type IntentPull,
  type IntentStatus,
} from './schema.js';

export interface IntentSummary {
  schema: typeof INTENT_LEDGER_SCHEMA;
  present: boolean;
  items: number;
  tracked: number;
  merged: number;
  shipped: number;
  verified: number;
  stale: number;
  partial: number;
  staleItems: Array<{ id: string; title: string; status: IntentStatus }>;
}

export interface IntentAddInput {
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
  rq?: string[];
  evidence?: { ref: string; note?: string };
  partial?: boolean;
  now?: string;
}

export interface MergedPullNote {
  repo: string;
  number: number;
  title: string;
  branch?: string;
  url?: string;
  at?: string;
}

export interface ShippedReleaseNote {
  release: string;
  notes?: string;
  rq?: string[];
  at?: string;
}

export interface SweepRow {
  id: string;
  title: string;
  action: 'requeue' | 'propose-superseded' | 'close-superseded' | 'await-verification';
  status: IntentStatus;
}

const DONE = new Set<IntentStatus>(['shipped', 'verified', 'superseded', 'closed']);
const OPEN_FOR_MERGE = new Set<IntentStatus>(['proposed', 'queued', 'in-progress', 'unknown']);
const OPEN_FOR_SHIP = new Set<IntentStatus>(['proposed', 'queued', 'in-progress', 'unknown', 'merged']);

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

function pushEvidence(item: IntentItem, row: IntentEvidence): void {
  item.evidence = [...item.evidence, row].slice(-MAX_EVIDENCE);
}

function newId(): string {
  return `int-${randomBytes(8).toString('hex')}`;
}

export function isStale(item: IntentItem, nowMs: number): boolean {
  if (DONE.has(item.status)) return false;
  const touched = Date.parse(item.lastTouchedAt);
  if (!Number.isFinite(touched)) return true;
  return nowMs - touched > item.staleAfterMs;
}

export function summarize(ledger: IntentLedger, nowMs: number, present = true): IntentSummary {
  const staleItems = ledger.items.filter((item) => isStale(item, nowMs)).map((item) => ({
    id: item.id, title: item.title, status: item.status,
  }));
  return {
    schema: INTENT_LEDGER_SCHEMA,
    present,
    items: ledger.items.length,
    tracked: ledger.items.filter((item) => item.rq.length > 0).length,
    merged: ledger.items.filter((item) => item.status === 'merged').length,
    shipped: ledger.items.filter((item) => item.status === 'shipped').length,
    verified: ledger.items.filter((item) => item.status === 'verified').length,
    stale: staleItems.length,
    partial: ledger.items.filter((item) => item.partial).length,
    staleItems,
  };
}

function provenance(input: { source: string; date?: string | null; verbatim?: boolean; partial?: boolean }): IntentProvenance {
  const date = input.date && !Number.isNaN(Date.parse(input.date)) ? input.date : null;
  return {
    source: clip(input.source, MAX_SOURCE, 'Provenance source'),
    date,
    verbatim: input.verbatim === true,
    partial: input.partial === true,
  };
}

function addProvenance(item: IntentItem, row: IntentProvenance): void {
  const known = item.provenance.some((existing) => existing.source === row.source && existing.date === row.date && existing.verbatim === row.verbatim);
  if (known) return;
  item.provenance = [...item.provenance, row].slice(-MAX_PROVENANCE);
}

function rank(status: IntentStatus): number {
  switch (status) {
    case 'unknown': return 0;
    case 'proposed': return 1;
    case 'queued': return 2;
    case 'in-progress': return 3;
    case 'merged': return 4;
    case 'shipped': return 5;
    case 'verified': return 6;
    case 'closed': return 7;
    case 'superseded': return 8;
    default: {
      const neverStatus: never = status;
      throw new IntentError(`Unknown status ${String(neverStatus)}.`);
    }
  }
}

function preferStatus(current: IntentStatus, incoming: IntentStatus): IntentStatus {
  if (current === 'verified' || incoming === 'verified') return 'verified';
  if (current === 'superseded' || incoming === 'superseded') return 'superseded';
  if (current === 'closed' || incoming === 'closed') return 'closed';
  return rank(incoming) > rank(current) ? incoming : current;
}

function mergePulls(item: IntentItem, pulls: IntentPull[]): void {
  const seen = new Set(item.prs.map(pullKey));
  for (const pull of pulls) {
    const key = pullKey(pull);
    if (seen.has(key)) {
      const existing = item.prs.find((row) => pullKey(row) === key);
      if (existing && pull.state === 'merged') existing.state = 'merged';
      if (existing && pull.url && !existing.url) existing.url = pull.url;
      continue;
    }
    if (item.prs.length >= MAX_PRS) break;
    seen.add(key);
    item.prs.push(pull);
  }
}

function absorb(target: IntentItem, incoming: IntentItem, at: string): void {
  const rq = [...new Set([...target.rq, ...incoming.rq])];
  if (rq.length > MAX_RQ) throw new IntentError(`An intent can track at most ${MAX_RQ} RQ keys.`);
  target.rq = rq;
  mergePulls(target, incoming.prs);
  target.status = preferStatus(target.status, incoming.status);
  target.partial = target.partial || incoming.partial;
  if (incoming.closureProposal === 'superseded') target.closureProposal = 'superseded';
  for (const row of incoming.provenance) addProvenance(target, row);
  for (const row of incoming.evidence) pushEvidence(target, row);
  if (Date.parse(incoming.lastTouchedAt) > Date.parse(target.lastTouchedAt)) target.lastTouchedAt = incoming.lastTouchedAt;
  target.updatedAt = at;
}

function draftItem(input: IntentAddInput, at: string): IntentItem {
  const title = clip(input.title, MAX_TITLE, 'Title');
  const source = clip(input.source, MAX_SOURCE, 'Source');
  const owner = clip(input.owner ?? 'owner', MAX_OWNER, 'Owner');
  const rq = [...new Set((input.rq ?? []).map(normalizeRq))];
  if (rq.length > MAX_RQ) throw new IntentError(`An intent can track at most ${MAX_RQ} RQ keys.`);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 365 * 24 * 60 * 60 * 1000) {
    throw new IntentError('Stale timer must be between 1 minute and 365 days, in milliseconds.');
  }
  const partial = input.partial === true || titleIsPartial(title);
  const status = input.status ?? 'proposed';
  if (!isIntentStatus(status)) throw new IntentError('Unknown status.');
  const id = input.id ?? newId();
  if (!validIntentId(id)) throw new IntentError('Intent id must be 1 to 81 letters, digits, or . _ : -.');
  return {
    id, title, source, owner, rq, prs: [], status,
    evidence: [],
    provenance: [provenance({ source, date: input.date ?? at, verbatim: input.verbatim, partial })],
    partial,
    closureProposal: null,
    lastTouchedAt: at,
    staleAfterMs,
    createdAt: at,
    updatedAt: at,
  };
}

function place(ledger: IntentLedger, incoming: IntentItem, at: string): { item: IntentItem; deduped: boolean } {
  const matches = ledger.items.filter((item) => sameDirective(item, incoming));
  if (matches.length === 0) {
    if (ledger.items.some((item) => item.id === incoming.id)) incoming.id = newId();
    if (ledger.items.length >= MAX_INTENT_ITEMS) throw new IntentError(`The intent ledger holds at most ${MAX_INTENT_ITEMS} items.`);
    ledger.items.push(incoming);
    return { item: incoming, deduped: false };
  }
  const target = matches[0]!;
  absorb(target, incoming, at);
  for (const extra of matches.slice(1)) {
    absorb(target, extra, at);
    ledger.items = ledger.items.filter((item) => item.id !== extra.id);
  }
  return { item: target, deduped: true };
}

export async function listIntents(opts: { root?: string; status?: IntentStatus; nowMs?: number } = {}): Promise<{ items: IntentItem[]; summary: IntentSummary }> {
  const ledger = await readLedger(opts.root);
  const items = opts.status ? ledger.items.filter((item) => item.status === opts.status) : ledger.items;
  return { items, summary: summarize(ledger, opts.nowMs ?? Date.now(), true) };
}

export async function getIntent(id: string, root?: string): Promise<IntentItem | null> {
  const ledger = await readLedger(root);
  return ledger.items.find((item) => item.id === id) ?? null;
}

export async function addIntent(input: IntentAddInput, root?: string): Promise<IntentItem> {
  const at = nowIso(input.now);
  const ledger = await readLedger(root);
  const { item } = place(ledger, draftItem(input, at), at);
  await writeLedger(ledger, root);
  return item;
}

export async function updateIntent(id: string, patch: IntentUpdateInput, root?: string): Promise<IntentItem> {
  const at = nowIso(patch.now);
  const ledger = await readLedger(root);
  const item = ledger.items.find((row) => row.id === id);
  if (!item) throw new IntentError('Intent not found. Run phm intent list.');
  if (patch.title !== undefined) {
    item.title = clip(patch.title, MAX_TITLE, 'Title');
    if (titleIsPartial(item.title)) item.partial = true;
  }
  if (patch.source !== undefined) item.source = clip(patch.source, MAX_SOURCE, 'Source');
  if (patch.owner !== undefined) item.owner = clip(patch.owner, MAX_OWNER, 'Owner');
  if (patch.status !== undefined) {
    if (!isIntentStatus(patch.status)) throw new IntentError('Unknown status.');
    item.status = patch.status;
  }
  if (patch.partial !== undefined) item.partial = patch.partial;
  if (patch.rq) {
    const rq = [...new Set([...item.rq, ...patch.rq.map(normalizeRq)])];
    if (rq.length > MAX_RQ) throw new IntentError(`An intent can track at most ${MAX_RQ} RQ keys.`);
    item.rq = rq;
  }
  if (patch.evidence) {
    const ref = clip(patch.evidence.ref, MAX_SOURCE, 'Evidence');
    pushEvidence(item, { at, kind: 'verification', ref, ...(patch.evidence.note ? { note: clip(patch.evidence.note, MAX_TITLE, 'Evidence note') } : {}) });
    if (item.status === 'shipped' || item.status === 'merged') item.status = 'verified';
  }
  item.lastTouchedAt = at;
  item.updatedAt = at;
  await writeLedger(ledger, root);
  return item;
}

interface MacSeed {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  date?: unknown;
  rq_key?: unknown;
  rq?: unknown;
  status?: unknown;
  owner?: unknown;
  verbatim?: unknown;
  partial?: unknown;
  staleAfterMs?: unknown;
}

function statusOf(value: unknown): IntentStatus {
  if (typeof value !== 'string') return 'unknown';
  const text = value.trim().toLowerCase();
  if (isIntentStatus(text)) return text;
  if (text === 'open') return 'in-progress';
  if (text === 'done' || text === 'complete') return 'verified';
  return 'unknown';
}

function rqOf(row: MacSeed): string[] {
  const keys: string[] = [];
  if (typeof row.rq_key === 'string' && row.rq_key.trim()) keys.push(...rqKeysIn(row.rq_key));
  if (typeof row.rq === 'string') keys.push(...rqKeysIn(row.rq));
  if (Array.isArray(row.rq)) {
    for (const key of row.rq) if (typeof key === 'string') keys.push(...rqKeysIn(key));
  }
  return [...new Set(keys)];
}

function soft(value: string, max: number): { text: string; clipped: boolean } {
  const text = value.replace(/[\r\n]+/g, ' ').trim();
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, max - 1).trimEnd()}…`, clipped: true };
}

function itemFromRecord(row: MacSeed, fileSource: string, at: string): IntentItem | null {
  if (typeof row.title !== 'string' || !row.title.trim()) return null;
  const title = soft(row.title, MAX_TITLE);
  const sourceText = typeof row.source === 'string' && row.source.trim() ? row.source : fileSource;
  const source = soft(sourceText, MAX_SOURCE).text;
  const date = typeof row.date === 'string' ? row.date : null;
  const touched = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : at;
  const owner = soft(typeof row.owner === 'string' && row.owner.trim() ? row.owner : 'owner', MAX_OWNER).text;
  const item = draftItem({
    id: typeof row.id === 'string' && validIntentId(row.id) ? row.id : undefined,
    title: title.text,
    source,
    owner,
    rq: [...new Set([...rqOf(row), ...rqKeysIn(title.text)])],
    status: statusOf(row.status),
    staleAfterMs: typeof row.staleAfterMs === 'number' ? row.staleAfterMs : undefined,
    verbatim: row.verbatim === true,
    date,
    partial: row.partial === true || title.clipped || titleIsPartial(row.title),
    now: touched,
  }, touched);
  item.createdAt = touched;
  item.updatedAt = at;
  item.lastTouchedAt = touched;
  return item;
}

function rowsFromDocument(parsed: unknown, path: string): MacSeed[] {
  if (Array.isArray(parsed)) return parsed.filter((row): row is MacSeed => !!row && typeof row === 'object');
  if (parsed && typeof parsed === 'object') {
    const doc = parsed as { items?: unknown };
    if (Array.isArray(doc.items)) return doc.items.filter((row): row is MacSeed => !!row && typeof row === 'object');
    return [parsed as MacSeed];
  }
  throw new IntentError(`Could not parse ${path}. Use JSONL or one JSON document.`);
}

async function recordsFromFile(path: string): Promise<MacSeed[]> {
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return rowsFromDocument(JSON.parse(trimmed) as unknown, path); }
    catch (error) {
      if (error instanceof IntentError || !raw.includes('\n')) {
        throw error instanceof IntentError ? error : new IntentError(`Could not parse ${path}. Use JSONL or one JSON document.`);
      }
    }
  }
  const rows: MacSeed[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as MacSeed);
    } catch {
      throw new IntentError(`A line in ${path} is not JSON.`);
    }
  }
  return rows;
}

export async function importIntentFiles(paths: string[], opts: { root?: string; now?: string } = {}): Promise<{ imported: number; deduped: number; items: number }> {
  if (paths.length === 0) throw new IntentError('Name at least one JSONL or JSON file. Example: phm intent import seed-ledger.json');
  const at = nowIso(opts.now);
  const ledger = await readLedger(opts.root);
  let imported = 0;
  let deduped = 0;
  for (const path of paths) {
    const fileSource = path.split(/[\\/]/).pop() || 'import';
    for (const row of await recordsFromFile(path)) {
      const item = itemFromRecord(row, fileSource, at);
      if (!item) continue;
      const placed = place(ledger, item, at);
      if (placed.deduped) deduped += 1;
      else imported += 1;
    }
  }
  await writeLedger(ledger, opts.root);
  return { imported, deduped, items: ledger.items.length };
}

/** A known key counts when the text carries it, including `cursor/RQ-DONE-1-fix`. */
function carriedKeys(text: string, known: readonly string[]): string[] {
  const upper = text.toUpperCase();
  const embedded = known.filter((key) => {
    let from = 0;
    while (from <= upper.length) {
      const at = upper.indexOf(key, from);
      if (at < 0) return false;
      const before = at === 0 ? '' : upper[at - 1] ?? '';
      const after = upper[at + key.length] ?? '';
      if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
      from = at + key.length;
    }
    return false;
  });
  return [...new Set([...rqKeysIn(text), ...embedded])];
}

function findByKeys(ledger: IntentLedger, keys: string[]): IntentItem[] {
  if (keys.length === 0) return [];
  return ledger.items.filter((item) => item.rq.some((key) => keys.includes(key)));
}

export function linkMergedPull(ledger: IntentLedger, pull: MergedPullNote, at?: string): IntentItem[] {
  if (!validRepo(pull.repo) || !Number.isSafeInteger(pull.number) || pull.number < 1) {
    throw new IntentError('A merged pull needs owner/name and a pull number.');
  }
  const when = nowIso(at ?? pull.at);
  const known = [...new Set(ledger.items.flatMap((item) => item.rq))];
  const keys = [...new Set([...carriedKeys(pull.title, known), ...carriedKeys(pull.branch ?? '', known)])];
  const matched = findByKeys(ledger, keys);
  const linked: IntentPull = {
    repo: pull.repo, number: pull.number, state: 'merged',
    ...(pull.url ? { url: pull.url } : {}),
  };
  for (const item of matched) {
    mergePulls(item, [linked]);
    if (OPEN_FOR_MERGE.has(item.status)) item.status = 'merged';
    pushEvidence(item, { at: when, kind: 'pr', ref: `${pull.repo}#${pull.number}` });
    item.lastTouchedAt = when;
    item.updatedAt = when;
  }
  return matched;
}

export function markShipped(ledger: IntentLedger, release: ShippedReleaseNote, at?: string): IntentItem[] {
  const when = nowIso(at ?? release.at);
  const releaseId = clip(release.release, MAX_SOURCE, 'Release');
  const known = [...new Set(ledger.items.flatMap((item) => item.rq))];
  const keys = [...new Set([
    ...(release.rq ?? []).flatMap((key) => carriedKeys(key, known)),
    ...carriedKeys(release.notes ?? '', known),
  ])];
  const matched = findByKeys(ledger, keys);
  for (const item of matched) {
    if (OPEN_FOR_SHIP.has(item.status)) item.status = 'shipped';
    pushEvidence(item, { at: when, kind: 'release', ref: releaseId });
    item.lastTouchedAt = when;
    item.updatedAt = when;
  }
  return matched;
}

export async function noteMergedPulls(pulls: MergedPullNote[], opts: { root?: string; now?: string } = {}): Promise<{ updated: number }> {
  const ledger = await readLedger(opts.root);
  if (ledger.items.length === 0) return { updated: 0 };
  const at = nowIso(opts.now);
  const seen = new Set<string>();
  let updated = 0;
  for (const pull of pulls) {
    if (!validRepo(pull.repo)) continue;
    const matched = linkMergedPull(ledger, pull, at);
    for (const item of matched) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      updated += 1;
    }
  }
  if (updated > 0) await writeLedger(ledger, opts.root);
  return { updated };
}

export async function noteShippedRelease(release: ShippedReleaseNote, opts: { root?: string; now?: string } = {}): Promise<{ updated: number }> {
  const ledger = await readLedger(opts.root);
  if (ledger.items.length === 0) return { updated: 0 };
  const matched = markShipped(ledger, release, nowIso(opts.now ?? release.at));
  if (matched.length > 0) await writeLedger(ledger, opts.root);
  return { updated: matched.length };
}

function sweepAction(item: IntentItem): SweepRow['action'] {
  const requeued = item.evidence.some((row) => row.kind === 'sweep' && row.ref === 'requeue');
  const proposed = item.closureProposal === 'superseded';
  switch (item.status) {
    case 'in-progress':
      return 'requeue';
    case 'proposed':
    case 'queued':
    case 'unknown':
      if (proposed) return 'close-superseded';
      if (requeued || (item.rq.length === 0 && item.prs.length === 0)) return 'propose-superseded';
      return 'requeue';
    case 'merged':
      if (proposed) return 'close-superseded';
      if (item.evidence.some((row) => row.kind === 'sweep')) return 'propose-superseded';
      return 'await-verification';
    case 'shipped':
    case 'verified':
    case 'superseded':
    case 'closed':
      return 'await-verification';
    default: {
      const neverStatus: never = item.status;
      throw new IntentError(`Unknown status ${String(neverStatus)}.`);
    }
  }
}

function applySweep(item: IntentItem, at: string): SweepRow {
  const action = sweepAction(item);
  switch (action) {
    case 'requeue':
      item.status = 'queued';
      pushEvidence(item, { at, kind: 'sweep', ref: 'requeue', note: 'Re-queued by the stale sweep.' });
      break;
    case 'propose-superseded':
      item.closureProposal = 'superseded';
      pushEvidence(item, { at, kind: 'sweep', ref: 'propose-superseded', note: 'Proposed superseded closure.' });
      break;
    case 'close-superseded':
      item.status = 'superseded';
      pushEvidence(item, { at, kind: 'sweep', ref: 'close-superseded', note: 'Closed as superseded after a prior proposal.' });
      break;
    case 'await-verification':
      pushEvidence(item, { at, kind: 'sweep', ref: 'await-verification', note: 'Merged item is still waiting to ship or be verified.' });
      break;
    default: {
      const neverAction: never = action;
      throw new IntentError(`Unknown sweep action ${String(neverAction)}.`);
    }
  }
  item.lastTouchedAt = at;
  item.updatedAt = at;
  return { id: item.id, title: item.title, action, status: item.status };
}

export async function sweepStale(opts: { root?: string; apply?: boolean; now?: string } = {}): Promise<{ stale: SweepRow[]; applied: boolean }> {
  const at = nowIso(opts.now);
  const nowMs = Date.parse(at);
  const ledger = await readLedger(opts.root);
  const stale = ledger.items.filter((item) => isStale(item, nowMs));
  if (!opts.apply) {
    return { stale: stale.map((item) => ({ id: item.id, title: item.title, action: sweepAction(item), status: item.status })), applied: false };
  }
  const rows = stale.map((item) => applySweep(item, at));
  if (rows.length > 0) await writeLedger(ledger, opts.root);
  return { stale: rows, applied: true };
}

export async function intentSummary(opts: { root?: string; nowMs?: number } = {}): Promise<IntentSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    if (!await ledgerFilePresent(opts.root)) return summarize({ schema: INTENT_LEDGER_SCHEMA, items: [] }, nowMs, false);
    return summarize(await readLedger(opts.root), nowMs, true);
  } catch {
    return summarize({ schema: INTENT_LEDGER_SCHEMA, items: [] }, nowMs, false);
  }
}
