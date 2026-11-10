/**
 * Provenance-aware import of directive JSON/JSONL files into the local intent
 * ledger. Extracted from the retained importIntentFiles (PR #4235, 80f1d451)
 * against the current schema and store only. Every input file is parsed before
 * the ledger lock is taken; the merge then runs inside transactIntentLedger
 * against the freshest ledger, so a bad file or a concurrent writer cannot
 * silently drop items and a refused import leaves the ledger untouched.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { transactIntentLedger } from './store.js';
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
  isIntentLedger,
  isIntentStatus,
  normalizeRq,
  pullKey,
  rqKeysIn,
  sameDirective,
  titleIsPartial,
  validIntentId,
  type IntentItem,
  type IntentLedger,
  type IntentProvenance,
  type IntentStatus,
} from './schema.js';

export interface IntentImportResult { imported: number; deduped: number; items: number }

type Row = Record<string, unknown>;

const MIN_STALE_MS = 60_000;
const MAX_STALE_MS = 365 * 24 * 60 * 60 * 1000;
const RANK: Record<IntentStatus, number> = {
  unknown: 0, proposed: 1, queued: 2, 'in-progress': 3, merged: 4, shipped: 5, verified: 6, closed: 7, superseded: 8,
};

/**
 * Only an exact ledger status is trusted. `done`/`complete` are vague text, so
 * they become `closed`, never `verified` or `shipped` (no release evidence).
 */
export function importStatus(value: unknown): IntentStatus {
  if (typeof value !== 'string') return 'unknown';
  const text = value.trim().toLowerCase();
  if (isIntentStatus(text)) return text;
  if (text === 'open') return 'in-progress';
  if (text === 'done' || text === 'complete') return 'closed';
  return 'unknown';
}

