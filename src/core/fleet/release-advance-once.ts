/**
 * Single-host serialized variant of `ashlr fleet release-advance`
 * (RQ-PHX-RELEASEADVANCEONCE05SRP2). Multiple local release supervisors may
 * attempt the same candidate; GitHub can lag before the first accepted
 * workflow_dispatch appears in run lists, so the plain advance can
 * double-submit. This wrapper holds an atomic per-repo/tag lock under
 * `$ASHLR_HOME/fleet/release-advance-once/<owner>/<name>/<tag>/` (never the
 * cwd), runs the unchanged advanceReleaseCandidate inside it, and records an
 * accepted dispatch plus the exact candidate sha in receipt.json before
 * releasing the lock. A later call whose refreshed plan still names that sha
 * reports `already-submitted` instead of dispatching again — unless refreshed
 * evidence shows the recorded dispatch's own attest run terminally failed
 * (RQ-PHX-RELEASEONCERETRY05SRT1). Each receipt records `seenRunId`, the
 * newest attest run id visible when the dispatch was accepted; only a
 * completed non-success workflow_dispatch run on the same candidate with a
 * strictly newer run id counts as that attempt's outcome and lets the normal
 * refreshed eligibility decision run again. An older failed attempt (id at
 * or below the frontier), a scheduled run, in-flight or successful evidence,
 * an absent run (visibility lag) and a receipt written before `seenRunId`
 * existed all stay deduped — nothing is treated as failed by age alone.
 *
 * Scope: LOCAL host only. The lock is advisory across processes on this
 * machine; there is no global exactly-once. A crash between remote dispatch
 * acceptance and the local receipt write is irreducible — the next caller
 * cannot distinguish it and may submit again; the workflow's own guards and
 * a leaked (never auto-reclaimed) lock bound the damage. A repointed tag
 * resolves to a different candidate sha and never inherits the old receipt.
 * Rejected or failed dispatches record nothing, so retries stay possible.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync, fsyncSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';
import { fsyncDirectory } from '../util/durability.js';
import { acquirePlannerCycleLock } from './planner-cycle-lock.js';
import { advanceReleaseCandidate, type AttestInputs, type ReleaseAdvanceReport } from './release-advance.js';
import type { RunFact } from './release-candidate-plan.js';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_FIELD = 200;

export type ReleaseAdvanceOnceOutcome = ReleaseAdvanceReport['outcome'] | 'already-submitted' | 'busy';

export interface ReleaseAdvanceOnceReceipt {
  version: 1;
  repo: string;
  tag: string;
  candidateSha: string;
  submittedAt: string;
  ref: string | null;
  inputs: AttestInputs | null;
  /** Dispatch sequence on this candidate; absent on receipts predating it (treated as 1). */
  attempt?: number;
  /** Newest attest run id visible when this dispatch was accepted; a terminal
   *  failure must postdate it to count as this attempt's outcome. Absent on
   *  receipts predating it — their ordering is unknowable, so they never
   *  unlock. `null` means no attest run was visible at acceptance time. */
  seenRunId?: number | null;
}

export type ReleaseAdvanceOnceLock = 'not-taken' | 'acquired' | 'busy' | 'unsafe';
export type ReleaseAdvanceOnceReceiptState =
  'none' | 'matched' | 'stale-candidate' | 'terminal-failed' | 'recorded' | 'record-failed' | 'unreadable';

export interface ReleaseAdvanceOnceReport {
  version: 1;
  repo: string;
  tag: string;
  apply: boolean;
  outcome: ReleaseAdvanceOnceOutcome;
  reason: string;
  lock: ReleaseAdvanceOnceLock;
  receipt: { state: ReleaseAdvanceOnceReceiptState; record: ReleaseAdvanceOnceReceipt | null };
  /** Evidence from advanceReleaseCandidate; null when the lock refused entry. */
  advance: ReleaseAdvanceReport | null;
}

export interface ReleaseAdvanceOnceOptions {
  apply?: boolean;
  runner?: GitRunner;
  /** Test seam: replaces the whole per-candidate state root. */
  stateDir?: string;
  /** Test seam: defaults to advanceReleaseCandidate. */
  advance?: (repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner }) => Promise<ReleaseAdvanceReport>;
  now?: () => number;
}

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
    .replace(/[\r\n]+/g, ' ').slice(0, MAX_FIELD);

