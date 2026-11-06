/**
 * components/ask-bar/ask-bus.ts — the console's LOOPBACK bus for one-ask.
 *
 * The contract is the frozen `schema/ask.v1` pair (RQ-ONEASK-1-SCHEMA):
 * an ask is a versioned `ask.v1` envelope, its lifecycle is a stream of
 * `ask.status.v1` events. The types below mirror that contract; the core
 * validator lands with the intake/fan-out jobs, which remain the authority
 * — every envelope posted here is re-validated there.
 *
 * The bus itself is the page's own same-origin event plane — the same
 * `ashlr:*` CustomEvent fabric the shell and desktop contract already use
 * (`ashlr:command`, `ashlr:voice`, `ashlr:fleet`). "Loopback" is literal: a
 * post loops back into this document and to any bridge listening on the
 * window event; it never crosses the network. That keeps the bar honest
 * about what a post means: `queued` is the truth, "someone consumed it" is
 * not implied until an `ask.status.v1` event says so.
 *
 * Framework-free; AskBar wires the React half.
 */
import { scrubSecrets } from '../../../core/util/scrub.js';

// ---------------------------------------------------------------------------
// ask.v1 / ask.status.v1 — mirrored from the frozen schema pair
// ---------------------------------------------------------------------------

export const ASK_STATES = [
  'refused', 'queued', 'claimed', 'running', 'verifying', 'pr_open',
  'in_merge_queue', 'merged', 'reverted', 'publish_only', 'failed',
] as const;
export type AskState = (typeof ASK_STATES)[number];

export const ASK_POOLS = [
  'codex-cmp', 'codex-personal', 'claude', 'devin',
  'claude-api', 'local', 'cursor-cloud', 'grok-build',
] as const;
export type AskPool = (typeof ASK_POOLS)[number];

export interface AskBudget {
  tokens_max: number;
  usd_max: number;
  wall_s_max: number;
}

export interface AskV1 {
  schema: 'ask.v1';
  /** `RQ-ASK-<yyyymmdd>-<4-12 uppercase base32>` — the operator's correlation id. */
  id: string;
  text: string;
  /** The one repository the ask names; intake refuses anything broader. */
  repo: string;
  paths: string[];
  tier: 'work' | 'mid' | 'frontier';
  acceptance: string[];
  budget: AskBudget;
  /** Parallel jobs the fan-out may spend; the bar always asks for one. */
  n: number;
  pools_allowed: AskPool[];
  state: AskState;
  created_ts: string;
  job_ids: string[];
  pr: number | null;
  pr_url: string | null;
  refusal_reason: string | null;
}

export interface AskStatusV1 {
  schema: 'ask.status.v1';
  ask_id: string;
  job_id: string | null;
  state: AskState;
  pool: AskPool | null;
  ts: string;
  pr: number | null;
  pr_url: string | null;
  merged_at: string | null;
  reverted_at: string | null;
  checks: 'pending' | 'success' | 'failure' | null;
  reason: string | null;
  tokens_total: number | null;
  wall_s: number | null;
}

// ---------------------------------------------------------------------------
// The bus — two channels on the window's same-origin event plane
// ---------------------------------------------------------------------------

/** `ask.v1` posts: the bar writes, the intake bridge (or a test) listens. */
export const ASK_POST_EVENT = 'ashlr:ask';
/** `ask.status.v1` lifecycle events: a producer writes, surfaces listen. */
export const ASK_STATUS_EVENT = 'ashlr:ask-status';

const ASK_ID_PATTERN = /^RQ-ASK-[0-9]{8}-[A-Z0-9]{4,12}$/;
const ASK_JOB_ID_PATTERN = /^RQ-[A-Z0-9][A-Z0-9._-]{0,79}$/;
const ASK_REPO_PATTERN = /^ashlrai\/[a-z0-9][a-z0-9-]{0,60}$/;
/** The schema's timestamp: seconds precision, Z or an ±HH:MM offset. `toISOString()`'s `.sssZ` is NOT valid. */
const ASK_TS_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:?[0-9]{2}|Z)$/;
export const ASK_TEXT_MAX_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const nullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const nullableNum = (v: unknown): v is number | null => v === null || typeof v === 'number';
const optionalTimestamp = (v: unknown): boolean => v === null || (typeof v === 'string' && ASK_TS_PATTERN.test(v));