function soft(value: string, max: number): { text: string; clipped: boolean } {
  const text = value.replace(/[\r\n]+/g, ' ').trim();
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, max - 1).trimEnd()}…`, clipped: true };
}

function rqOf(row: Row): string[] {
  const keys: string[] = [];
  for (const field of [row['rq_key'], row['rq']]) {
    if (typeof field === 'string') keys.push(...rqKeysIn(field));
    else if (Array.isArray(field)) for (const key of field) if (typeof key === 'string') keys.push(...rqKeysIn(key));
  }
  return [...new Set(keys)];
}

function newId(): string {
  return `int-${randomBytes(8).toString('hex')}`;
}

function itemFromRow(row: Row, fileSource: string, at: string): IntentItem | null {
  const rawTitle = row['title'];
  if (typeof rawTitle !== 'string' || !rawTitle.trim()) return null;
  const title = soft(rawTitle, MAX_TITLE);
  const rawSource = row['source'];
  const source = soft(typeof rawSource === 'string' && rawSource.trim() ? rawSource : fileSource, MAX_SOURCE).text;
  const rawOwner = row['owner'];
  const owner = soft(typeof rawOwner === 'string' && rawOwner.trim() ? rawOwner : 'owner', MAX_OWNER).text;
  const rawDate = row['date'];
  const date = typeof rawDate === 'string' && !Number.isNaN(Date.parse(rawDate)) ? rawDate : null;
  const touched = date ? new Date(date).toISOString() : at;
  const rq = [...new Set([...rqOf(row), ...rqKeysIn(title.text)].map(normalizeRq))];
  if (rq.length > MAX_RQ) throw new IntentError(`An intent can track at most ${MAX_RQ} RQ keys.`);
  const stale = row['staleAfterMs'];
  const staleAfterMs = typeof stale === 'number' && Number.isSafeInteger(stale) && stale >= MIN_STALE_MS && stale <= MAX_STALE_MS
    ? stale : DEFAULT_STALE_AFTER_MS;
  const id = typeof row['id'] === 'string' && validIntentId(row['id']) ? row['id'] : newId();
  const partial = row['partial'] === true || title.clipped || titleIsPartial(rawTitle);
  return {
    id, title: title.text, source, owner, rq, prs: [], status: importStatus(row['status']),
    evidence: [],
    provenance: [{ source, date, verbatim: row['verbatim'] === true, partial }],
    partial,
    closureProposal: null,
    lastTouchedAt: touched,
    staleAfterMs,
    createdAt: touched,
    updatedAt: at,
  };
}

function rowsOf(parsed: unknown, path: string): Row[] {
  const isRow = (row: unknown): row is Row => !!row && typeof row === 'object' && !Array.isArray(row);
  if (Array.isArray(parsed)) return parsed.filter(isRow);
  if (isRow(parsed)) return Array.isArray(parsed['items']) ? parsed['items'].filter(isRow) : [parsed];
  throw new IntentError(`Could not parse ${basename(path)}. Use JSONL or one JSON document.`);
}

async function rowsFromFile(path: string): Promise<Row[]> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new IntentError(`Could not read ${basename(path)}.`); }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return rowsOf(JSON.parse(trimmed) as unknown, path); }
    catch (error) {
      // A single-line failure cannot be JSONL either; a multi-line one may be.
      if (error instanceof IntentError || !raw.includes('\n')) {
        throw error instanceof IntentError ? error : new IntentError(`Could not parse ${basename(path)}. Use JSONL or one JSON document.`);
      }
    }
  }
  const rows: Row[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { throw new IntentError(`A line in ${basename(path)} is not JSON.`); }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as Row);
  }
  return rows;
}

/**
 * A file that is one JSON document tagged `ashlr.intent-ledger/v1` is a native
 * ledger copy, not a bag of raw rows: its items already carry PRs, evidence,
 * provenance and real timestamps. The whole document must pass the ledger
 * schema; a tagged but invalid file fails the import instead of degrading to
 * rows. Untagged or unparsable files return null and keep the row path.
 */
async function nativeLedgerItems(path: string): Promise<IntentItem[] | null> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new IntentError(`Could not read ${basename(path)}.`); }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed) as unknown; }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if ((parsed as Row)['schema'] !== INTENT_LEDGER_SCHEMA) return null;
  if (!isIntentLedger(parsed)) {
    throw new IntentError(`${basename(path)} is tagged ${INTENT_LEDGER_SCHEMA} but is not a valid ledger.`);
  }
  return parsed.items;
}

function sameProvenance(left: IntentProvenance, right: IntentProvenance): boolean {
  return left.source === right.source && left.date === right.date && left.verbatim === right.verbatim;
}

/**
 * The same source read twice is one identity (source/date/verbatim): a complete
 * copy (`partial: false`) supersedes a truncated one regardless of import order.
 * The item's aggregate `partial` flag is not touched here; absorb keeps it
 * conservative (OR), so a partial source anywhere still marks the item partial.
 */
function addProvenance(item: IntentItem, row: IntentProvenance): void {
  const existing = item.provenance.find((p) => sameProvenance(p, row));
  if (existing) {
    if (existing.partial && !row.partial) existing.partial = false;
    return;
  }
  item.provenance = [...item.provenance, row].slice(-MAX_PROVENANCE);
}

/** Dedupes one item's own provenance rows by identity before it enters the ledger. */
function mergedProvenance(rows: IntentProvenance[]): IntentProvenance[] {
  const merged: IntentProvenance[] = [];
  for (const row of rows) {
    const existing = merged.find((p) => sameProvenance(p, row));
    if (existing) {
      if (existing.partial && !row.partial) existing.partial = false;
    } else {
      merged.push(row);
    }
  }
  return merged.slice(-MAX_PROVENANCE);
}

/** Never lowers a status; terminal states win, so an import cannot reopen work. */
function preferStatus(current: IntentStatus, incoming: IntentStatus): IntentStatus {
  for (const terminal of ['verified', 'superseded', 'closed'] as const) {
    if (current === terminal || incoming === terminal) return terminal;
  }
  return RANK[incoming] > RANK[current] ? incoming : current;
}

function absorb(target: IntentItem, incoming: IntentItem, at: string): void {
  const before = JSON.stringify(target);
  const rq = [...new Set([...target.rq, ...incoming.rq])];
  if (rq.length > MAX_RQ) throw new IntentError(`An intent can track at most ${MAX_RQ} RQ keys.`);
  target.rq = rq;
  for (const pull of incoming.prs) {
    const existing = target.prs.find((row) => pullKey(row) === pullKey(pull));
    if (existing) {
      if (pull.state === 'merged') existing.state = 'merged';
      if (pull.url && !existing.url) existing.url = pull.url;
    } else if (target.prs.length < MAX_PRS) target.prs.push(pull);
  }
  for (const row of incoming.evidence) {
    if (!target.evidence.some((entry) => entry.at === row.at && entry.kind === row.kind
      && entry.ref === row.ref && entry.note === row.note)) {
      target.evidence = [...target.evidence, row].slice(-MAX_EVIDENCE);
    }
  }
  target.status = preferStatus(target.status, incoming.status);
  target.partial = target.partial || incoming.partial;
  for (const row of incoming.provenance) addProvenance(target, row);
  if (Date.parse(incoming.lastTouchedAt) > Date.parse(target.lastTouchedAt)) target.lastTouchedAt = incoming.lastTouchedAt;
  // Repeating an identical import must not rewrite the record.
  if (JSON.stringify(target) !== before) target.updatedAt = at;
}

function place(ledger: IntentLedger, incoming: IntentItem, at: string): boolean {
  const matches = ledger.items.filter((item) => sameDirective(item, incoming));
  if (matches.length === 0) {
    if (ledger.items.some((item) => item.id === incoming.id)) incoming.id = newId();
    if (ledger.items.length >= MAX_INTENT_ITEMS) throw new IntentError(`The intent ledger holds at most ${MAX_INTENT_ITEMS} items.`);
    incoming.provenance = mergedProvenance(incoming.provenance);
    ledger.items.push(incoming);
    return false;
  }
  const target = matches[0]!;
  absorb(target, incoming, at);
  for (const extra of matches.slice(1)) {
    absorb(target, extra, at);
    ledger.items = ledger.items.filter((item) => item.id !== extra.id);
  }
  return true;
}

export async function importIntentFiles(paths: string[], opts: { root?: string; now?: string } = {}): Promise<IntentImportResult> {
  if (paths.length === 0) throw new IntentError('Name at least one JSONL or JSON file.');
  const at = opts.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) throw new IntentError('Time must be an ISO timestamp.');
  // Parse every input before acquiring the ledger lock: file reads and row
  // validation are side-effect free, and a failure here never touches the
  // persisted ledger or contends with other writers.
  const incoming: IntentItem[] = [];
  for (const path of paths) {
    const fileSource = basename(path) || 'import';
    const native = await nativeLedgerItems(path);
    if (native !== null) {
      incoming.push(...native);
      continue;
    }
    for (const row of await rowsFromFile(path)) {
      const item = itemFromRow(row, fileSource, at);
      if (item) incoming.push(item);
    }
  }
  return transactIntentLedger(opts.root, (ledger) => {
    let imported = 0;
    let deduped = 0;
    for (const item of incoming) {
      if (place(ledger, item, at)) deduped += 1;
      else imported += 1;
    }
    return { imported, deduped, items: ledger.items.length };
  });
}
