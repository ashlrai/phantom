/**
 * `ashlr fleet release-chain` backing read (RQ-PHX-RELEASECHAINREAD85,
 * evidence join RQ-PHX-RELEASEEVIDENCEJOIN88).
 *
 * The desktop release chain ends at the Mac signer: `release-autorun.sh`
 * (Security-pinned, ops-side) writes `~/.ashlr-runs/release-sign/autorun/
 * sha-<sha>.rc` with the signing exit code, the signing wrapper leaves
 * per-run logs `release-sign/v<semver>-<epoch>.log`, and the autorun's
 * rev2 published-state pass writes `autorun/feed-<sha>.rc` (0 verified-live,
 * 21 verified-but-superseded, 22 failed) plus a `feed-<sha>.json` receipt
 * bound to the same sha (kind `desktop-update-channel-check`).
 *
 * Evidence honesty: the newest `sha-*.rc` proves only that *a* signing run
 * for that sha completed with that rc. Version and reason are attached to
 * that sha only through an existing durable record — a validated
 * `feed-<sha>.json` receipt, or a `v*.log` whose own bounded `START`
 * declaration names the same sha and the version in its file name. With no
 * proven join those fields stay null and `evidence` says why. rc=0 maps to
 * `published` only when `feed-<sha>.rc` proves the published-state check;
 * otherwise the verdict is `unknown` (signed, publication unproven).
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
const TAG_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REASON_LINE = /^\s*Reason:/;
const HELD_LINE = /\bheld\b/i;
/** Bounded declaration a signing log may carry, e.g. `START v3.30.8 <sha>`. */
const LOG_START = /^\s*START\s+v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\s+([0-9a-f]{4,64})\b/m;
const MIN_SHA_FIELD = 7;
const FEED_JSON_KIND = 'desktop-update-channel-check';
const REASON_MAX = 300;
/** A Reason/held line sits near the end of the log; 64 KiB of tail is ample. */
const LOG_TAIL_BYTES = 64 * 1024;
/** The START declaration sits at the top of the log; 8 KiB of head is ample. */
const LOG_HEAD_BYTES = 8 * 1024;
const RC_MAX_BYTES = 64;
const FEED_JSON_MAX_BYTES = 16 * 1024;
/** feed-<sha>.rc outcomes written by release-autorun rev2 (final once written). */
const FEED_PUBLISHED = new Set([0, 21]);
const FEED_FAILED = 22;

export type ReleaseChainVerdict = 'published' | 'held' | 'failed' | 'unknown';

export interface ReleaseChainAutorun {
  /** Sha the autorun signed, from the `sha-<sha>.rc` file name. */
  sha: string;
  /** Exit code the autorun recorded; null when unreadable or non-numeric. */
  rc: number | null;
  /** Marker mtime in ISO 8601; stands in for the run's completion time. */
  mtime: string;
}

export interface ReleaseChainEvidence {
  /** How `version` was bound to `latestAutorun.sha`: the validated
   *  `feed-<sha>.json` receipt tag, a `v*.log` START declaration matching
   *  sha+version, or `none` when no durable record proved the join. */
  versionJoin: 'feed-receipt' | 'log-field' | 'none';
  /** `feed-<sha>.rc` outcome for the selected sha (0 verified-live,
   *  21 verified-but-superseded, 22 failed); null when absent or unreadable. */
  feedRc: number | null;
  /** `state` from a `feed-<sha>.json` receipt that validated against this
   *  sha (e.g. `verified-live`, `failed`); null otherwise. */
  feedState: string | null;
  /** File name of the `v*.log` whose START declaration matched this sha and
   *  its own version; null when no log proved the join. */
  boundLog: string | null;
  /** Concise diagnostics explaining unproven or ambiguous joins. */
  diagnostics: string[];
}

