import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { projectBusThread } from './bus-thread-context.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { dispatchEventsCandidates } from './dispatch-events-path.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { scrubSecrets } from '../util/scrub.js';
import { learnFleetOutcomes, outcomeLearningView } from '../routing/outcome-learning.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { ledgerPhase, ledgerPrUrl, ledgerLane } from './empty-cause.js';
import { isNodePoolLedgerRow, ledgerEventTs, ledgerJobId, ledgerLifecycleEvent, ledgerOutcomeState } from './jobs-ledger-dialect.js';
import { readStandingRevertKeys } from '../improve/revert-ledger.js';
import { hasRevertEvidence } from './slot-yield.js';
import { pinnedContextRows } from './library-pins.js';

export interface ContextPackOptions extends BusInboxOptions {
  job: string; lane: string; runsDir: string; maxTokens?: number; merges?: number; home?: string;
}
export const contextIdentifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && scrubSecrets(value) === value;
// One UTF-8 byte per token is a conservative upper bound for byte-based tokenizers.
export const packTokens = (json: string): number => Buffer.byteLength(json + '\n', 'utf8');

export function compactContext(job: string, lane: string, sections: { name: string; rows: unknown[] }[], cap: number): string {
  const safe = sanitizePublicJson({ schema: 'fleet.ctxpack.v1', job, lane, sections }) as { sections: typeof sections };
  const encode = (): string => scrubSecrets(JSON.stringify(safe, (key, value: unknown) =>
    /(?:password|passwd|credential|secret|api[_-]?key|token|authorization)$/i.test(key) ? '[REDACTED]' : value));
  while (packTokens(encode()) > cap) {
    const last = safe.sections.at(-1);
    if (!last) throw new Error('Pack metadata exceeds budget. Increase --max-tokens or shorten --job and --lane.');
    if (last.rows.length) last.rows.pop();
    else safe.sections.pop();
  }
  const result = encode();
  try { JSON.parse(result); } catch { throw new Error('Cannot serialize scrubbed context. Repair malformed source records and retry.'); }
  return result;
}

async function eventsFile(runsDir: string): Promise<{ path: string; text: string }> {
  for (const path of dispatchEventsCandidates(runsDir)) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('size');
      return { path, text: await file.readFile('utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read outcome log. Restore a regular dispatch-events.log under 8 MiB in the runs directory.');
    } finally { await file?.close(); }
  }
  throw new Error('Outcome log missing. Start the fleet to create queue/dispatch-events.log in the runs directory.');
}

// dispatch-events.log carries no stamped outcome lines, so the fold needs the
// jobs ledger — the same bounded tail `phm fleet outcomes` and `phm select` read.
// A missing or unreadable ledger degrades to dispatch-log evidence only; the
// pack's sources.metrics health already reports that state.
async function jobsLedgerTail(runsDir: string): Promise<string | null> {
  const read = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
  return read.state === 'read' ? read.text : null;
}

/** Batch session ids are infrastructure and never claim a PR — the rule the sibling outcome folds apply. */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';
/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function pullRequestKey(url: string): string | null {
  const match = GITHUB_PULL_URL.exec(url);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}` : null;
}

/**
 * The standing revert-set join: a merge whose verdict row's pull URL is
 * claimed by exactly that job and whose `owner/repo#n` key stands in the
 * supplied set counts as reverted — git-history reverts the jobs ledger
 * never spelled still mark the merge. Absent, empty or unmatched keys
 * change nothing, and a contested or foreign claim never resolves — the
 * same rule the sibling outcome folds apply.
 */
function standingReverted(
  job: string | null,
  pr: string | null,
  claims: ReadonlyMap<string, ReadonlySet<string>> | null,
  keys: ReadonlySet<string> | null | undefined,
): boolean {
  if (claims === null || keys === null || keys === undefined || job === null || pr === null) return false;
  const claimants = claims.get(pr);
  if (claimants === undefined || claimants.size !== 1 || !claimants.has(job)) return false;
  const key = pullRequestKey(pr);
  return key !== null && keys.has(key);
}

/**
 * Standing revert keys for the merges fold. Anything but a fully intact
 * ledger read contributes an empty set — missing or corrupt evidence never
 * marks a merge reverted — and a read failure degrades the same way rather
 * than failing the pack: revert marking is advisory context, not a gate.
 */
function standingRevertKeysSafe(): ReadonlySet<string> {
  try {
    return readStandingRevertKeys();
  } catch {
    return new Set<string>();
  }
}

