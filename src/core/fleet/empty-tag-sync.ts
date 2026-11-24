/**
 * empty-tag-sync.ts — the daemon-side recorder for the fleet's empty-job
 * evidence ledgers.
 *
 * `metrics/empty-tags.jsonl` (`job.empty-tag.v1` rows) and the outcome rows
 * `metrics/dupcheck.jsonl` carries are what `phm router outcomes` joins as
 * `empty_tag`, what `phm fleet router-weights` tallies as
 * `unknown_empty_tags`, and what `phm queue dupcheck --stats` measures skip
 * precision against — but the only writer was the manual
 * `phm jobs empty --record` flag, so on a fleet where nobody runs it the
 * ledgers starve and every consumer reads the joins as absent. This module
 * automates the same recording on the daemon's self-improvement cadence,
 * beside the reward-sync and skill-nudge off-tick jobs.
 *
 * THE RULES, matching the `--record` path exactly:
 *   - WINDOWED FINISHES ONLY. Candidates are the jobs whose newest finish
 *     inside the retained window recorded `empty` — the same
 *     `ledgerFinishes` fold `phm jobs empty` runs (empty-finishes.ts, the
 *     pure ledger projection split out of empties.ts), over the same
 *     jobs-ledger dialect, here bounded to the newest
 *     ROUTER_OUTCOME_LEDGER_LIMIT bytes of jobs.jsonl like the sibling
 *     syncs. A job whose finish rows fell out of the tail is simply not a
 *     candidate this pass; its earlier recorded tag still stands.
 *   - LOG TAIL IS THE ONLY INPUT. The tag comes from `tagEmpty` over the
 *     job's `<runs>/<id>.log` tail — the same 64 KiB bounded read
 *     `readEmptyJobs` performs — never from notes, publish output or the
 *     ledger row itself. A missing or unreadable log classifies `unknown`,
 *     exactly like the CLI.
 *   - FIRST WRITE WINS. `recordEmptyTags` dedups by job id against the
 *     whole tags file, so a job already tagged keeps its recorded tag and
 *     a re-run never rewrites it; the sync's own seen-set only decides
 *     which log tails are worth reading. `recordDupcheckOutcomes` dedups
 *     outcome rows the same way, and receives every window candidate's
 *     effective tag — the recorded one when present, the fresh one
 *     otherwise — matching what `--record` feeds it.
 *   - BOUNDED AND BEST-EFFORT. Log classifications per pass are capped;
 *     the remainder waits for the next sync. Ledger problems come back as
 *     `state`, write problems as `state: 'error'` — the job never throws.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ledgerFinishes } from './empty-finishes.js';
import { EMPTY_TAGS, recordEmptyTags, tagEmpty, type EmptyTag, type TaggedEmptyJob } from './empty-tags.js';
import { readSource } from './runs-parked-queue.js';
import { recordDupcheckOutcomes } from '../queue/dupcheck-gate.js';
import {
  readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE,
  type LedgerReadState, type LedgerTailRead,
} from '../router/outcomes.js';

/** Finish window for candidates — the fleet's usual 72 h evidence horizon. */
export const EMPTY_TAG_SYNC_HOURS = 72;
/** Same per-job log tail `readEmptyJobs` reads for the tag classification. */
export const EMPTY_TAG_LOG_TAIL_BYTES = 65_536;
/** Fresh log classifications per pass; the rest drain on later syncs. */
export const EMPTY_TAG_SYNC_MAX_CLASSIFY = 128;

export interface EmptyTagSyncOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as reward-feed). */
  runsDir?: string;
  /** Injected jobs-ledger tail text; skips the jobs.jsonl read when set. */
  jobsText?: string;
  now?: () => Date;
  signal?: AbortSignal;
  /** Per-pass classification cap; defaults to EMPTY_TAG_SYNC_MAX_CLASSIFY. */
  maxClassify?: number;
}

export interface EmptyTagSyncResult {
  /** Health of the jobs-ledger tail; only 'read' can fold finishes. */
  state: LedgerReadState | 'error';
  jobsPath: string;
  /** True when the jobs tail dropped older bytes — some finishes may be out of window. */
  truncated: boolean;
  /** Health of the empty-tags ledger behind the recorded-tag seen-set; 'not-read' when the pass never reached it. */
  tagsState: LedgerReadState | 'not-read';
  /** Empty finishes the window produced. */
  candidates: number;
  /** Candidates already carrying a recorded tag — no log read needed. */
  alreadyTagged: number;
  /** Fresh candidates classified from log tails this pass. */
  classified: number;
  /** Fresh candidates deferred past the per-pass cap to a later sync. */
  deferred: number;
  /** job.empty-tag.v1 rows appended this pass. */
  recorded: number;
  /** dupcheck outcome rows appended this pass. */
  dupcheckOutcomes: number;
}

