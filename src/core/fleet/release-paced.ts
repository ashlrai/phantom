/**
 * Opt-in pacing wrapper around advanceReleaseCandidateOnce
 * (RQ-PHX-RELEASEPACEDRETRY05SSN2). A supervisor retrying a failed candidate
 * in a tight loop gets `deferred` until `retryAfterMs` has elapsed since the
 * last ACCEPTED dispatch; once due the call is delegated unchanged, so the
 * refreshed evidence, dedupe and terminal-failure rules of
 * release-advance-once.ts still decide whether anything is submitted.
 *
 * State scope: LOCAL host, per repo/tag, under
 * `$ASHLR_HOME/fleet/release-paced/<owner>/<name>/<tag>/` (never the cwd):
 * `.planner-cycle/` (advisory lock, never stolen) and `pace.json` (tmp+rename).
 * Only an accepted submitted dispatch writes a timestamp; rejected, failed and
 * dry-run calls write nothing.
 *
 * The cooldown is local cadence only. It remembers the prior candidate sha for
 * reporting but never carries eligibility across SHAs: a repointed tag can be
 * conservatively deferred for at most `retryAfterMs`, then the underlying
 * call decides on the new sha.
 *
 * Clock rollback: a recorded timestamp in the future of `now` is never
 * trusted. It is ignored (`clock-rollback`) and the call delegates, so a
 * deferral can never outlast `retryAfterMs` from the current clock reading.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import { scrubSecrets } from '../util/scrub.js';
import { acquirePlannerCycleLock } from './planner-cycle-lock.js';
import { advanceReleaseCandidateOnce, type ReleaseAdvanceOnceOptions, type ReleaseAdvanceOnceReport } from './release-advance-once.js';

export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 3_600_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_STATE_BYTES = 4096;

export type ReleasePacedOutcome = ReleaseAdvanceOnceReport['outcome'] | 'deferred';
export type ReleasePacedState = 'none' | 'cooling' | 'due' | 'clock-rollback' | 'unreadable' | 'recorded' | 'record-failed';

export interface ReleasePacedRecord { version: 1; repo: string; tag: string; candidateSha: string; acceptedAtMs: number }

export interface ReleasePacedReport {
  version: 1;
  repo: string;
  tag: string;
  apply: boolean;
  retryAfterMs: number;
  outcome: ReleasePacedOutcome;
  reason: string;
  pace: ReleasePacedState;
  /** ISO time the cooldown ends; set only when deferred. */
  nextEligibleAt: string | null;
  /** Candidate sha of the last accepted dispatch; set when a record was read. */
  priorCandidateSha: string | null;
  /** Underlying report; null when deferred, busy or refused before delegating. */
  once: ReleaseAdvanceOnceReport | null;
}

export interface ReleasePacedOptions {
  apply?: boolean;
  retryAfterMs?: number;
  /** Test seam: replaces the pacing state root (not the underlying once state). */
  stateDir?: string;
  now?: () => number;
  /** Underlying once call; defaults to the real advanceReleaseCandidateOnce. */
  once?: (repo: string, tag: string, opts: ReleaseAdvanceOnceOptions) => Promise<ReleaseAdvanceOnceReport>;
  /** Forwarded to the underlying call (gh runner). */
  runner?: ReleaseAdvanceOnceOptions['runner'];
}

function stateRoot(): string {
  const configured = process.env.ASHLR_HOME;
  return typeof configured === 'string' && configured !== '' && isAbsolute(configured)
    ? configured : join(homedir(), '.ashlr');
}

function paceDir(stateDir: string | undefined, repo: string, tag: string): string | null {
  const [owner, name, ...rest] = repo.split('/');
  if (rest.length || !owner || !NAME.test(name ?? '') || !TAG.test(tag)
    || !OWNER.test(owner) || owner.endsWith('-') || owner.includes('--')
    || name === '.' || name === '..') return null;
  return join(stateDir ?? join(stateRoot(), 'fleet', 'release-paced'), owner, name, tag);
}