/**
 * Newest-first MERGED verdicts from the jobs-ledger tail, one row per job.
 * The reconciler's terminal rows are the merge evidence dispatch-events.log
 * never carried, so the pack's merges section reads them through the shared
 * ledger dialect — the same helpers wt-audit and the outcome fold apply.
 * A verdict with no parseable stamp cannot be ordered and stays out; a row
 * naming neither a job nor a PR URL is unattributable noise and skips too.
 * Malformed lines are the fold's count elsewhere, not this section's.
 *
 * `reverted` marks a merge whose recorded evidence says it did not hold —
 * the same two sources and the same era rule every sibling outcome fold
 * applies (reward-feed, skill-nudge, outcome-learning, the router outcome
 * fold):
 *   - In-ledger revert evidence (`hasRevertEvidence`) stamped at or after
 *     the verdict's own stamp means the merge was reverted; an older stamp
 *     belongs to an earlier merge era and the verdict stays a fresh held
 *     merge. Revert rows without a parseable stamp cannot be ordered and
 *     never mark.
 *   - The standing `owner/repo#n` keys resolved from
 *     improve/revert-outcomes.jsonl mark a verdict whose own PR URL is
 *     claimed by exactly that job (the unambiguous-claim join) and whose
 *     key stands in the supplied set — reverts only git history proves.
 *     Absent, empty or unmatched keys change nothing, and a contested or
 *     foreign claim never resolves.
 * Only merges with a job id can carry the flag: a PR-only verdict has no
 * claimable identity, so it stays unmarked rather than guessed.
 */
function recentLedgerMerges(
  ledger: string | null,
  limit: number,
  revertedPrKeys?: ReadonlySet<string> | null,
): { at: number; row: Record<string, unknown>; reverted: boolean }[] {
  if (ledger === null || limit <= 0) return [];
  const best = new Map<string, { at: number; row: Record<string, unknown> }>();
  // Latest positive revert-evidence stamp per job id.
  const revertAt = new Map<string, number>();
  // PR URL -> claiming job ids, collected only when standing revert keys
  // were supplied — node-pool producer rows are a different dialect and
  // batch session ids are infrastructure: neither ever claims.
  const claims = revertedPrKeys === undefined || revertedPrKeys === null || revertedPrKeys.size === 0
    ? null : new Map<string, Set<string>>();
  for (const line of ledger.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    const job = ledgerJobId(row);
    const pr = ledgerPrUrl(row);
    if (claims !== null && job !== null && !job.startsWith(BATCH_SESSION_PREFIX) && !isNodePoolLedgerRow(row) && pr !== null) {
      const set = claims.get(pr) ?? new Set<string>();
      set.add(job);
      claims.set(pr, set);
    }
    if (job !== null && hasRevertEvidence(row)) {
      const at = ledgerEventTs(row, ledgerPhase(row));
      if (at !== null) revertAt.set(job, Math.max(revertAt.get(job) ?? 0, at));
    }
    const phase = ledgerPhase(row);
    const event = ledgerLifecycleEvent(row, phase);
    if (ledgerOutcomeState(row, event, phase) !== 'MERGED') continue;
    const at = ledgerEventTs(row, phase);
    if (at === null || (job === null && pr === null)) continue;
    const key = job ?? pr!;
    const prev = best.get(key);
    if (prev !== undefined && prev.at >= at) continue;
    best.set(key, { at, row });
  }
  return [...best.values()].sort((a, b) => b.at - a.at).slice(0, limit).map((entry) => {
    const job = ledgerJobId(entry.row);
    const pr = ledgerPrUrl(entry.row);
    const inLedger = job !== null && revertAt.has(job) && revertAt.get(job)! >= entry.at;
    return { at: entry.at, row: entry.row, reverted: inLedger || standingReverted(job, pr, claims, revertedPrKeys) };
  });
}

