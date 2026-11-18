/**
 * friction-ledger.ts — the friction-ledger seam (RQ-FRICTION-3-PLANNER).
 * RQ-FRICTION-2-LEDGER owns producers and signal metrics; until its PR lands
 * this module is the contract: one JSONL of FrictionItem rows, newest row per
 * id wins, reads fail-open, writes atomic temp+rename; a closed item is never
 * reopened — only the grader's 7d signal closes one.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FRICTION_MAX_ITEMS = 256;
export const FRICTION_MAX_BYTES = 256 * 1024;
/** Public-shape ledger id; queue lines carry it as `friction_id=<id>`. */
export const FRICTION_ID = /^[a-z][a-z0-9._-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/;
/** Consecutive DONE-NOOP retirements that turn a queue line into friction (PSEL-4's streak). */
export const NOOP_CHURN_STREAK = 2;

export interface FrictionItem {
  /** FRICTION_ID-shaped; carried verbatim as `friction_id` on lines and picks. */
  id: string;
  /** title <=160 chars is the headline; detail <=1000 the work-brief evidence. */
  title: string;
  detail: string;
  /** Ranking weight; higher = more friction. */
  score: number;
  /** Short fleet repo name; 'noop-streak'/'needs-you'/a FRICTION-2 writer tag. */
  repo: string;
  source: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
}

/** What a writer supplies; status and timestamps are the ledger's. */
export type FrictionInput = Pick<FrictionItem, 'id' | 'title' | 'score' | 'source'> & Partial<Pick<FrictionItem, 'detail' | 'repo'>>;

export const frictionLedgerPath = (home: string): string => join(home, '.ashlr', 'friction-ledger.jsonl');

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- ledger text stays one printable line per field.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const line = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

function parseItem(row: unknown): FrictionItem | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const title = line(r['title'], 160), score = r['score'], repo = typeof r['repo'] === 'string' ? r['repo'] : 'phantom';
  if (typeof r['id'] !== 'string' || !FRICTION_ID.test(r['id']) || title === '' || typeof score !== 'number'
    || !Number.isFinite(score) || score < 0 || (r['status'] !== 'open' && r['status'] !== 'closed')
    || !REPO.test(repo) || typeof r['source'] !== 'string' || r['source'] === '' || r['source'].length > 64
    || typeof r['openedAt'] !== 'string' || !Number.isFinite(Date.parse(r['openedAt']))) return null;
  return { id: r['id'], title, score, repo, source: r['source'], status: r['status'],
    detail: line(r['detail'], 1000), openedAt: r['openedAt'],
    ...(typeof r['closedAt'] === 'string' ? { closedAt: r['closedAt'] } : {}),
    ...(typeof r['closeReason'] === 'string' ? { closeReason: line(r['closeReason'], 160) } : {}) };
}

/** Read the ledger; last row per id wins. `{items, rejected}` — never throws. */
export function readFrictionLedger(path: string): { items: FrictionItem[]; rejected: number } {
  let text = '';
  try {
    if (statSync(path).size > FRICTION_MAX_BYTES) return { items: [], rejected: 1 };
    text = readFileSync(path, 'utf8');
  } catch { return { items: [], rejected: 0 }; }
  const items = new Map<string, FrictionItem>();
  let rejected = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const item = parseItem(JSON.parse(raw));
      if (item === null) rejected++; else items.set(item.id, item);
    } catch { rejected++; }
  }
  return { items: [...items.values()], rejected };
}

function writeLedger(path: string, items: readonly FrictionItem[]): void {
  const open = items.filter((i) => i.status === 'open').sort((a, b) => b.score - a.score);
  const rows = [...open, ...items.filter((i) => i.status === 'closed')].slice(0, FRICTION_MAX_ITEMS);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, rows.map((item) => `${JSON.stringify(item)}\n`).join(''), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Insert new friction or refresh an open item's evidence. Closed items stay closed. */
export function upsertFrictionItems(path: string, entries: readonly FrictionInput[], at: string): void {
  const items = new Map(readFrictionLedger(path).items.map((item) => [item.id, item]));
  let changed = false;
  for (const entry of entries) {
    const title = line(entry.title, 160);
    if (!FRICTION_ID.test(entry.id) || !Number.isFinite(entry.score) || entry.score < 0 || title === '') continue;
    const existing = items.get(entry.id);
    if (existing?.status === 'closed') continue;
    const repo = typeof entry.repo === 'string' && REPO.test(entry.repo) ? entry.repo : 'phantom';
    items.set(entry.id, existing
      ? { ...existing, title, detail: line(entry.detail, 1000) || existing.detail, repo, score: Math.max(existing.score, entry.score) }
      : { id: entry.id, title, detail: line(entry.detail, 1000), repo, source: line(entry.source, 64) || 'ledger', score: entry.score, status: 'open', openedAt: at });
    changed = true;
  }
  if (changed) writeLedger(path, [...items.values()]);
}

/** Mark open items closed. Only the grader's 7d signal and humans call this. */
export function closeFrictionItems(path: string, ids: readonly string[], at: string, reason: string): string[] {
  const want = new Set(ids);
  const closed: string[] = [];
  const next = readFrictionLedger(path).items.map((item) => {
    if (item.status !== 'open' || !want.has(item.id)) return item;
    closed.push(item.id);
    return { ...item, status: 'closed' as const, closedAt: at, closeReason: line(reason, 160) };
  });
  if (closed.length > 0) writeLedger(path, next);
  return closed;
}

/**
 * PSEL-4's `queue/noop-streak.json` ({job: {n, at, key}}): a line streaking
 * NOOP_CHURN_STREAK+ DONE-NOOPs becomes a ledger item. Pure.
 */
export function absorbNoopChurn(text: string): FrictionInput[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: FrictionInput[] = [];
  for (const [job, entry] of Object.entries(raw as Record<string, unknown>)) {
    const n = (entry as Record<string, unknown>)?.['n'];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(job) || !Number.isInteger(n) || (n as number) < NOOP_CHURN_STREAK) continue;
    out.push({
      id: `noop-streak:${job}`,
      title: `Queue line ${job} keeps retiring as DONE-NOOP`,
      detail: `${n} consecutive no-op retirements; the restocker parks the line 24h after its ${NOOP_CHURN_STREAK}nd, then the cycle repeats. Fix or retire the line's premise (anchors, precheck claim, file target) instead of re-picking it.`,
      score: 2 + (n as number), source: 'noop-streak',
    });
  }
  return out;
}

/** Absorb the restocker's live noop churn first when a streak file is in
 *  scope (fail-open), then serve the top open items, highest score first. */
export function collectFrictionTop(ledgerPath: string, noopPath?: string, count = 10): FrictionItem[] {
  if (noopPath !== undefined) {
    try {
      upsertFrictionItems(ledgerPath, absorbNoopChurn(readFileSync(noopPath, 'utf8')), new Date().toISOString());
    } catch { /* churn absorption never blocks the reader */ }
  }
  return readFrictionLedger(ledgerPath).items.filter((i) => i.status === 'open')
    .sort((a, b) => b.score - a.score || a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, count));
}
