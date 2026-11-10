/**
 * `ashlr fleet release-chain` backing read (RQ-PHX-RELEASECHAINREAD85).
 *
 * The desktop release chain ends at the Mac signer: `release-autorun.sh`
 * (Security-pinned, ops-side) writes `~/.ashlr-runs/release-sign/autorun/
 * sha-<sha>.rc` with the signing exit code, and the signing wrapper leaves
 * per-run logs `release-sign/v<semver>-<epoch>.log`. When a release stalled
 * (rc=12 "Desktop update finalization held"), the only way to see it was to
 * dig through that directory by hand. This reader turns the newest run into
 * one verdict: published (rc 0), held (rc 12), failed (any other non-zero)
 * or unknown (nothing readable).
 *
 * READ-ONLY: nothing here writes under runsDir, touches the keychain, or
 * triggers a release. Missing directories yield `unknown`, never a throw.
 */

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Autorun completion markers. Fixture shas may be shorter than 40 hex. */
const AUTORUN_RC = /^sha-([0-9a-f]{4,64})\.rc$/;
/** Signing-run logs live directly under release-sign/ as v<semver>-<epoch>.log. */
const RUN_LOG = /\.log$/;
const VERSIONED_LOG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-\d+\.log$/;
const REASON_LINE = /^\s*Reason:/;
const HELD_LINE = /\bheld\b/i;
const REASON_MAX = 300;
/** A Reason/held line sits near the end of the log; 64 KiB of tail is ample. */
const LOG_TAIL_BYTES = 64 * 1024;
const RC_MAX_BYTES = 64;

export type ReleaseChainVerdict = 'published' | 'held' | 'failed' | 'unknown';

export interface ReleaseChainAutorun {
  /** Sha the autorun signed, from the `sha-<sha>.rc` file name. */
  sha: string;
  /** Exit code the autorun recorded; null when unreadable or non-numeric. */
  rc: number | null;
  /** Marker mtime in ISO 8601; stands in for the run's completion time. */
  mtime: string;
}

export interface ReleaseChainStatus {
  /** Newest `release-sign/autorun/sha-<sha>.rc`, or null when none exist. */
  latestAutorun: ReleaseChainAutorun | null;
  /** Last `Reason:` line (or, failing that, last `held` line) of the newest
   *  `release-sign/*.log`, trimmed to 300 chars; null when absent. */
  reason: string | null;
  /** Semver parsed from the log name `v<semver>-<epoch>.log`; null otherwise. */
  version: string | null;
  /** Installed app version, passed through from the caller. */
  installedVersion: string | null;
  verdict: ReleaseChainVerdict;
  /** Files actually read, so the reader can check them. Empty on `unknown`. */
  sources: string[];
}

export interface ReleaseChainStatusOptions {
  /** Root of `~/.ashlr-runs`; `release-sign/` is read beneath it. */
  runsDir: string;
  installedVersion?: string;
  /** Reserved for callers that bucket by observation time; unused today. */
  now?: Date;
}

interface Candidate { name: string; path: string; mtime: Date; mtimeMs: number }

/** Newest regular file in `dir` matching `pattern`; mtime desc, name desc on ties. */
function newestEntry(dir: string, pattern: RegExp): Candidate | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let best: Candidate | null = null;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    if (best === null || stat.mtimeMs > best.mtimeMs
      || (stat.mtimeMs === best.mtimeMs && name > best.name)) {
      best = { name, path, mtime: stat.mtime, mtimeMs: stat.mtimeMs };
    }
  }
  return best;
}

/** Last `maxBytes` of a file, or null. O_NOFOLLOW matches the status readers. */
function readTail(path: string, maxBytes: number): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    return buffer.subarray(0, read).toString('utf8');
  } catch { return null; } finally { try { closeSync(fd); } catch { /* closed */ } }
}

function lastReasonLine(path: string): string | null {
  const tail = readTail(path, LOG_TAIL_BYTES);
  if (tail === null) return null;
  let reason: string | null = null;
  let held: string | null = null;
  for (const line of tail.split('\n')) {
    if (REASON_LINE.test(line)) reason = line;
    else if (HELD_LINE.test(line)) held = line;
  }
  const picked = (reason ?? held)?.trim();
  return picked ? picked.slice(0, REASON_MAX) : null;
}

function readAutorunRc(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').slice(0, RC_MAX_BYTES).trim();
    return /^\d{1,3}$/.test(raw) ? Number(raw) : null;
  } catch { return null; }
}

export function readReleaseChainStatus(opts: ReleaseChainStatusOptions): ReleaseChainStatus {
  const signDir = join(opts.runsDir, 'release-sign');
  const sources: string[] = [];

  let latestAutorun: ReleaseChainAutorun | null = null;
  const rcFile = newestEntry(join(signDir, 'autorun'), AUTORUN_RC);
  if (rcFile !== null) {
    sources.push(rcFile.path);
    latestAutorun = {
      sha: AUTORUN_RC.exec(rcFile.name)![1]!,
      rc: readAutorunRc(rcFile.path),
      mtime: rcFile.mtime.toISOString(),
    };
  }

  let reason: string | null = null;
  let version: string | null = null;
  const logFile = newestEntry(signDir, RUN_LOG);
  if (logFile !== null) {
    sources.push(logFile.path);
    const tag = VERSIONED_LOG.exec(logFile.name);
    if (tag !== null) version = `${tag[1]}.${tag[2]}.${tag[3]}`;
    reason = lastReasonLine(logFile.path);
  }

  const verdict: ReleaseChainVerdict = latestAutorun === null || latestAutorun.rc === null ? 'unknown'
    : latestAutorun.rc === 0 ? 'published'
    : latestAutorun.rc === 12 ? 'held' : 'failed';
  return { latestAutorun, reason, version, installedVersion: opts.installedVersion ?? null, verdict, sources };
}
