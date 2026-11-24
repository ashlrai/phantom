/**
 * One pass of the live resource reader, and the only writer of
 * <runsDir>/state/resource-live.json.
 *
 * The Eng Ops resource-pool builder merges that sidecar into
 * state/resource-pool.json. This module never opens resource-pool.json, so
 * the two writers cannot race: each file has one owner, and the sidecar is
 * replaced by rename so a reader sees the old file or the new one, never a
 * partial write. A lock file keeps two passes from overlapping.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { planBurnDown } from './burn-down.js';
import { nextPollState, nextWakeMs, pollDue, readingFingerprint } from './cadence.js';
import { evaluateResetRule, renderResetDecision } from './reset-rule.js';
import { NEEDS_SIGNIN, type ResourceLiveObservation, type ResourceLiveSource, type ResourceLiveSources } from './source-types.js';
import {
  HISTORY_PER_ALLOWANCE, parseResourceLiveSidecar, readResourceLiveFile, readingSchema, resetDecisionDir, resourceLivePath,
  resourceLiveStateDir, toReading, unverified, usable,
  appendResourceHistory, readResourceHistoryFile, resourceHistoryPath,
} from './store.js';
import {
  RESOURCE_LIVE_ALLOWANCES, RESOURCE_LIVE_SCHEMA,
  type HistorySample, type PollState, type ResetDraft, type ResourceLiveAllowance, type ResourceLiveId,
  type ResourceLiveReading, type ResourceLiveReason, type ResourceLiveSidecar,
} from './types.js';

export const SOURCE_DEADLINE_MS = 20_000;
/** A lock older than this belongs to a pass that died. */
export const LOCK_STALE_MS = 5 * 60_000;

export class ResourceLiveBusyError extends Error {
  constructor() { super('Another resource-live pass holds the lock'); this.name = 'ResourceLiveBusyError'; }
}

/** Build a verified reading, or null when the observation is not a usable measurement. */
function verifiedReading(allowance: ResourceLiveAllowance, seen: ResourceLiveObservation, tier: ResourceLiveSource['tier'], nowMs: number): ResourceLiveReading | null {
  const parsed = readingSchema.safeParse({
    id: allowance.id, verified: true, used: seen.used, limit: seen.limit, unit: seen.unit,
    reset_at: seen.reset_at === null ? null : normalizeInstant(seen.reset_at),
    source: seen.source, source_tier: seen.tier ?? tier, observed_at: normalizeInstant(seen.observed_at),
    stale_after: seen.stale_after,
    account_id: seen.account_id, model: seen.model,
    window_start: seen.window_start === undefined ? undefined : normalizeInstant(seen.window_start),
  });
  if (!parsed.success || !usable(parsed.data)) return null;
  const row = parsed.data;
  if (Date.parse(row.observed_at) > nowMs) return null;
  // A reading taken before a reset that has since passed describes the previous window.
  if (row.reset_at !== null && Date.parse(row.reset_at) <= nowMs) return null;
  return toReading(allowance, row);
}

function normalizeInstant(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

type Outcome = { kind: 'value'; value: Awaited<ReturnType<ResourceLiveSource['read']>> } | { kind: 'error' } | { kind: 'timeout' };

async function runSource(source: ResourceLiveSource, nowMs: number, deadlineMs: number): Promise<Outcome> {
  const work = Promise.resolve().then(() => source.read(nowMs))
    .then((value): Outcome => ({ kind: 'value', value }))
    .catch((): Outcome => ({ kind: 'error' }));
  const timeout = new Promise<Outcome>(resolve => { setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs).unref(); });
  return Promise.race([work, timeout]);
}

/**
 * Try each source in order. The first current reading wins. A reading older
 * than the staleness bound is kept only when no later source has a current
 * one, so an old official file never hides a fresh own-call reading.
 */
async function readAllowance(allowance: ResourceLiveAllowance, sources: readonly ResourceLiveSource[], nowMs: number, deadlineMs: number): Promise<ResourceLiveReading> {
  if (sources.length === 0) return unverified(allowance, 'no-supported-source');
  let reason: ResourceLiveReason = 'source-returned-nothing';
  let older: ResourceLiveReading | null = null;
  for (const source of sources) {
    const outcome = await runSource(source, nowMs, deadlineMs);
    if (outcome.kind === 'error') { reason = 'source-error'; continue; }
    if (outcome.kind === 'timeout') { reason = 'source-timeout'; continue; }
    if (outcome.value === null) continue;
    if (outcome.value === NEEDS_SIGNIN || 'needs_signin' in outcome.value) { reason = 'needs-signin'; continue; }
    const reading = verifiedReading(allowance, outcome.value, source.tier, nowMs);
    if (!reading) { reason = 'invalid-reading'; continue; }
    if (nowMs < Date.parse(reading.stale_after!)) return reading;
    older ??= reading;
  }
  return older ?? unverified(allowance, reason);
}

async function writePrivate(path: string, body: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  }
}

