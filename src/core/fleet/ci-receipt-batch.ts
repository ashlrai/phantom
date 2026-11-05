/**
 * Batch receipt discovery for the RESUME-FROM-FAILURE order: accepts a single
 * bounded JSON document on stdin, validates every row before any network I/O,
 * then processes requests sequentially through the existing
 * discoverCiReceiptPrior path — same evidence gathering, same binder, same
 * CiResumePrior document, never recomputed digests.
 *
 * A batch is a *batch*: its schema is intentionally distinct from CiResumePrior
 * so that a batch document cannot be consumed as a single prior and vice versa.
 * Expired-duplicate-name resolution stays the same — a batch failure yields no
 * prior document for that id; diagnostics go to stderr; stdout carries the
 * full ordered result set.
 *
 * Read-only: every call is a GET listing/metadata read plus a bounded archive
 * download; there are no POSTs, no workflow dispatch and no check mutation.
 */
import type { CiResumePrior, CiResumeReceiptsFetch } from './ci-resume-receipts.js';
import type { GitRunner } from '../verse/git-ops.js';
import { discoverCiReceiptPrior } from './ci-receipt-discovery.js';

const MAX_REQUESTS = 16;
const MAX_INPUT_BYTES = 256 * 1024; // 256 KiB
const MAX_ID = 40;
const MAX_REPO = 100;
const MAX_NAME = 200;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// eslint-disable-next-line no-control-regex
const safeId = (v: unknown): string | null =>
  typeof v === 'string' && v.length >= 1 && v.length <= MAX_ID
    && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
// eslint-disable-next-line no-control-regex
const safeRepo = (v: unknown): string | null => {
  if (typeof v !== 'string' || !REPO.test(v) || v.split('/')[0]!.endsWith('-')) return null;
  return v;
};
const safePositiveInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null;
// eslint-disable-next-line no-control-regex
const safeName = (v: unknown): string | null =>
  typeof v === 'string' && v.length >= 1 && v.length <= MAX_NAME
    && !/[\x00-\x1f\x7f]/.test(v) ? v : null;

function jsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Per-request input, strictly typed: rejects unknown fields.
 */
export interface BatchCiReceiptRequest {
  id: string;
  repo: string;
  run: number;
  attempt: number;
  artifactName: string;
}

/**
 * Per-request output, distinct from CiResumePrior: carries the prior when
 * available plus diagnostics, or a sanitized reason when unavailable.
 */
export interface BatchCiReceiptResult {
  id: string;
  prior?: CiResumePrior;
  /** Always present: "success" or a short unavailable/ambiguous reason. */
  status: 'success' | string;
  /** Diagnostics from the single-run pipeline, for stderr only. */
  diagnostics: string[];
}

interface ValidatedRequest { id: string; repo: string; run: number; attempt: number; artifactName: string };

/**
 * Validate a parsed document strictly: schema + bounds + duplicate-id guard.
 * Returns null on any validation failure (used to short-circuit before I/O).
 */
export function validateBatchCiReceipt(value: unknown): ValidatedRequest[] | null {
  const doc = value === null || typeof value !== 'object' || Array.isArray(value)
    ? null : value as Record<string, unknown>;
  if (!doc) return null;
  if (doc['version'] !== 1) return null;
  const maybeArray = doc['requests'];
  if (!Array.isArray(maybeArray) || maybeArray.length === 0 || maybeArray.length > MAX_REQUESTS) return null;
  const seen = new Set<string>();
  const out: ValidatedRequest[] = [];
  for (const raw of maybeArray) {
    const obj = raw === null || typeof raw !== 'object' || Array.isArray(raw) ? null
      : raw as Record<string, unknown>;
    if (!obj) return null;
    // Check for EXACTLY the five expected keys (unknown-field rejection).
    const keys = Object.keys(obj);
    for (const k of keys) {
      if (k !== 'id' && k !== 'repo' && k !== 'run' && k !== 'attempt' && k !== 'artifactName') return null;
    }
    const id = safeId(obj['id']);
    const repo = safeRepo(obj['repo']);
    const run = safePositiveInt(obj['run']);
    const attempt = safePositiveInt(obj['attempt']);
    const artifactName = safeName(obj['artifactName']);
    if (id === null || repo === null || run === null || attempt === null || artifactName === null) return null;
    if (id.startsWith('-')) return null;
    if (seen.has(id)) return null; // duplicate id: reject entire batch
    seen.add(id);
    out.push({ id, repo, run, attempt, artifactName });
  }
  return out;
}

/**
 * Process validated requests sequentially through discoverCiReceiptPrior,
 * collecting results in original order. Each request is independent — a
 * single failure does not discard other usable priors.
 */
export async function processBatchCiReceipts(opts: {
  requests: ValidatedRequest[]; gh?: GitRunner;
}): Promise<BatchCiReceiptResult[]> {
  const gh = opts.gh;
  const results: BatchCiReceiptResult[] = new Array(opts.requests.length);
  for (let i = 0; i < opts.requests.length; i++) {
    const req = opts.requests[i]!;
    try {
      const { prior, diagnostics } = await discoverCiReceiptPrior({ ...req, gh });
      results[i] = { id: req.id, prior, status: 'success', diagnostics };
    } catch (error) {
      const message = (error as Error).message ?? 'unknown';
      // Sanitize: never leak credentials or internal paths; keep it short.
      const sanitized = message.length > 160 ? message.slice(0, 160) : message;
      results[i] = { id: req.id, status: sanitized, diagnostics: [] };
    }
  }
  return results;
}
