/**
 * ashlr.intent-ledger/v1. One local record of owner directives and design
 * ideas: where each came from, which RQ key and pull it tracks, and whether
 * it has gone stale. The file lives in the owner's state directory, never in
 * the repository.
 */

import { MAX_RELEASE_REF } from './evidence.js';

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

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedArray(value: unknown, max: number, check: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= max && value.every(check);
}

function pull(value: unknown): boolean {
  return record(value) && typeof value['repo'] === 'string' && validRepo(value['repo'])
    && typeof value['number'] === 'number' && Number.isSafeInteger(value['number']) && value['number'] > 0
    && (value['url'] === undefined || typeof value['url'] === 'string')
    && ['open', 'merged', 'closed', 'unknown'].includes(value['state'] as string);
}

function evidence(value: unknown): boolean {
  return record(value) && typeof value['at'] === 'string' && iso(value['at'])
    && ['note', 'pr', 'release', 'verification', 'sweep', 'import'].includes(value['kind'] as string)
    && typeof value['ref'] === 'string' && (value['note'] === undefined || typeof value['note'] === 'string');
}

function provenance(value: unknown): boolean {
  return record(value) && typeof value['source'] === 'string' && value['source'].length <= MAX_SOURCE
    && (value['date'] === null || (typeof value['date'] === 'string' && iso(value['date'])))
    && typeof value['verbatim'] === 'boolean' && typeof value['partial'] === 'boolean';
}

export function isIntentItem(value: unknown): value is IntentItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item['id'] === 'string' && validIntentId(item['id'])
    && typeof item['title'] === 'string' && item['title'].length <= MAX_TITLE
    && typeof item['source'] === 'string' && item['source'].length <= MAX_SOURCE
    && typeof item['owner'] === 'string' && item['owner'].length <= MAX_OWNER
    && boundedArray(item['rq'], MAX_RQ, (key) => typeof key === 'string' && RQ_RE.test(key))
    && boundedArray(item['prs'], MAX_PRS, pull)
    && typeof item['status'] === 'string' && isIntentStatus(item['status'])
    && boundedArray(item['evidence'], MAX_EVIDENCE, evidence)
    && boundedArray(item['provenance'], MAX_PROVENANCE, provenance)
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
  return ledger['schema'] === INTENT_LEDGER_SCHEMA && boundedArray(ledger['items'], MAX_INTENT_ITEMS, isIntentItem);
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

/** Pure native evidence wire contract; handler and storage dependencies stay lazy. */
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const timestamp = { type: 'string', maxLength: 35, format: 'date-time' };
export const EVIDENCE_SCHEMAS = {
  intent_link: { type: 'object', properties: {
    repo: text(200), number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    title: text(MAX_TITLE), branch: text(MAX_TITLE), url: text(2048), at: timestamp,
  }, required: ['repo', 'number', 'title'], additionalProperties: false },
  intent_ship: { type: 'object', properties: {
    release: text(MAX_RELEASE_REF), notes: text(10000), rq: { type: 'array', minItems: 1, maxItems: MAX_RQ, items: text(200) }, at: timestamp,
  }, required: ['release'], additionalProperties: false },
} as const;

export type EvidenceToolName = keyof typeof EVIDENCE_SCHEMAS;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.trim().length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validate the complete wire contract without echoing caller input. */
export function validEvidenceArgs(name: EvidenceToolName, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const a = raw as Record<string, unknown>;
  const allowed = Object.keys(EVIDENCE_SCHEMAS[name].properties);
  if (Object.keys(a).some(key => !allowed.includes(key))) return false;
  if (a.at !== undefined && (!bounded(a.at, 35) || !ISO.test(a.at) || Number.isNaN(Date.parse(a.at)))) return false;
  if (name === 'intent_link') {
    return bounded(a.repo, 200) && validRepo(a.repo) && Number.isSafeInteger(a.number) && (a.number as number) > 0 &&
      bounded(a.title, MAX_TITLE) && (a.branch === undefined || bounded(a.branch, MAX_TITLE)) &&
      (a.url === undefined || bounded(a.url, 2048));
  }
  if (!bounded(a.release, MAX_RELEASE_REF) || (a.notes !== undefined && !bounded(a.notes, 10000)) ||
      (a.notes === undefined && a.rq === undefined)) return false;
  if (a.rq !== undefined) {
    if (!Array.isArray(a.rq) || a.rq.length < 1 || a.rq.length > MAX_RQ) return false;
    try { for (const key of a.rq) { if (!bounded(key, 200)) return false; normalizeRq(key); } } catch { return false; }
  }
  return true;
}