async function acquireLock(path: string, nowMs: number): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${process.pid} ${new Date(nowMs).toISOString()}\n`);
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(path).catch(() => null);
      // The lock age uses the real clock: it measures a process, not a reading.
      if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) throw new ResourceLiveBusyError();
      await rm(path, { force: true });
    }
  }
  throw new ResourceLiveBusyError();
}

/** Lanes with a running job, from the dispatcher's status file. Unreadable or old means none. */
export async function readActiveLanes(runsDir: string, nowMs: number): Promise<Set<string>> {
  const active = new Set<string>();
  try {
    const path = join(runsDir, 'queue', 'status.json');
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return active;
    const status = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const tick = typeof status['last_tick'] === 'string' ? Date.parse(status['last_tick']) : NaN;
    if (!Number.isFinite(tick) || tick > nowMs || nowMs - tick > 5 * 60_000) return active;
    const lanes = status['lanes'];
    if (lanes === null || typeof lanes !== 'object' || Array.isArray(lanes)) return active;
    for (const [lane, row] of Object.entries(lanes as Record<string, unknown>)) {
      const running = row !== null && typeof row === 'object' ? (row as Record<string, unknown>)['running'] : null;
      if (typeof running === 'number' && running > 0) active.add(lane);
    }
  } catch { /* No status file means no lane is known to be active. */ }
  return active;
}

export interface ResourceLiveTickOptions {
  runsDir: string;
  sources: ResourceLiveSources;
  nowMs?: number;
  /** Lanes running jobs now. Defaults to the dispatcher status file. */
  activeLanes?: (nowMs: number) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Poll every allowance, ignoring the cadence. */
  force?: boolean;
  deadlineMs?: number;
}

export interface ResourceLiveTickResult {
  sidecar: ResourceLiveSidecar;
  polled: ResourceLiveId[];
  drafts: ResetDraft[];
  decisionFile: string | null;
}

export async function runResourceLiveTick(options: ResourceLiveTickOptions): Promise<ResourceLiveTickResult> {
  const nowMs = options.nowMs ?? Date.now();
  const stateDir = resourceLiveStateDir(options.runsDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(join(stateDir, '.resource-live.lock'), nowMs);
  try {
    const prior = parseResourceLiveSidecar(await readResourceLiveFile(options.runsDir));
    const active = await (options.activeLanes ?? (now => readActiveLanes(options.runsDir, now)))(nowMs);
    const polled: ResourceLiveId[] = [];
    const poll: Partial<Record<ResourceLiveId, PollState>> = {};
    const history: Partial<Record<ResourceLiveId, HistorySample[]>> = {};

    const readings = await Promise.all(RESOURCE_LIVE_ALLOWANCES.map(async (allowance): Promise<ResourceLiveReading> => {
      const id = allowance.id;
      const kept = prior.readings.find(row => row.id === id);
      const laneActive = allowance.lane !== null && active.has(allowance.lane);
      const windowOver = kept?.reset_at != null && Date.parse(kept.reset_at) <= nowMs;
      const due = options.force === true || windowOver || pollDue(prior.poll[id], laneActive, nowMs);
      let reading: ResourceLiveReading;
      if (due) {
        reading = await readAllowance(allowance, options.sources[id] ?? [], nowMs, options.deadlineMs ?? SOURCE_DEADLINE_MS);
        if (!reading.verified && windowOver) reading = unverified(allowance, 'window-reset');
        polled.push(id);
        poll[id] = nextPollState(prior.poll[id], readingFingerprint(reading), laneActive, nowMs);
      } else {
        reading = kept ?? unverified(allowance, 'source-returned-nothing');
        poll[id] = prior.poll[id];
      }
      return reading;
    }));

    // Fable draws on the weekly allowance, so it resets with it.
    const weekly = readings.find(row => row.id === 'claude-weekly');
    const fable = readings.find(row => row.id === 'claude-fable');
    if (fable?.verified && fable.reset_at === null && weekly?.verified && weekly.reset_at !== null) fable.reset_at = weekly.reset_at;

    for (const reading of readings) {
      const samples = [...(prior.history[reading.id] ?? [])];
      if (reading.verified && reading.used !== null && reading.observed_at !== null
        && !samples.some(sample => sample.observed_at === reading.observed_at)) {
        samples.push({ observed_at: reading.observed_at, used: reading.used, reset_at: reading.reset_at });
      }
      if (samples.length) history[reading.id] = samples.slice(-HISTORY_PER_ALLOWANCE);
    }

    const rule = evaluateResetRule(weekly, fable, prior.reset_rule, nowMs);
    let decisionFile: string | null = null;
    if (rule.drafts.length > 0) {
      const decision = renderResetDecision(rule.drafts, nowMs);
      const dir = resetDecisionDir(options.runsDir);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      decisionFile = join(dir, `${decision.id}.json`);
      // Written before the sidecar: a pass that dies in between rewrites the same file, it does not send a second decision.
      await writePrivate(decisionFile, `${JSON.stringify(decision, null, 2)}\n`);
    }

    const generatedAt = new Date(nowMs).toISOString();
    const sidecar: ResourceLiveSidecar = {
      schema: RESOURCE_LIVE_SCHEMA,
      generated_at: generatedAt,
      writer: 'phm usage resource-live',
      readings,
      burn_down: planBurnDown(readings, history, nowMs),
      reset_rule: { ...rule.state, last_decision_file: decisionFile ?? rule.state.last_decision_file },
      poll,
      history,
      next_poll_at: new Date(nextWakeMs(Object.values(poll), nowMs)).toISOString(),
    };
    await writePrivate(resourceLivePath(options.runsDir), `${JSON.stringify(sidecar, null, 2)}\n`);
    await writePrivate(resourceHistoryPath(options.runsDir), JSON.stringify(appendResourceHistory(
      await readResourceHistoryFile(options.runsDir), readings, nowMs)));
    return { sidecar, polled, drafts: rule.drafts, decisionFile };
  } finally {
    await release();
  }
}