function stateRoot(): string {
  const configured = process.env.ASHLR_HOME;
  return typeof configured === 'string' && configured !== '' && isAbsolute(configured)
    ? configured : join(homedir(), '.ashlr');
}

/** Per-candidate directory; null when any segment is unsafe as a path part. */
function candidateDir(stateDir: string | undefined, repo: string, tag: string): string | null {
  const [owner, name, ...rest] = repo.split('/');
  if (rest.length || !owner || !NAME.test(name ?? '') || !TAG.test(tag)
    || !OWNER.test(owner) || owner.endsWith('-') || owner.includes('--')
    || name === '.' || name === '..') return null;
  return join(stateDir ?? join(stateRoot(), 'fleet', 'release-advance-once'), owner, name, tag);
}

type ReceiptRead = { state: 'absent' | 'unreadable' } | { state: 'present'; record: ReleaseAdvanceOnceReceipt };

function validInputs(v: unknown): v is AttestInputs {
  const o = v as Record<string, unknown>;
  return o !== null && typeof o === 'object'
    && ['ci_run_id', 'ci_run_attempt', 'build_artifact_id'].every(k => Number.isSafeInteger(o[k]))
    && SHA.test(String(o['candidate_sha']));
}

/** Bounded nofollow read; a receipt for another repo/tag or malformed JSON fails closed. */
function readReceipt(path: string, repo: string, tag: string): ReceiptRead {
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) return { state: 'unreadable' };
      const bytes = Buffer.alloc(stat.size);
      if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size) return { state: 'unreadable' };
      const row = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (row === null || typeof row !== 'object' || row.version !== 1) return { state: 'unreadable' };
      if (row.repo === repo && row.tag === tag) {
        if (!SHA.test(String(row.candidateSha)) || typeof row.submittedAt !== 'string'
          || row.submittedAt.length > 64 || !(row.ref === null || typeof row.ref === 'string')
          || (typeof row.ref === 'string' && row.ref.length > 100)
          || !(row.inputs === null || validInputs(row.inputs))
          || !(row.seenRunId === undefined || row.seenRunId === null
            || (Number.isSafeInteger(row.seenRunId) && (row.seenRunId as number) > 0))
          || !(row.attempt === undefined
            || (Number.isSafeInteger(row.attempt) && (row.attempt as number) >= 1))) return { state: 'unreadable' };
        return { state: 'present', record: row as unknown as ReleaseAdvanceOnceReceipt };
      }
      return { state: 'unreadable' };
    } finally { closeSync(fd); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' };
  }
}