/** Bounded read; anything malformed or for another repo/tag is `unreadable`, which only disables pacing. */
function readState(path: string, repo: string, tag: string): ReleasePacedRecord | 'absent' | 'unreadable' {
  try {
    if (statSync(path).size > MAX_STATE_BYTES) return 'unreadable';
    const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return row !== null && typeof row === 'object' && row.version === 1 && row.repo === repo && row.tag === tag
      && SHA.test(String(row.candidateSha)) && Number.isSafeInteger(row.acceptedAtMs) && (row.acceptedAtMs as number) >= 0
      ? row as unknown as ReleasePacedRecord : 'unreadable';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

function writeState(dir: string, record: ReleasePacedRecord): void {
  const tmp = join(dir, `.pace-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(dir, 'pace.json'));
  fsyncDirectory(dir);
}

const brief = (error: unknown): string => scrubSecrets(String(error)).replace(/[\r\n]+/g, ' ').slice(0, 200);

export async function advanceReleaseCandidatePaced(
  repo: string,
  tag: string,
  opts: ReleasePacedOptions = {},
): Promise<ReleasePacedReport> {
  const once = opts.once ?? advanceReleaseCandidateOnce;
  const now = opts.now ?? Date.now;
  const apply = opts.apply === true;
  const retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const report: ReleasePacedReport = {
    version: 1, repo, tag, apply, retryAfterMs, outcome: 'unavailable', reason: 'pending',
    pace: 'none', nextEligibleAt: null, priorCandidateSha: null, once: null,
  };
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < MIN_RETRY_AFTER_MS || retryAfterMs > MAX_RETRY_AFTER_MS) {
    report.reason = 'invalid_retry_after'; return report;
  }
  const dir = paceDir(opts.stateDir, repo, tag);
  if (dir === null) { report.reason = 'invalid_target'; return report; }
  const delegate = async (patch: ReleaseAdvanceOnceOptions): Promise<ReleaseAdvanceOnceReport | null> => {
    try {
      const inner = await once(repo, tag, { runner: opts.runner, now, ...patch });
      report.once = inner; report.outcome = inner.outcome; report.reason = inner.reason;
      return inner;
    } catch (error) { report.reason = `error:${brief(error)}`; return null; }
  };
  if (!apply) { await delegate({}); return report; }
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch (error) { report.reason = `state_dir_unavailable:${brief(error)}`; return report; }
  const lock = acquirePlannerCycleLock(dir);
  if (lock.state === 'busy') { report.outcome = 'busy'; report.reason = 'pace_lock_contended'; return report; }
  if (lock.state !== 'acquired') { report.reason = 'pace_lock_storage_unsafe'; return report; }
  try {
    const prior = readState(join(dir, 'pace.json'), repo, tag);
    if (prior === 'unreadable') report.pace = 'unreadable';
    else if (prior !== 'absent') {
      const t = now();
      report.priorCandidateSha = prior.candidateSha;
      if (prior.acceptedAtMs > t) report.pace = 'clock-rollback';
      else if (t < prior.acceptedAtMs + retryAfterMs) {
        report.pace = 'cooling'; report.outcome = 'deferred'; report.reason = 'retry_cooldown';
        report.nextEligibleAt = new Date(prior.acceptedAtMs + retryAfterMs).toISOString();
        return report;
      } else report.pace = 'due';
    }
    const inner = await delegate({ apply: true });
    const sha = inner?.advance?.candidate.sha ?? null;
    if (inner?.outcome === 'submitted' && inner.advance?.dispatch.accepted === true && sha !== null && SHA.test(sha)) {
      try {
        writeState(dir, { version: 1, repo, tag, candidateSha: sha, acceptedAtMs: now() });
        report.pace = 'recorded';
      } catch (error) {
        report.pace = 'record-failed';
        report.reason = `submitted_but_pace_failed:${brief(error)}`;
      }
    }
    return report;
  } finally { lock.release(); }
}