/** Fail closed: an event detail that is not a clean ask.status.v1 is dropped. */
export function isAskStatusV1(value: unknown): value is AskStatusV1 {
  if (!isRecord(value)) return false;
  return value['schema'] === 'ask.status.v1'
    && isStr(value['ask_id']) && ASK_ID_PATTERN.test(value['ask_id'])
    && (value['job_id'] === null || (isStr(value['job_id']) && ASK_JOB_ID_PATTERN.test(value['job_id'])))
    && (ASK_STATES as readonly string[]).includes(String(value['state']))
    && (value['pool'] === null || (ASK_POOLS as readonly string[]).includes(String(value['pool'])))
    && isStr(value['ts']) && ASK_TS_PATTERN.test(value['ts'])
    && nullableNum(value['pr']) && nullableStr(value['pr_url'])
    && optionalTimestamp(value['merged_at']) && optionalTimestamp(value['reverted_at'])
    && (value['checks'] === null || value['checks'] === 'pending' || value['checks'] === 'success' || value['checks'] === 'failure')
    && nullableStr(value['reason'])
    && nullableNum(value['tokens_total']) && nullableNum(value['wall_s']);
}

/**
 * Post an `ask.v1` envelope to the loopback bus. Synchronous, fire-and-forget;
 * the event is non-cancelable, so `false` only means there is no document to
 * post into (SSR, a detached test). A returned `true` means the bus took the
 * envelope — NOT that a consumer exists; the ask's own `state` ('queued') is
 * the honest signal.
 */
export function postAskToBus(ask: AskV1): boolean {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  return window.dispatchEvent(new CustomEvent<AskV1>(ASK_POST_EVENT, { detail: ask }));
}

/** Producer side of the status channel — the intake bridge posts; tests may too. */
export function postAskStatusToBus(status: AskStatusV1): boolean {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  return window.dispatchEvent(new CustomEvent<AskStatusV1>(ASK_STATUS_EVENT, { detail: status }));
}

/**
 * Subscribe to `ask.status.v1` on the bus. The event detail is untrusted —
 * it crossed a boundary — so it is narrowed before the handler sees it.
 */
export function subscribeAskStatus(handler: (status: AskStatusV1) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isAskStatusV1(detail)) handler(detail);
  };
  window.addEventListener(ASK_STATUS_EVENT, listener);
  return () => window.removeEventListener(ASK_STATUS_EVENT, listener);
}

/** Subscribe to `ask.v1` posts — for an intake bridge or a test consumer. */
export function subscribeAskPosts(handler: (ask: AskV1) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    // The intake bridge re-validates with the core schema validator; this
    // structural floor keeps junk details from being treated as asks at all.
    if (isRecord(detail) && detail['schema'] === 'ask.v1'
      && isStr(detail['id']) && ASK_ID_PATTERN.test(detail['id'])
      && isStr(detail['text'])) {
      handler(detail as unknown as AskV1);
    }
  };
  window.addEventListener(ASK_POST_EVENT, listener);
  return () => window.removeEventListener(ASK_POST_EVENT, listener);
}

// ---------------------------------------------------------------------------
// Building an envelope — the schema's floor, checked before the post
// ---------------------------------------------------------------------------

const ASK_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** `RQ-ASK-<yyyymmdd>-<8 chars>` — sortable by day, collision-safe per page. */
export function newAskId(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = new Uint32Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let suffix = '';
  for (const n of bytes) suffix += ASK_ID_ALPHABET[n % ASK_ID_ALPHABET.length];
  return `RQ-ASK-${day}-${suffix}`;
}

export interface AskTarget {
  repo: string;
  tier: AskV1['tier'];
  budget: AskBudget;
}

export type BuildAskResult = { ok: true; ask: AskV1 } | { ok: false; error: string };

/**
 * Turn the operator's text into a schema-valid `ask.v1` in `queued` state.
 * Scope fields the bar cannot honestly know stay empty — `paths`,
 * `acceptance` and `pools_allowed` are the fan-out's to derive — and the
 * same secret-shape rule the schema validator enforces runs here first, so
 * a credential pasted into the box never reaches the bus at all.
 */
export function buildAsk(text: string, target: AskTarget, now: Date = new Date()): BuildAskResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Describe the change first.' };
  if (trimmed.length > ASK_TEXT_MAX_CHARS) return { ok: false, error: `Keep it under ${ASK_TEXT_MAX_CHARS} characters.` };
  if (scrubSecrets(trimmed) !== trimmed) return { ok: false, error: 'That looks like a credential — asks cannot carry secrets.' };
  if (!ASK_REPO_PATTERN.test(target.repo)) return { ok: false, error: `The ask needs one ashlrai/<repo> target, got "${target.repo}".` };
  return {
    ok: true,
    ask: {
      schema: 'ask.v1',
      id: newAskId(now),
      text: trimmed,
      repo: target.repo,
      paths: [],
      tier: target.tier,
      acceptance: [],
      budget: target.budget,
      n: 1,
      pools_allowed: [],
      state: 'queued',
      // The frozen ts pattern takes seconds only — toISOString's .sssZ would not validate.
      created_ts: `${now.toISOString().slice(0, 19)}Z`,
      job_ids: [],
      pr: null,
      pr_url: null,
      refusal_reason: null,
    },
  };
}