/** tmp+rename+fsync so a torn write can never masquerade as an accepted dispatch. */
function writeReceipt(dir: string, record: ReleaseAdvanceOnceReceipt): void {
  const tmp = join(dir, `.receipt-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(dir, 'receipt.json'));
  fsyncDirectory(dir);
}

/**
 * The newest completed non-success workflow_dispatch attest run that can only
 * have been created after the recorded dispatch: headSha bound to the
 * recorded candidate (and to the gate inputs' candidate_sha when present) and
 * a run id strictly above the frontier captured at acceptance time. Returns
 * null — keeping the dedupe — when the receipt predates `seenRunId`, when the
 * inputs disagree with the recorded candidate, or when no such run exists.
 */
function boundTerminalFailure(probe: ReleaseAdvanceReport, record: ReleaseAdvanceOnceReceipt): RunFact | null {
  if (record.seenRunId === undefined) return null;
  if (record.inputs !== null && record.inputs.candidate_sha !== record.candidateSha) return null;
  const frontier = record.seenRunId ?? 0;
  let newest: RunFact | null = null;
  for (const r of probe.attestOnCandidate ?? []) {
    if (r.headSha !== record.candidateSha || r.event !== 'workflow_dispatch') continue;
    if (r.status !== 'completed' || r.conclusion === null || r.conclusion === 'success') continue;
    if (r.id <= frontier) continue;
    if (newest === null || r.id > newest.id) newest = r;
  }
  return newest;
}

/** Newest run id in a bounded candidate inventory; null when none were visible. */
function newestAttestRunId(runs: RunFact[] | undefined): number | null {
  let max = 0;
  for (const r of runs ?? []) if (r.id > max) max = r.id;
  return max === 0 ? null : max;
}

export async function advanceReleaseCandidateOnce(
  repo: string,
  tag: string,
  opts: ReleaseAdvanceOnceOptions = {},
): Promise<ReleaseAdvanceOnceReport> {
  const advance = opts.advance ?? advanceReleaseCandidate;
  const apply = opts.apply === true;
  const now = opts.now ?? Date.now;
  const report: ReleaseAdvanceOnceReport = {
    version: 1, repo, tag, apply, outcome: 'unavailable', reason: 'pending',
    lock: 'not-taken', receipt: { state: 'none', record: null }, advance: null,
  };
  const dir = candidateDir(opts.stateDir, repo, tag);
  if (dir === null) { report.reason = 'invalid_target'; return report; }
  if (!apply) {
    try {
      report.advance = await advance(repo, tag, { runner: opts.runner });
      report.outcome = report.advance.outcome;
      report.reason = report.advance.reason;
    } catch (error) { report.reason = `error:${clean(String(error))}`; }
    return report;
  }
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch (error) { report.reason = `state_dir_unavailable:${clean(String(error))}`; return report; }
  const lock = acquirePlannerCycleLock(dir);
  if (lock.state === 'busy') {
    report.lock = 'busy'; report.outcome = 'busy';
    report.reason = 'lock_contended'; return report;
  }
  if (lock.state !== 'acquired') {
    report.lock = 'unsafe'; report.outcome = 'unavailable';
    report.reason = 'lock_storage_unsafe'; return report;
  }
  report.lock = 'acquired';
  try {
    const seen = readReceipt(join(dir, 'receipt.json'), repo, tag);
    if (seen.state === 'unreadable') {
      report.receipt.state = 'unreadable'; report.reason = 'receipt_unreadable'; return report;
    }
    if (seen.state === 'present') {
      report.receipt.record = seen.record;
      let probe: ReleaseAdvanceReport;
      try { probe = await advance(repo, tag, { runner: opts.runner }); }
      catch (error) { report.reason = `probe_error:${clean(String(error))}`; return report; }
      // Only a resolved identical sha dedupes; any uncertainty falls through
      // to the full apply, whose own evidence gates the dispatch. On a
      // matching sha a terminal failure bound to the recorded dispatch (a
      // completed non-success dispatch run newer than the receipt's
      // seenRunId frontier) ends the dedupe the same way: the apply decides.
      if (probe.candidate.sha !== null && probe.candidate.sha === seen.record.candidateSha) {
        if (boundTerminalFailure(probe, seen.record) === null) {
          report.advance = probe;
          report.outcome = 'already-submitted'; report.reason = 'dispatch_recorded';
          report.receipt.state = 'matched'; return report;
        }
        report.receipt.state = 'terminal-failed';
      } else {
        report.receipt.state = 'stale-candidate';
      }
    }
    let inner: ReleaseAdvanceReport;
    try { inner = await advance(repo, tag, { apply: true, runner: opts.runner }); }
    catch (error) { report.reason = `error:${clean(String(error))}`; return report; }
    report.advance = inner;
    report.outcome = inner.outcome;
    report.reason = inner.reason;
    const sha = inner.candidate.sha;
    if (inner.outcome === 'submitted' && inner.dispatch.accepted && sha !== null && SHA.test(sha)) {
      const prior = seen.state === 'present' && report.receipt.state === 'terminal-failed' ? seen.record : null;
      const record: ReleaseAdvanceOnceReceipt = {
        version: 1, repo, tag, candidateSha: sha,
        submittedAt: new Date(now()).toISOString(), ref: inner.dispatch.ref, inputs: inner.dispatch.inputs,
        attempt: prior === null ? 1 : (prior.attempt ?? 1) + 1,
        seenRunId: newestAttestRunId(inner.attestOnCandidate),
      };
      try { writeReceipt(dir, record); report.receipt = { state: 'recorded', record }; }
      catch (error) { report.receipt.state = 'record-failed'; report.reason = `submitted_but_receipt_failed:${clean(String(error))}`; }
    }
    return report;
  } finally { lock.release(); }
}