function emptyResult(state: EmptyTagSyncResult['state'], jobsPath: string): EmptyTagSyncResult {
  return {
    state, jobsPath, truncated: false, tagsState: 'not-read',
    candidates: 0, alreadyTagged: 0, classified: 0, deferred: 0,
    recorded: 0, dupcheckOutcomes: 0,
  };
}

async function tailOrInjected(injected: string | undefined, path: string): Promise<LedgerTailRead> {
  if (injected !== undefined) return { state: 'read', text: injected, truncated: false };
  return readLedgerTail(path);
}

/** job id -> recorded tag, from the tags ledger's `job.empty-tag.v1` rows. */
function recordedTags(text: string): Map<string, EmptyTag> {
  const tags = new Map<string, EmptyTag>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    if (row['schema'] !== 'job.empty-tag.v1') continue;
    const job = row['job'];
    const tag = row['tag'];
    if (typeof job !== 'string' || typeof tag !== 'string') continue;
    if ((EMPTY_TAGS as readonly string[]).includes(tag)) tags.set(job, tag as EmptyTag);
  }
  return tags;
}

/**
 * Refresh the empty-job evidence ledgers from the fleet jobs ledger. Runs
 * inside the daemon's empty-tag-sync off-tick job on the self-improvement
 * cadence; safe to call any time. Never throws: ledger problems come back
 * as `state`, write problems as `state: 'error'`.
 */
export async function syncEmptyTagsFromJobsLedger(
  opts: EmptyTagSyncOptions = {},
): Promise<EmptyTagSyncResult> {
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const tagsPath = join(runsDir, 'metrics', 'empty-tags.jsonl');
  try {
    const jobs = await tailOrInjected(opts.jobsText, jobsPath);
    if (jobs.state !== 'read') return emptyResult(jobs.state, jobsPath);
    if (opts.signal?.aborted) {
      return { ...emptyResult('read', jobsPath), truncated: jobs.truncated };
    }

    // The tags ledger gates the whole pass: without a readable seen-set a
    // write could append a second row for an already-tagged job, so an
    // unreadable or non-file tags ledger skips recording rather than
    // risking duplicate evidence. 'missing' is a clean empty ledger.
    const tagsRead = await readLedgerTail(tagsPath);
    const tagsState: LedgerReadState = tagsRead.state;
    const base: EmptyTagSyncResult = {
      ...emptyResult('read', jobsPath), truncated: jobs.truncated, tagsState,
    };
    if (tagsState !== 'read' && tagsState !== 'missing') return base;
    const seen = tagsRead.state === 'read' ? recordedTags(tagsRead.text) : new Map<string, EmptyTag>();

    const candidates = ledgerFinishes(jobs.text, nowMs, EMPTY_TAG_SYNC_HOURS)
      .finishes.filter(finish => finish.empty === true)
      .map(finish => ({ id: finish.id, lane: finish.lane }));
    const fresh = candidates.filter(candidate => !seen.has(candidate.id));
    const toClassify = fresh.slice(0, Math.max(0, opts.maxClassify ?? EMPTY_TAG_SYNC_MAX_CLASSIFY));

    // Effective tag per candidate: the recorded one when present, else the
    // fresh classification — the same inputs `--record` hands the writers.
    const effective = new Map<string, string>();
    for (const candidate of candidates) {
      const recorded = seen.get(candidate.id);
      if (recorded !== undefined) effective.set(candidate.id, recorded);
    }
    const tagged: TaggedEmptyJob[] = [];
    for (const candidate of toClassify) {
      if (opts.signal?.aborted) break;
      const source = await readSource(join(runsDir, `${candidate.id}.log`), EMPTY_TAG_LOG_TAIL_BYTES, true);
      const tag = tagEmpty(source.state === 'healthy' ? source.text : null).tag;
      tagged.push({ id: candidate.id, lane: candidate.lane, tag });
      effective.set(candidate.id, tag);
    }

    const result: EmptyTagSyncResult = {
      ...base,
      candidates: candidates.length,
      alreadyTagged: candidates.length - fresh.length,
      classified: tagged.length,
      deferred: fresh.length - tagged.length,
    };
    if (tagged.length > 0) {
      result.recorded = await recordEmptyTags(runsDir, tagged);
    }
    const dupcheckJobs = [...effective.entries()].map(([id, tag]) => ({ id, tag }));
    if (dupcheckJobs.length > 0) {
      result.dupcheckOutcomes = await recordDupcheckOutcomes(runsDir, dupcheckJobs, nowMs);
    }
    return result;
  } catch {
    return emptyResult('error', jobsPath);
  }
}
