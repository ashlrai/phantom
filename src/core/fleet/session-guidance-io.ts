/**
 * session-guidance-io.ts — the filesystem side of per-session guidance
 * (RQ-PHX-SESSIONINTERJECT). The pure contract (strategy table, ack state
 * machine, file format) is session-guidance.ts.
 *
 * Phantom writes ONLY <runsDir>/queue/guidance/<job>.jsonl (append, modes
 * 0700/0600 — the umask-077 posture the order specifies — every byte
 * scrubbed, 4 KiB per message). dispatchd/launch.sh consume the file; their
 * changes are a Security proposal, not part of this module.
 *
 * Guardrails mirror job-stop.ts's append and runs-job-detail.ts's reads:
 * O_NOFOLLOW on every open, an owned single-link regular file or nothing is
 * written, descriptor-bound reads with a size cap, lstat before anything is
 * trusted, and scrubSecrets on every string that leaves the module.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub-secrets.js';
import {
  capGuidanceText,
  foldGuidanceLines,
  isGuidanceJobId,
  strategyForLane,
  GUIDANCE_DIR,
  GUIDANCE_FILE_MAX_BYTES,
  GUIDANCE_LIST_MAX_JOBS,
  GUIDANCE_SOURCE_MAX_CHARS,
  GUIDANCE_SOURCE_PATTERN,
  type FleetGuidanceListV1,
  type FleetGuidanceSessionV1,
  type FleetSessionGuidanceReadV1,
  type GuidanceDeliveryKind,
  type SessionGuidanceEntry,
} from './session-guidance.js';

const LANE_READ_BYTES = 16 * 1024;
const owned = (stat: { uid: number }): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

function guidanceFilePath(runsDir: string, job: string): string {
  return join(runsDir, GUIDANCE_DIR, `${job}.jsonl`);
}

// ---------------------------------------------------------------------------
// Lane + tier resolution (bounded reads, same contract as runs-job-detail)
// ---------------------------------------------------------------------------

/** Read up to maxBytes from a regular file; throws on anything else. */
async function readSlice(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('not a regular file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.size > maxBytes) throw new Error('invalid source');
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.toString('utf8', 0, offset);
  } finally {
    await handle.close();
  }
}

const LANESHAPE = /^[a-z0-9-]{1,32}$/;
const TIERSHAPE = /^[a-z0-9-]{1,20}$/;

/**
 * The lane a job runs on: `J.base.meta`'s `MODEL <lane> <tier> <model>` line
 * first, then `J.launch`'s `launched J <lane> pid <pid> base <sha>`. Answers
 * nulls, never throws — an unreadable runs dir just means the strategy
 * falls back to requeue.
 */
