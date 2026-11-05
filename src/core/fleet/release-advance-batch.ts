/**
 * Bounded sequential batch over advanceReleaseCandidateOnce
 * (RQ-PHX-RELEASEBATCH05SRS2). One release supervisor can walk a small list
 * of repository/tag candidates through the existing serialized advance
 * action instead of launching one session per candidate. Input is one
 * bounded JSON document ({version:1,candidates:[{repo,tag}]}, 1..16 distinct
 * entries) that is parsed in full before any candidate runs.
 *
 * Each entry awaits in input order — at most one evidence/dispatch call is
 * ever in flight — and the per-candidate lock and receipt semantics stay
 * entirely inside advanceReleaseCandidateOnce; this module adds no lock of
 * its own. A normal blocked/refused/unavailable/busy report does not stop
 * the batch, so an unrelated repo can still advance; a thrown error becomes
 * a sanitized per-entry `unavailable` and the next candidate still runs.
 * `submitted` means gh accepted the workflow_dispatch — never that a
 * release was published, installed or notified.
 */
import { stripVTControlCharacters } from 'node:util';
import { scrubSecrets } from '../util/scrub.js';
import {
  advanceReleaseCandidateOnce,
  type ReleaseAdvanceOnceOptions,
  type ReleaseAdvanceOnceOutcome,
  type ReleaseAdvanceOnceReport,
} from './release-advance-once.js';

export const MAX_BATCH_INPUT_BYTES = 64 * 1024;
export const MAX_BATCH_CANDIDATES = 16;
const MAX_FIELD = 200;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** Outcomes that keep the aggregate batch successful. */
const SUCCESSFUL: ReadonlySet<ReleaseAdvanceOnceOutcome> = new Set(['planned', 'submitted', 'no-op', 'already-submitted']);

export interface ReleaseAdvanceBatchCandidate { repo: string; tag: string }

export interface ReleaseAdvanceBatchReport {
  version: 1;
  apply: boolean;
  total: number;
  succeeded: number;
  unsuccessful: number;
  /** Per-outcome tallies, only for outcomes that occurred. */
  counts: Partial<Record<ReleaseAdvanceOnceOutcome, number>>;
  /** "owner/name@vX.Y.Z" identities that produced an entry, in input order. */
  completed: string[];
  /** Identities that never produced an entry. Always empty today: the batch never stops early. */
  remaining: string[];
  entries: ReleaseAdvanceOnceReport[];
}

export interface ReleaseAdvanceBatchOptions extends Omit<ReleaseAdvanceOnceOptions, 'apply'> {
  apply?: boolean;
  /** Test seam: defaults to advanceReleaseCandidateOnce. */
  once?: (repo: string, tag: string, opts: ReleaseAdvanceOnceOptions) => Promise<ReleaseAdvanceOnceReport>;
}

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
    .replace(/[\r\n]+/g, ' ').slice(0, MAX_FIELD);

const identity = (candidate: ReleaseAdvanceBatchCandidate): string => `${candidate.repo}@${candidate.tag}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validRepo(repo: string): boolean {
  const [owner, name, ...rest] = repo.split('/');
  return rest.length === 0 && owner !== undefined && name !== undefined
    && OWNER.test(owner) && !owner.endsWith('-') && !owner.includes('--')
    && NAME.test(name) && name !== '.' && name !== '..';
}

function validCandidate(value: unknown): value is ReleaseAdvanceBatchCandidate {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('repo') || !keys.includes('tag')) return false;
  const { repo, tag } = value;
  return typeof repo === 'string' && typeof tag === 'string' && validRepo(repo) && TAG.test(tag);
}

export type ReleaseAdvanceBatchParse =
  | { ok: true; candidates: ReleaseAdvanceBatchCandidate[] }
  | { ok: false; reason: string };

/**
 * Parse the whole stdin document before any candidate executes. Rejects
 * malformed JSON, unknown or missing fields at any level, an unsupported
 * version, out-of-range or duplicate candidates, and invalid repo/tag text.
 */
export function parseReleaseAdvanceBatchInput(text: string): ReleaseAdvanceBatchParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isRecord(doc)) return { ok: false, reason: 'not_object' };
  const keys = Object.keys(doc);
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('candidates')) {
    return { ok: false, reason: 'unknown_or_missing_fields' };
  }
  if (doc.version !== 1) return { ok: false, reason: 'unsupported_version' };
  if (!Array.isArray(doc.candidates)
    || doc.candidates.length < 1 || doc.candidates.length > MAX_BATCH_CANDIDATES) {
    return { ok: false, reason: 'candidate_count' };
  }
  const seen = new Set<string>();
  const candidates: ReleaseAdvanceBatchCandidate[] = [];
  for (const entry of doc.candidates) {
    if (!validCandidate(entry)) return { ok: false, reason: 'candidate_invalid' };
    const key = `${entry.repo}\0${entry.tag}`;
    if (seen.has(key)) return { ok: false, reason: 'duplicate_candidate' };
    seen.add(key);
    candidates.push({ repo: entry.repo, tag: entry.tag });
  }
  return { ok: true, candidates };
}

/**
 * Run each candidate through the serialized advance in input order. The
 * bound is re-enforced here so a caller that skipped the parser can never
 * queue an unbounded list. Sequential await: the next candidate is not
 * touched until the current report exists.
 */
export async function runReleaseAdvanceBatch(
  candidates: readonly ReleaseAdvanceBatchCandidate[],
  opts: ReleaseAdvanceBatchOptions = {},
): Promise<ReleaseAdvanceBatchReport> {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_BATCH_CANDIDATES
    || !candidates.every(validCandidate)
    || new Set(candidates.map(candidate => `${candidate.repo}\0${candidate.tag}`)).size !== candidates.length) {
    throw new RangeError('invalid candidate list');
  }
  const once = opts.once ?? advanceReleaseCandidateOnce;
  const apply = opts.apply === true;
  const entries: ReleaseAdvanceOnceReport[] = [];
  const counts: Partial<Record<ReleaseAdvanceOnceOutcome, number>> = {};
  for (const { repo, tag } of candidates) {
    let report: ReleaseAdvanceOnceReport;
    try {
      report = await once(repo, tag, {
        apply, runner: opts.runner, stateDir: opts.stateDir, advance: opts.advance, now: opts.now,
      });
    } catch (error) {
      report = {
        version: 1, repo, tag, apply, outcome: 'unavailable',
        reason: `error:${clean(String(error))}`,
        lock: 'not-taken', receipt: { state: 'none', record: null }, advance: null,
      };
    }
    entries.push(report);
    counts[report.outcome] = (counts[report.outcome] ?? 0) + 1;
  }
  const succeeded = entries.filter(entry => SUCCESSFUL.has(entry.outcome)).length;
  return {
    version: 1, apply, total: candidates.length,
    succeeded, unsuccessful: candidates.length - succeeded, counts,
    completed: entries.map(entry => `${entry.repo}@${entry.tag}`),
    remaining: candidates.slice(entries.length).map(identity),
    entries,
  };
}