export async function buildContextPack(options: ContextPackOptions): Promise<string> {
  const { job, lane, runsDir } = options;
  const cap = options.maxTokens ?? 2000, count = options.merges ?? 5;
  if (!contextIdentifier(job) || !contextIdentifier(lane) || !Number.isInteger(cap) || cap < 256 || cap > 2000 || !Number.isInteger(count) || count < 0 || count > 100) {
    throw new Error('Use safe job/lane IDs, --max-tokens 256..2000, and --merges 0..100.');
  }
  const now = (options.now ?? Date.now)();
  const [state, events, ledger] = await Promise.all([
    readFleetRunsDirState({ runsDir, now: () => now }),
    eventsFile(runsDir),
    jobsLedgerTail(runsDir),
  ]);
  if (state.sources.status !== 'healthy') throw new Error('Fleet status missing or unreadable. Restore queue/status.json and retry.');
  if (inspectBusInbox(options).source !== 'available') throw new Error('Bus missing or unreadable. Restore private bus storage and retry.');
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 12; pageNumber++) {
    const page = listBusInboxAfter(cursor, 100, { ...options, now: () => now });
    if (page.status !== 'ok') throw new Error('Bus unavailable. Run phm comms bus status and restore private bus storage permissions before retrying.');
    rows.push(...page.messages);
    cursor = page.nextCursor;
    if (page.messages.length < 100) break;
  }
  const relevant = rows.filter(row => {
    const text = JSON.stringify(row.envelope);
    return new RegExp(`(^|[^A-Za-z0-9._-])${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9._-]|$)`).test(text);
  });
  const selected = new Map<number, BusInboxReceipt>();
  for (const row of relevant) {
    let parent = row;
    const seen = new Set<string>();
    while (!seen.has(parent.envelope.id)) {
      seen.add(parent.envelope.id);
      const body = parent.envelope.body;
      const id = body && typeof body === 'object' && !Array.isArray(body) ? body['inReplyTo'] : null;
      const ancestor = rows.find(candidate => candidate.envelope.id === id);
      if (!ancestor) break;
      parent = ancestor;
    }
    for (const message of projectBusThread(rows, parent.envelope.id)) selected.set(message.cursor, message);
  }
  const threads = [...selected.values()].sort((a, b) => a.envelope.priority.localeCompare(b.envelope.priority) || b.cursor - a.cursor)
    .map(({ cursor: at, envelope: { id, from, to, priority, body } }) => ({ source: 'bus-inbox', cursor: at, id, from, to, priority, body }));
  // The ledger's MERGED verdicts lead — they are the recorded merge evidence —
  // followed by any stamped merge lines a producer still writes to the events
  // log (legacy/hand-written dialect the outcome fold also accepts). The
  // shared `count` budget covers both sources, ledger first. Verdicts carry
  // `reverted: true` when the same revert evidence every outcome fold reads
  // proves the merge did not hold — in-ledger revert rows at or after the
  // verdict's stamp, or a standing improve/revert-outcomes.jsonl key claimed
  // by exactly that job — so a reverted merge never reads as landed work.
  const ledgerSource = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const mergeRows = [
    ...recentLedgerMerges(ledger, count, standingRevertKeysSafe()).map(({ at, row, reverted }) => ({
      source: ledgerSource,
      job: ledgerJobId(row),
      pr: ledgerPrUrl(row),
      repo: typeof row['repo'] === 'string' && row['repo'].trim() ? row['repo'].trim() : null,
      lane: ledgerLane(row),
      at: new Date(at).toISOString(),
      ...(reverted ? { reverted: true } : {}),
    })),
    ...events.text.split(/\r?\n/).filter(line => /\b(?:MERGED|MERGE)\b|\bOUTCOME \S+ merged\b|\bstate=merged\b|"state"\s*:\s*"merged"/.test(line)).reverse().slice(0, count)
      .map(text => ({ source: events.path, text })),
  ].slice(0, count);
  const learning = outcomeLearningView(learnFleetOutcomes(events.text, ledger));
  const pins = pinnedContextRows(10, { home: options.home });
  const json = compactContext(job, lane, [
    { name: 'fleet', rows: [{ lastTick: state.lastTick, sources: state.sources, paused: state.paused, lanes: state.lanes.sort((a, b) => a.lane.localeCompare(b.lane)).map(({ lane, running, target, queued, held }) => ({ lane, running, target, queued, held })), finished: learning.finished }] },
    { name: 'blockers', rows: [...state.lanes.filter(row => row.held).map(row => ({ lane: row.lane, reason: row.heldReason })),
      ...threads.filter(row => row.body && typeof row.body === 'object' && !Array.isArray(row.body) && row.body['status'] === 'blocked' &&
        !projectBusThread(rows, row.id).some(reply => reply.cursor > row.cursor && reply.envelope.body && typeof reply.envelope.body === 'object' && !Array.isArray(reply.envelope.body) &&
          ['resolved', 'closed', 'unblocked'].includes(String(reply.envelope.body['status']))))] },
    { name: 'merges', rows: mergeRows }, { name: 'threads', rows: threads },
    ...(pins.length ? [{ name: 'pinned-by-mason', rows: pins }] : []),
  ], cap);
  let log: Awaited<ReturnType<typeof open>> | undefined;
  try {
    log = await open(events.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await log.stat()).isFile()) throw new Error('file');
    // Same outcome store, ignored by assignment/outcome folding, no pack contents persisted.
    await log.writeFile(`${new Date(now).toISOString().slice(0, 19).replace('T', ' ')} CTXPACK job=${job} lane=${lane} pack_tokens=${packTokens(json)}\n`);
  } catch { throw new Error('Cannot record pack_tokens. Restore write access to the existing dispatch event log, then retry.'); }
  finally { await log?.close(); }
  return json;
}