export async function readJobLaneAndTier(job: string, runsDir?: string): Promise<{ lane: string | null; tier: string | null }> {
  const root = runsDir ?? defaultRunsDir();
  try {
    const meta = await readSlice(join(root, `${job}.base.meta`), LANE_READ_BYTES);
    const m = /^MODEL\s+(\S+)\s+(\S+)\s+\S+/m.exec(meta);
    if (m) {
      return {
        lane: LANESHAPE.test(m[1]!) ? scrubSecrets(m[1]!) : null,
        tier: TIERSHAPE.test(m[2]!) ? scrubSecrets(m[2]!) : null,
      };
    }
  } catch { /* fall through to the launch record */ }
  try {
    const launch = await readSlice(join(root, `${job}.launch`), LANE_READ_BYTES);
    const pattern = new RegExp(`\\blaunched\\s+${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\S+)`);
    const m = pattern.exec(launch);
    if (m && LANESHAPE.test(m[1]!)) return { lane: scrubSecrets(m[1]!), tier: null };
  } catch { /* stays unknown */ }
  return { lane: null, tier: null };
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

export interface AppendSessionGuidanceOptions {
  /** Runs directory. Default ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
  /** Bounded display label ('fleet-console' default); odd shapes are dropped. */
  source?: string;
  /** Lane/tier override; when undefined they are read from the runs dir. */
  lane?: string | null;
  tier?: string | null;
  /** Message id override for tests; default g-<ms>-<8 hex>. */
  id?: string;
}

export type AppendSessionGuidanceResult =
  | {
      ok: true;
      job: string;
      id: string;
      at: string;
      source: string;
      lane: string | null;
      tier: string | null;
      strategy: GuidanceDeliveryKind;
      strategyFamily: string;
      state: 'queued';
      truncated: boolean;
    }
  | { ok: false; code: 'invalid-job' | 'empty' | 'unsafe-file' | 'write-failed' };

/** The guarded append lane-target-changes.log and job-stops.jsonl share. */
async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error('invalid sink');
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

/**
 * Append one guidance message to queue/guidance/<job>.jsonl. Never throws:
 * a bad id, an empty message, a link-shaped target or a filesystem failure
 * each answer a typed refusal instead. The text is scrubbed, trimmed and
 * capped at 4 KiB of UTF-8 before it is serialized; the serialized line is
 * scrubbed once more so nothing a caller smuggled past the first pass (a
 * lane or source field) can carry a secret into the file.
 */
export async function appendSessionGuidance(
  job: string,
  text: string,
  opts: AppendSessionGuidanceOptions = {},
): Promise<AppendSessionGuidanceResult> {
  if (!isGuidanceJobId(job)) return { ok: false, code: 'invalid-job' };
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const now = opts.now ?? Date.now;

  const capped = capGuidanceText(scrubSecrets(text).trim());
  if (capped.text === '') return { ok: false, code: 'empty' };

  const source = typeof opts.source === 'string' && GUIDANCE_SOURCE_PATTERN.test(opts.source)
    ? opts.source.slice(0, GUIDANCE_SOURCE_MAX_CHARS)
    : 'fleet-console';
  const resolved = opts.lane !== undefined || opts.tier !== undefined
    ? { lane: opts.lane ?? null, tier: opts.tier ?? null }
    : await readJobLaneAndTier(job, runsDir);
  const strategy = strategyForLane(resolved.lane);
  const id = opts.id ?? `g-${now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const at = new Date(now()).toISOString();

  const record = {
    v: 1,
    type: 'guidance',
    id,
    job,
    at,
    source,
    lane: resolved.lane,
    tier: resolved.tier,
    strategy: strategy.kind,
    text: capped.text,
    truncated: capped.truncated,
  };
  const path = guidanceFilePath(runsDir, job);
  try {
    const info = await lstat(path).catch(() => null);
    if (info !== null && !info.isFile()) return { ok: false, code: 'unsafe-file' };
    await mkdir(join(runsDir, GUIDANCE_DIR), { recursive: true, mode: 0o700 });
    await appendLine(path, `${scrubSecrets(JSON.stringify(record))}\n`);
  } catch {
    return { ok: false, code: 'write-failed' };
  }
  return {
    ok: true, job, id, at, source,
    lane: resolved.lane, tier: resolved.tier,
    strategy: strategy.kind, strategyFamily: strategy.family,
    state: 'queued', truncated: capped.truncated,
  };
}

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

const scrubEntry = (entry: SessionGuidanceEntry): SessionGuidanceEntry => ({
  ...entry,
  id: scrubSecrets(entry.id),
  at: scrubSecrets(entry.at),
  source: scrubSecrets(entry.source),
  lane: entry.lane === null ? null : scrubSecrets(entry.lane),
  tier: entry.tier === null ? null : scrubSecrets(entry.tier),
  text: scrubSecrets(entry.text),
  requeueTo: entry.requeueTo === null ? null : scrubSecrets(entry.requeueTo),
  ackAt: entry.ackAt === null ? null : scrubSecrets(entry.ackAt),
});

/**
 * Read one job's guidance file back through the fold. A missing file is
 * 'missing' with no entries; an unreadable or oversized one is 'degraded'
 * with whatever folded cleanly. Never throws.
 */
export async function readSessionGuidance(
  job: string,
  opts: { runsDir?: string; now?: () => number } = {},
): Promise<FleetSessionGuidanceReadV1> {
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const generatedAt = new Date((opts.now ?? Date.now)()).toISOString();
  const base: FleetSessionGuidanceReadV1 = {
    v: 1, job, generatedAt, sourceState: 'degraded',
    lane: null, strategy: 'requeue', pending: 0, entries: [], orphanAcks: 0, invalidAcks: 0,
  };
  if (!isGuidanceJobId(job)) return base;

  let text: string;
  const path = guidanceFilePath(runsDir, job);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > GUIDANCE_FILE_MAX_BYTES) return base;
    text = await readSlice(path, GUIDANCE_FILE_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ...base, sourceState: 'missing' };
    }
    return base;
  }

  const fold = foldGuidanceLines(text.split('\n'));
  const entries = fold.entries.map(scrubEntry);
  const lane = entries.length > 0 ? entries[entries.length - 1]!.lane : (await readJobLaneAndTier(job, runsDir)).lane;
  return {
    ...base,
    sourceState: 'healthy',
    lane,
    strategy: strategyForLane(lane).kind,
    pending: entries.filter((entry) => entry.state === 'queued').length,
    entries,
    orphanAcks: fold.orphanAcks,
    invalidAcks: fold.invalidAcks,
  };
}

const GUIDANCE_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{2,79})\.jsonl$/;

/**
 * Aggregate ack state across every session with a guidance file — the one
 * read the console row poll needs. Newest files first, bounded to
 * GUIDANCE_LIST_MAX_JOBS; each file is read whole under the same cap. Never
 * throws: a missing directory is 'missing', a bad entry is skipped.
 */
export async function listSessionGuidance(
  opts: { runsDir?: string; now?: () => number; limit?: number } = {},
): Promise<FleetGuidanceListV1> {
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const generatedAt = new Date((opts.now ?? Date.now)()).toISOString();
  const limit = Math.max(1, Math.min(GUIDANCE_LIST_MAX_JOBS, Math.floor(opts.limit ?? GUIDANCE_LIST_MAX_JOBS)));
  const dir = join(runsDir, GUIDANCE_DIR);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    return {
      v: 1, generatedAt,
      sourceState: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded',
      sessions: [],
    };
  }

  const candidates: { job: string; path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const match = GUIDANCE_FILE_RE.exec(name);
    const job = match?.[1];
    if (!job || !isGuidanceJobId(job)) continue;
    try {
      const path = join(dir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > GUIDANCE_FILE_MAX_BYTES) continue;
      candidates.push({ job, path, mtimeMs: info.mtimeMs });
    } catch { /* vanished or unreadable: skip */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: FleetGuidanceSessionV1[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    let entry: FleetGuidanceSessionV1 = {
      job: candidate.job, lane: null, strategy: 'requeue', pending: null, latest: null,
    };
    try {
      const fold = foldGuidanceLines((await readSlice(candidate.path, GUIDANCE_FILE_MAX_BYTES)).split('\n'));
      const entries = fold.entries.map(scrubEntry);
      const last = entries.length > 0 ? entries[entries.length - 1]! : null;
      const lane = last?.lane ?? null;
      entry = {
        job: candidate.job,
        lane,
        strategy: strategyForLane(lane).kind,
        pending: entries.filter((item) => item.state === 'queued').length,
        latest: last === null ? null : {
          id: last.id, at: last.at, state: last.state, turn: last.turn, requeueTo: last.requeueTo,
        },
      };
    } catch { /* keeps pending: null — the row shows the state as unknown */ }
    sessions.push(entry);
  }
  return { v: 1, generatedAt, sourceState: 'healthy', sessions };
}