export interface ReleaseChainStatus {
  /** Newest `release-sign/autorun/sha-<sha>.rc`, or null when none exist. */
  latestAutorun: ReleaseChainAutorun | null;
  /** Reason bound to the selected sha: the last `Reason:`/`held` line of a
   *  proven `v*.log`, else the `reason` code of a validated `feed-<sha>.json`
   *  failure receipt; null when no record proves the join. */
  reason: string | null;
  /** Release version proven to belong to the selected sha (feed receipt tag
   *  or bound log name); null when the join is unproven. */
  version: string | null;
  /** Installed app version, passed through from the caller. */
  installedVersion: string | null;
  verdict: ReleaseChainVerdict;
  /** Files actually read, so the reader can check them. */
  sources: string[];
  /** Additive join/publication diagnostics (RQ-PHX-RELEASEEVIDENCEJOIN88). */
  evidence: ReleaseChainEvidence;
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

/** `maxBytes` slice of a file — the tail when `fromEnd`, else the head. */
function readSlice(path: string, maxBytes: number, fromEnd: boolean): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, maxBytes);
    const position = fromEnd ? Math.max(0, stat.size - size) : 0;
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, position);
    return buffer.subarray(0, read).toString('utf8');
  } catch { return null; } finally { try { closeSync(fd); } catch { /* closed */ } }
}

function readTail(path: string, maxBytes: number): string | null {
  return readSlice(path, maxBytes, true);
}

function readHead(path: string, maxBytes: number): string | null {
  return readSlice(path, maxBytes, false);
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

/** sha fields match when equal or one is a prefix of the other (the autorun
 *  logs only the first 12 hex chars of a 40-char sha). */
function shaFieldMatches(a: string, b: string): boolean {
  const short = Math.min(a.length, b.length);
  return short >= MIN_SHA_FIELD && (a.startsWith(b) || b.startsWith(a));
}

interface BoundLog { path: string; name: string; version: string }

/** Newest `v<semver>-<epoch>.log` whose bounded START declaration names this
 *  sha and whose file-name version equals the declared one. Logs without a
 *  declaration, with a mismatched sha or version, or non-versioned names
 *  never bind. */
function findBoundLog(signDir: string, sha: string): { bound: BoundLog | null; unbound: number; claimed: number } {
  let names: string[];
  try { names = readdirSync(signDir); } catch { return { bound: null, unbound: 0, claimed: 0 }; }
  let best: (BoundLog & { mtimeMs: number }) | null = null;
  let unbound = 0;
  let claimed = 0;
  for (const name of names) {
    if (!RUN_LOG.test(name)) continue;
    const tag = VERSIONED_LOG.exec(name);
    if (tag === null) { unbound++; continue; }
    const path = join(signDir, name);
    const head = readHead(path, LOG_HEAD_BYTES);
    if (head === null) { unbound++; continue; }
    const start = LOG_START.exec(head);
    const declaredVersion = start === null ? null : `${start[1]}.${start[2]}.${start[3]}`;
    const declaredSha = start === null ? null : start[4]!;
    if (declaredVersion === null || declaredSha === null
      || declaredVersion !== `${tag[1]}.${tag[2]}.${tag[3]}`
      || !shaFieldMatches(declaredSha, sha)) { unbound++; continue; }
    claimed++;
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    const version = `${tag[1]}.${tag[2]}.${tag[3]}`;
    if (best === null || stat.mtimeMs > best.mtimeMs
      || (stat.mtimeMs === best.mtimeMs && name > best.name)) {
      best = { path, name, version, mtimeMs: stat.mtimeMs };
    }
  }
  return { bound: best === null ? null : { path: best.path, name: best.name, version: best.version }, unbound, claimed };
}

interface FeedReceipt { state: string | null; tag: string | null; reason: string | null }

/** `feed-<sha>.json` receipt, accepted only when it parses and its `kind` and
 *  `sha` fields bind it to the selected autorun sha. */
function readFeedReceipt(path: string, sha: string): FeedReceipt | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8').slice(0, FEED_JSON_MAX_BYTES); } catch { return null; }
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (typeof doc !== 'object' || doc === null) return null;
  const rec = doc as Record<string, unknown>;
  if (rec.kind !== FEED_JSON_KIND || rec.sha !== sha) return null;
  const tag = typeof rec.tag === 'string' && TAG_VERSION.test(rec.tag) ? rec.tag : null;
  const state = typeof rec.state === 'string' ? rec.state : null;
  const reason = typeof rec.reason === 'string' && rec.reason.trim() !== ''
    ? rec.reason.trim().slice(0, REASON_MAX) : null;
  return { state, tag, reason };
}

