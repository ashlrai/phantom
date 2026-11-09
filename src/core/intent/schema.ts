/**
 * ashlr.intent-ledger/v1. One local record of owner directives and design
 * ideas: where each came from, which RQ key and pull it tracks, and whether
 * it has gone stale. The file lives in the owner's state directory, never in
 * the repository.
 */

export const INTENT_LEDGER_SCHEMA = 'ashlr.intent-ledger/v1' as const;

export const INTENT_STATUSES = [
  'proposed', 'queued', 'in-progress', 'merged', 'shipped', 'verified', 'superseded', 'closed', 'unknown',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INTENT_ITEMS = 2000;
export const MAX_TITLE = 300;
export const MAX_SOURCE = 200;
export const MAX_OWNER = 80;
export const MAX_RQ = 16;
export const MAX_PRS = 32;
export const MAX_EVIDENCE = 32;
export const MAX_PROVENANCE = 16;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const RQ_RE = /^RQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const RQ_SCAN = /\bRQ-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface IntentEvidence {
  at: string;
  kind: 'note' | 'pr' | 'release' | 'verification' | 'sweep' | 'import';
  ref: string;
  note?: string;
}

export interface IntentPull {
  repo: string;
  number: number;
  url?: string;
  state: 'open' | 'merged' | 'closed' | 'unknown';
}

/** Where a copy of the directive was read. `partial` means the source line was truncated. */
export interface IntentProvenance {
  source: string;
  date: string | null;
  verbatim: boolean;
  partial: boolean;
}

export interface IntentItem {
  id: string;
  title: string;
  source: string;
  owner: string;
  rq: string[];
  prs: IntentPull[];
  status: IntentStatus;
  evidence: IntentEvidence[];
  provenance: IntentProvenance[];
  partial: boolean;
  closureProposal: 'superseded' | null;
  lastTouchedAt: string;
  staleAfterMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntentLedger {
  schema: typeof INTENT_LEDGER_SCHEMA;
  items: IntentItem[];
}

export class IntentError extends Error {}

export function isIntentStatus(value: string): value is IntentStatus {
  return (INTENT_STATUSES as readonly string[]).includes(value);
}

export function rqKeysIn(text: string): string[] {
  const found = text.toUpperCase().match(RQ_SCAN) ?? [];
  return [...new Set(found.map((key) => key.toUpperCase()).filter((key) => RQ_RE.test(key)))];
}

export function normalizeRq(value: string): string {
  const key = value.trim().toUpperCase();
  if (!RQ_RE.test(key)) throw new IntentError('RQ keys look like RQ-INTENT-LEDGER-1.');
  return key;
}

/** Lowercase, collapsed whitespace, trailing ellipsis removed. Used only to dedup. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[.…]+$/u, '').replace(/\s+/g, ' ').slice(0, MAX_TITLE);
}

export function titleIsPartial(title: string): boolean {
  const trimmed = title.trimEnd();
  return trimmed.endsWith('...') || trimmed.endsWith('…');
}

export function validIntentId(id: string): boolean {
  return ID_RE.test(id);
}

export function emptyLedger(): IntentLedger {
  return { schema: INTENT_LEDGER_SCHEMA, items: [] };
}

function iso(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function isIntentItem(value: unknown): value is IntentItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item['id'] === 'string' && validIntentId(item['id'])
    && typeof item['title'] === 'string'
    && typeof item['source'] === 'string'
    && typeof item['owner'] === 'string'
    && Array.isArray(item['rq'])
    && Array.isArray(item['prs'])
    && typeof item['status'] === 'string' && isIntentStatus(item['status'])
    && Array.isArray(item['evidence'])
    && Array.isArray(item['provenance'])
    && typeof item['partial'] === 'boolean'
    && (item['closureProposal'] === null || item['closureProposal'] === 'superseded')
    && typeof item['lastTouchedAt'] === 'string' && iso(item['lastTouchedAt'])
    && typeof item['staleAfterMs'] === 'number' && Number.isSafeInteger(item['staleAfterMs']) && item['staleAfterMs'] > 0
    && typeof item['createdAt'] === 'string' && iso(item['createdAt'])
    && typeof item['updatedAt'] === 'string' && iso(item['updatedAt']);
}

export function isIntentLedger(value: unknown): value is IntentLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ledger = value as Record<string, unknown>;
  return ledger['schema'] === INTENT_LEDGER_SCHEMA && Array.isArray(ledger['items']) && ledger['items'].every(isIntentItem);
}

export function sameDirective(left: Pick<IntentItem, 'rq' | 'title'>, right: Pick<IntentItem, 'rq' | 'title'>): boolean {
  if (left.rq.some((key) => right.rq.includes(key))) return true;
  const title = normalizeTitle(left.title);
  return title.length > 0 && title === normalizeTitle(right.title);
}

export function pullKey(pull: Pick<IntentPull, 'repo' | 'number'>): string {
  return `${pull.repo.toLowerCase()}#${pull.number}`;
}

export function validRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}