function versionOfTag(tag: string): string {
  return tag.slice(1);
}

export function readReleaseChainStatus(opts: ReleaseChainStatusOptions): ReleaseChainStatus {
  const signDir = join(opts.runsDir, 'release-sign');
  const autorunDir = join(signDir, 'autorun');
  const sources: string[] = [];
  const diagnostics: string[] = [];

  let latestAutorun: ReleaseChainAutorun | null = null;
  const rcFile = newestEntry(autorunDir, AUTORUN_RC);
  if (rcFile !== null) {
    sources.push(rcFile.path);
    latestAutorun = {
      sha: AUTORUN_RC.exec(rcFile.name)![1]!,
      rc: readAutorunRc(rcFile.path),
      mtime: rcFile.mtime.toISOString(),
    };
  }

  const sha = latestAutorun?.sha ?? null;
  const rc = latestAutorun?.rc ?? null;

  // Published-state proof exists only for a completed successful signing run.
  let feedRc: number | null = null;
  let feedState: string | null = null;
  let feedReceipt: FeedReceipt | null = null;
  if (sha !== null && rc === 0) {
    const feedRcPath = join(autorunDir, `feed-${sha}.rc`);
    const feedJsonPath = join(autorunDir, `feed-${sha}.json`);
    feedRc = readAutorunRc(feedRcPath);
    if (feedRc !== null) sources.push(feedRcPath);
    feedReceipt = readFeedReceipt(feedJsonPath, sha);
    if (feedReceipt !== null) {
      sources.push(feedJsonPath);
      feedState = feedReceipt.state;
    } else {
      diagnostics.push(`feed-${sha}.json missing or not bound to this sha`);
    }
    if (feedRc === null) {
      diagnostics.push(`sha-${sha}.rc=0 but no feed-${sha}.rc: signing completed, publication unproven`);
    }
  }

  // Version/reason join: prefer the validated feed receipt tag, then a log
  // whose own START declaration proves sha+version. Never the newest log.
  let version: string | null = null;
  let versionJoin: ReleaseChainEvidence['versionJoin'] = 'none';
  let reason: string | null = null;
  let boundLogName: string | null = null;
  if (sha !== null) {
    if (feedReceipt?.tag != null) {
      version = versionOfTag(feedReceipt.tag);
      versionJoin = 'feed-receipt';
    }
    const { bound, unbound, claimed } = findBoundLog(signDir, sha);
    if (bound !== null) {
      if (version === null) {
        version = bound.version;
        versionJoin = 'log-field';
      }
      boundLogName = bound.name;
      sources.push(bound.path);
      reason = lastReasonLine(bound.path);
      if (claimed > 1) diagnostics.push(`${claimed} logs declare sha ${sha}; used newest ${bound.name}`);
    } else if (unbound > 0) {
      diagnostics.push(`${unbound} signing log(s) under release-sign/ do not prove a join to sha ${sha}`);
    }
    if (reason === null && feedReceipt?.reason != null) reason = feedReceipt.reason;
  }

  const verdict: ReleaseChainVerdict = latestAutorun === null || rc === null ? 'unknown'
    : rc === 12 ? 'held'
    : rc === 0 ? (feedRc !== null && FEED_PUBLISHED.has(feedRc) ? 'published'
      : feedRc === FEED_FAILED ? 'failed' : 'unknown')
    : 'failed';

  return {
    latestAutorun, reason, version,
    installedVersion: opts.installedVersion ?? null,
    verdict, sources,
    evidence: { versionJoin, feedRc, feedState, boundLog: boundLogName, diagnostics },
  };
}
