/**
 * core/fleet/rebase-plan.ts — conflict-to-queue wiring for the merge
 * treadmill (RQ-SWE3-MERGEBATCH-WIRE-1).
 *
 * `fleet merge-batch` groups open PRs into file-overlap batches (conflict
 * prediction); queuegen and restock turn `- READY` router-queue lines into
 * ready.tsv rows (job generation). This module is the missing link: given the
 * snapshot's conflicting `bridge:` PRs — the same set `fleet rebase-status`
 * counts — it emits optimal rebase-job batches as ready.tsv-ready job specs.
 *
 * THE BATCHING. Conflicting PRs that share a file are rebased by the same job
 * (one worker sees the shared conflict context once and applies it to the
 * whole cluster); file-disjoint clusters become separate jobs that spread
 * across lanes safely. Clustering reuses planMergeBatches on the conflicting
 * subset — its connected components are exactly the same-file clusters, and
 * its per-batch order is the least-rebase-churn merge order, which is also
 * the order a worker should rebase in. A serial batch larger than `maxPrs`
 * is split into file-connected chunks and the chunks chain with `after=`
 * (restock parks them PARKED-DEP and unparks as each lands).
 *
 * THE SPECS. Every job carries: a deterministic id (single-PR jobs reuse the
 * queuegen shape `RQ-REBASE-<repo>-<pr>-<head7>` when the snapshot has a head
 * oid, batch jobs embed member numbers for coverage), the router-queue
 * `- READY <id> (attrs): <text>` line (the sanctioned write path — append to
 * router-queue.md and restock does the rest), the full prompt body for
 * `queue/prompts/<id>.md`, and the ready.tsv row fields for direct
 * materialization. Jobs touching a security-pinned surface carry
 * `[Security pin required]` so the line enters as HOLD-SECURITY downstream.
 *
 * COVERAGE. An active queue job (READY / CLAIMED / RUNNING / PARKED-*) whose
 * id or text already names a conflicting PR covers it: covered PRs are
 * excluded and re-clustered, so a re-run never re-queues in-flight work.
 *
 * READ-ONLY and PURE: no I/O, no gh, no clock — the caller supplies the
 * snapshot rows, the existing queue view, the hold list and `now`.
 */
import { createHash } from 'node:crypto';
import { assertQueueTier, type QueueTier } from '../drive/queue-tier.js';
import {
  QUEUEGEN_SECURITY_PIN,
  noWs,
  quoted,
  securityPinnedPath,
  singleLine,
} from '../drive/queuegen.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  MAX_FILES_PER_PR,
  MAX_PRS,
  planMergeBatches,
  type MergeBatchPr,
} from './merge-batch.js';

export const REBASE_PLAN_SCHEMA = 'fleet.rebase-plan.v1' as const;

/** Default cap on PRs per rebase job (RQ-REBASE-PH batches ran 5–14). */
export const REBASE_PLAN_DEFAULT_MAX_PRS = 8;
/**
 * Hard cap: batch job ids embed every member number and must stay inside the
 * router's 80-char gate-token bound (restock's JID_TOK) so chained chunks can
 * be named in a DEPENDENCY GATE — the id-length budget binds first in
 * practice, and 16 members is the absolute ceiling.
 */
export const REBASE_PLAN_MAX_JOB_MEMBERS = 16;
const MAX_TITLE_CHARS = 200;
const MAX_MEMBER_FILES = 40;
const MAX_SHARED_FILES = 12;
const MAX_LINE_FILES = 8;
const MAX_COVERED_LIST = 200;
/** restock reads `pool=([a-z-]+)` — anything else silently routes as 'any'. */
const POOL_RE = /^[a-z][a-z-]{0,30}$/;
const PRIORITY_RE = /^P[0-3]$/;
/** Statuses that mean a queue row/line still occupies the work. */
const ACTIVE_STATUS = /^(?:READY|CLAIMED|RUNNING|STARTING|DISPATCHED|WORKING|IN-PROGRESS|PARKED(?:-|$)|HOLD-SECURITY)/;
/** Any rebase-flavoured job id: queuegen's, this planner's, and the hand-run PH batches. */
const REBASE_JOB_ID = /^RQ-REBASE[A-Za-z0-9]*-/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RebaseJobMember {
  number: number;
  /** Bounded and secret-scrubbed — a title is untrusted text. */
  title: string;
  headRef: string;
  headSha: string | null;
  isDraft: boolean;
  mergeStateStatus: string;
  files: string[];
}

export interface RebaseJobSpec {
  /**
   * Deterministic job id. Single-PR jobs keep the queuegen shape
   * `RQ-REBASE-<short>-<pr>-<head7>` so rebase-status coverage and queue
   * dedupe see them identically (`-u<hash>` when the snapshot has no head
   * oid). Batch jobs embed every member number:
   * `RQ-REBASE-BATCH-<short>-<n>-<n>-…-<hash>`.
   */
  id: string;
  kind: 'single' | 'cluster' | 'cluster-chunk';
  /** Short repo name the queue row routes on (`repo=` attr), null when unknown. */
  repo: string | null;
  repoFull: string | null;
  status: 'READY';
  pool: string;
  tier: QueueTier;
  priority: string;
  /** after= dependency ids ([] renders `after none`). */
  after: string[];
  /** Member PR numbers in the planned rebase order. */
  prs: number[];
  members: RebaseJobMember[];
  /** Files two or more members touch — the cluster's conflict focus. */
  sharedFiles: string[];
  /** A pinned surface or unproven file list needs the security hold. */
  pinned: boolean;
  evidence: 'ok' | 'no-file-data';
  /** Queue-relative prompt path the writer materializes: prompts/<id>.md. */
  promptFile: string;
  /** Full prompt body for the prompt file. */
  prompt: string;
  /** Router-queue `- READY <id> (attrs): <text>` line for router-queue.md. */
  line: string;
}

/** One active queue row/line, as the caller collected it (ready.tsv or router-queue.md). */
export interface RebasePlanExistingJob {
  id: string | null;
  status: string;
  /**
   * Short repo name when the row/line attributes one (a `repo=` attr or the
   * tsv repo cell). Null/undefined means unattributed: id-anchored coverage
   * still applies (ids embed the repo short name) but free-text PR refs are
   * counted anyway — the same `repo` → `*` fallback restock's hold-list uses.
   */
  repo?: string | null;
  /** Free text of the row/line (attrs + body for router-queue lines, '' for tsv rows). */
  text: string;
}

export interface RebasePlanOptions {
  /** Queue pool attr; default 'any' (restock routes it). */
  pool?: string;
  /** Queue tier; default 'work' — validated with assertQueueTier. */
  tier?: string;
  /** P-priority; default 'P1' (queuegen's per-PR rebase line is P0). */
  priority?: string;
  /** PRs per job cap; default 8, clamped to [1, 16]. */
  maxPrs?: number;
  /** Active queue jobs for coverage; undefined means 'not read'. */
  existing?: readonly RebasePlanExistingJob[];
  /** How the existing queue view read; defaults to 'ok' when jobs were passed. */
  existingState?: 'ok' | 'missing' | 'degraded';
  /** Hold-list entries as '<short>#<n>' or '<owner>/<name>#<n>'; held PRs skip. */
  hold?: ReadonlySet<string>;
}

export interface RebasePlan {
  schema: typeof REBASE_PLAN_SCHEMA;
  v: 1;
  repo: string | null;
  generatedAt: string;
  counts: {
    /** Parsed open PRs in the snapshot. */
    open: number;
    unreadable: number;
    duplicates: number;
    /** Conflicting `bridge:` PRs (the rebase-status population). */
    conflicting: number;
    /** Conflicting PRs skipped on the hold list. */
    held: number;
    /** Conflicting PRs skipped because an active queue job already covers them. */
    covered: number;
    jobs: number;
    clusters: number;
    singles: number;
    /** Serial batches that outgrew the cap and split into chained chunks. */
    chunks: number;
    chained: number;
    pinned: number;
    noFileData: number;
  };
  coverage: {
    /** 'skipped' when the caller passed no existing queue view; 'missing'/'degraded' when it could not be read. */
    state: 'ok' | 'skipped' | 'missing' | 'degraded';
    /** Conflicting PRs the active queue already covers (bounded list). */
    coveredPrs: number[];
  };
  jobs: RebaseJobSpec[];
}

export interface RebasePlanInput extends RebasePlanOptions {
  prs: readonly MergeBatchPr[];
  repo?: string | null;
  unreadable?: number;
  duplicates?: number;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Coverage — which conflicting PRs the active queue already covers
// ---------------------------------------------------------------------------

const shortName = (repo: string): string => repo.split('/').pop() ?? repo;
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** RQ-REBASE-<short>-<pr>-… ids cover exactly <pr>. */
function singleJobPr(id: string, repoShort: string): number | null {
  const match = new RegExp(`^RQ-REBASE-${escapeRe(repoShort)}-(\\d{1,7})-`, 'i').exec(id);
  return match ? Number(match[1]) : null;
}

/** RQ-REBASE-BATCH-<short>-<n>-<n>-…-<hash> ids embed every member number (repo-anchored). */
function batchJobPrs(id: string, repoShort: string): number[] {
  const match = new RegExp(`^RQ-REBASE-BATCH-${escapeRe(repoShort)}-((?:\\d{1,7}-)*\\d{1,7})-[0-9a-f]{6}$`, 'i').exec(id);
  if (!match) return [];
  return match[1]!.split('-').map(Number);
}

/** pull/<n>, PR=<n> and #<n> references — the same PR markers restock extracts. */
function textRefs(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/(?:pull\/|PR=|#)(\d{1,7})/g)) out.push(Number(match[1]));
  return out;
}

/**
 * The PRs the active queue already covers for `repo` (null → none: nothing
 * can be attributed without the repo's short name). A row/line counts when
 * its status is live (READY, CLAIMED, RUNNING, PARKED-*, HOLD-SECURITY), it
 * is rebase-flavoured (`RQ-REBASE*` id — the prefix covers queuegen singles
 * and the hand-run PH batches alike), and it is not proven to belong to a
 * different repo (`job.repo` set and different): an unattributed row still
 * counts, mirroring restock's `repo` → `*` hold-list fallback. Id anchors
 * give exact members; text refs (pull/, PR=, #) cover the hand-run lines
 * whose ids name no PR.
 */
export function coveredPrNumbers(existing: readonly RebasePlanExistingJob[], repo: string | null): Set<number> {
  const covered = new Set<number>();
  if (repo === null) return covered;
  const short = shortName(repo);
  for (const job of existing) {
    const id = job.id ?? '';
    if (!REBASE_JOB_ID.test(id) || !ACTIVE_STATUS.test(job.status.toUpperCase())) continue;
    if (job.repo !== null && job.repo !== undefined && job.repo !== short) continue;
    const single = singleJobPr(id, short);
    if (single !== null) covered.add(single);
    for (const pr of batchJobPrs(id, short)) covered.add(pr);
    for (const pr of textRefs(job.text)) covered.add(pr);
  }
  return covered;
}

// ---------------------------------------------------------------------------
// Hold list — the same '<repo>#<pr>' lines queuegen reads
// ---------------------------------------------------------------------------

/**
 * Parse hold-list text into a set of `short#<n>` and `owner/name#<n>` keys.
 * Lines are whitespace-separated entries; `#`-leading lines are comments.
 */
export function parseHoldList(text: string): Set<string> {
  const hold = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    for (const token of line.split(/\s+/)) {
      const match = /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#(\d{1,7})$/.exec(token);
      if (!match) continue;
      const [, owner, name, pr] = match;
      hold.add(owner ? `${owner}/${name}#${pr}` : `${name}#${pr}`);
    }
  }
  return hold;
}

const held = (pr: MergeBatchPr, hold: ReadonlySet<string>, repo: string | null): boolean => {
  if (repo === null) return false;
  const short = shortName(repo);
  return hold.has(`${short}#${pr.number}`) || hold.has(`${repo}#${pr.number}`);
};

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const conflicted = (pr: MergeBatchPr): boolean =>
  pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';

const isBridge = (pr: MergeBatchPr): boolean => pr.title.startsWith('bridge:');

const hash6 = (material: string): string =>
  createHash('sha256').update(material).digest('hex').slice(0, 6);

const headTag = (pr: { number: number; headRef: string; headSha: string | null }): string =>
  pr.headSha !== null ? pr.headSha.slice(0, 7).toLowerCase() : `u${hash6(`${pr.number}|${pr.headRef}`)}`;

function memberOf(pr: MergeBatchPr): RebaseJobMember {
  return {
    number: pr.number,
    title: scrubSecrets(pr.title.slice(0, MAX_TITLE_CHARS)),
    headRef: pr.headRef,
    // Callers outside parseMergeBatchPrs may hand undefined; normalize once.
    headSha: pr.headSha ?? null,
    isDraft: pr.isDraft,
    mergeStateStatus: pr.mergeStateStatus,
    files: pr.files.slice(0, MAX_MEMBER_FILES),
  };
}

/**
 * Split a serial batch's planned order into file-connected chunks: seed each
 * chunk with the earliest unassigned member, then grow through the batch's
 * overlap edges, always taking the earliest unassigned member adjacent to the
 * chunk so far. Two caps apply: `max` members, and `idChars` — the join('-')
 * length of member numbers the batch job id can carry while staying inside
 * the router's 80-char gate-token bound. Deterministic.
 */
export function chunkOrder(
  order: readonly number[],
  adjacency: ReadonlyMap<number, ReadonlySet<number>>,
  max: number,
  idChars = Number.POSITIVE_INFINITY,
): number[][] {
  const idLen = (members: number[]): number =>
    members.reduce((sum, n) => sum + String(n).length, 0) + members.length - 1;
  const remaining = new Set(order);
  const chunks: number[][] = [];
  while (remaining.size > 0) {
    const seed = order.find(n => remaining.has(n))!;
    const chunk = [seed];
    remaining.delete(seed);
    while (chunk.length < max) {
      const next = order.find(n =>
        remaining.has(n)
        && idLen([...chunk, n]) <= idChars
        && chunk.some(member => adjacency.get(member)?.has(n)));
      if (next === undefined) break;
      chunk.push(next);
      remaining.delete(next);
    }
    chunks.push(chunk);
  }
  return chunks;
}

/** Local HH:MM, same stamp token queuegen writes into its lines. */
const hhmm = (now: Date): string =>
  `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

interface EmitContext {
  repo: string | null;
  repoFull: string | null;
  pool: string;
  tier: QueueTier;
  priority: string;
  stamp: string;
}

/** The queue-task body for the `- READY` line and the prompt's verbatim block. */
function jobText(kind: RebaseJobSpec['kind'], members: RebaseJobMember[], sharedFiles: string[], ctx: EmitContext): string {
  const urls = ctx.repoFull === null ? ''
    : members.map(m => `https://github.com/${ctx.repoFull}/pull/${m.number}`).join(' ');
  if (kind === 'single') {
    const pr = members[0]!;
    const files = pr.files.slice(0, MAX_LINE_FILES);
    const suffix = pr.files.length > files.length ? ` +${pr.files.length - files.length} more` : '';
    return `REBASE ${ctx.repo ?? 'repo'}#${pr.number} branch=${noWs(pr.headRef, 120)} head=${pr.headSha === null ? 'unknown' : noWs(pr.headSha.slice(0, 7), 12)} file=${noWs(files[0] ?? '', 200)} check="merge-tree" acceptance="${quoted(`rebase ${pr.headRef} onto the default branch and push`, 200)}" conflicts="${quoted(files.join(', '), 400)}${suffix}": resolve every listed conflict against the base and push to the head branch. ${urls}`;
  }
  const prs = members.map(m => `#${m.number}`).join(',');
  const files = sharedFiles.slice(0, MAX_LINE_FILES);
  const suffix = sharedFiles.length > files.length ? ` +${sharedFiles.length - files.length} more` : '';
  return `REBASE-BATCH ${ctx.repo ?? 'repo'} prs=${prs} branches=${members.map(m => noWs(m.headRef, 60)).join(',')} file=${noWs(files[0] ?? '', 200)} check="merge-tree" acceptance="${quoted('rebase each listed head branch onto the default branch in the given order and push', 200)}" conflicts="${quoted(files.join(', '), 400)}${suffix}": rebase-or-supersede every listed bridge PR in the given order - one file-overlap cluster, one worker. ${urls}`;
}

function jobPrompt(spec: {
  id: string; members: RebaseJobMember[]; sharedFiles: string[];
  pinned: boolean; after: string[]; attrs: string; text: string;
}, ctx: EmitContext): string {
  const { id, members, sharedFiles, pinned, after, attrs, text } = spec;
  const gate = after.length === 0 ? '' : `DEPENDENCY GATE: ${after.join(', ')}\n\n`;
  const repoLabel = ctx.repoFull ?? 'the repository';
  const list = members.map((m, i) => {
    const files = m.files.slice(0, MAX_LINE_FILES).join(', ') || '(no file data)';
    const more = m.files.length > MAX_LINE_FILES ? ` +${m.files.length - MAX_LINE_FILES} more` : '';
    return ` ${i + 1}. #${m.number} — branch ${m.headRef || '(unknown)'}, head ${m.headSha === null ? 'unknown' : m.headSha.slice(0, 12)}, files: ${files}${more}`;
  }).join('\n');
  const shared = sharedFiles.length === 0 ? ''
    : `\n\nThese PRs cluster because they touch the same files: ${sharedFiles.join(', ')}.`;
  const pin = pinned ? `\n${QUEUEGEN_SECURITY_PIN}: no merge without Security pin` : '';
  return `Job ${id} (pool ${ctx.pool}, tier ${ctx.tier}, repo ${ctx.repo ?? 'unknown'}). Task from the Ashlr router queue, verbatim:\n\n${gate}${id} (${attrs}): ${text}\n\n`
    + `Rebase-or-supersede ${members.length} conflicting bridge PR${members.length === 1 ? '' : 's'} on ${repoLabel}, in this order (the merge-batch plan's least-churn order):\n\n${list}${shared}\n\n`
    + `For each PR in order: when its net change is already on the default branch the PR is SUPERSEDED — record the evidence in the report and move on without reworking it. Otherwise fetch and rebase the head branch onto the default branch, resolve the conflicts in the listed files, run the repo's verification for the touched files, and push the rebased head back to the PR branch. Push only to the listed PR head branches — never to the default branch — and do not edit .github/.${pin}\n\n`
    + `Treat the task as the minimum: be ambitious and high-leverage, and finish the whole listed batch. Never print environment variables, secrets or tokens; solve any secrets need through Phantom Secrets and any MCP/CLI access need through Locus.`;
}

function emitJob(kind: RebaseJobSpec['kind'], members: RebaseJobMember[], sharedFiles: string[], after: string[], ctx: EmitContext): RebaseJobSpec {
  const sorted = [...members].sort((a, b) => a.number - b.number);
  const id = kind === 'single'
    ? `RQ-REBASE-${ctx.repo ?? 'unknown'}-${sorted[0]!.number}-${headTag(members[0]!)}`
    : `RQ-REBASE-BATCH-${ctx.repo ?? 'unknown'}-${sorted.map(m => m.number).join('-')}-${hash6(`${ctx.repo ?? 'unknown'}|${sorted.map(m => `${m.number}:${m.headSha ?? 'u'}`).join(',')}`)}`;
  const pinned = members.some(m => m.files.length >= MAX_FILES_PER_PR || m.files.some(securityPinnedPath));
  const afterAttr = after.length === 0 ? 'after none' : `after ${after.join(' and ')}`;
  const attrs = `${ctx.priority}, pool=${ctx.pool}, tier=${ctx.tier}${ctx.repo === null ? '' : `, repo=${ctx.repo}`}, ${afterAttr}, rebase-plan ${ctx.stamp}`;
  const text = jobText(kind, members, sharedFiles, ctx);
  // The pin leads the truncated body so the 560-char cap can never cut it.
  const line = `- READY ${id} (${attrs}): ${pinned ? `${QUEUEGEN_SECURITY_PIN} ` : ''}${singleLine(text)}`;
  const prompt = jobPrompt({ id, members, sharedFiles, pinned, after, attrs, text }, ctx);
  const fileUnion = new Set(members.flatMap(m => m.files));
  return {
    id, kind,
    repo: ctx.repo, repoFull: ctx.repoFull,
    status: 'READY', pool: ctx.pool, tier: ctx.tier, priority: ctx.priority,
    after, prs: members.map(m => m.number), members, sharedFiles,
    pinned, evidence: fileUnion.size > 0 ? 'ok' : 'no-file-data',
    promptFile: `prompts/${id}.md`, prompt, line,
  };
}

/** The ready.tsv row a writer appends after materializing the prompt file. */
export function renderReadyRow(spec: RebaseJobSpec, queueDir: string): string {
  return `${spec.id}\t${spec.repo ?? 'unknown'}\t${spec.pool}\t${spec.tier}\t${queueDir}/prompts/${spec.id}.md`;
}

/**
 * The planner. `prs` comes from parseMergeBatchPrs (or any caller-built list);
 * the result is fully deterministic for a fixed input.
 */
export function planRebaseJobs(input: RebasePlanInput): RebasePlan {
  const now = input.now ?? new Date();
  const repoFull = input.repo ?? null;
  const repo = repoFull === null ? null : shortName(repoFull);
  const pool = input.pool ?? 'any';
  if (!POOL_RE.test(pool)) throw new Error(`invalid pool "${pool.slice(0, 40)}"`);
  const tier = assertQueueTier(input.tier ?? 'work');
  const priority = input.priority ?? 'P1';
  if (!PRIORITY_RE.test(priority)) throw new Error(`invalid priority "${priority.slice(0, 10)}" (allowed P0–P3)`);
  const maxPrs = Math.min(REBASE_PLAN_MAX_JOB_MEMBERS, Math.max(1, input.maxPrs ?? REBASE_PLAN_DEFAULT_MAX_PRS));
  const hold = input.hold ?? new Set<string>();

  const prs = input.prs.slice(0, MAX_PRS);

  // The conflicting bridge-PR population — the same set fleet rebase-status counts.
  const conflicting = prs.filter(pr => isBridge(pr) && conflicted(pr));
  const unheld = conflicting.filter(pr => !held(pr, hold, repoFull));
  const heldCount = conflicting.length - unheld.length;

  // Coverage: drop PRs an active queue job already covers, then re-cluster the rest.
  const covered = input.existing === undefined ? new Set<number>() : coveredPrNumbers(input.existing, repoFull);
  const eligible = unheld.filter(pr => !covered.has(pr.number));
  const coveredPrs = unheld.filter(pr => covered.has(pr.number)).map(pr => pr.number);

  const ctx: EmitContext = { repo, repoFull, pool, tier, priority, stamp: hhmm(now) };
  const plan = planMergeBatches({ prs: eligible, repo: repoFull, now });

  const byNumber = new Map(eligible.map(pr => [pr.number, pr]));
  const jobs: RebaseJobSpec[] = [];
  let chunks = 0;
  let chained = 0;
  for (const batch of plan.batches) {
    if (batch.kind === 'independent') {
      const pr = byNumber.get(batch.order[0]!)!;
      jobs.push(emitJob('single', [memberOf(pr)], [], [], ctx));
      continue;
    }
    const adjacency = new Map<number, Set<number>>();
    for (const entry of batch.prs) adjacency.set(entry.number, new Set(entry.overlaps));
    // Batch ids embed every member number; chained chunks must stay inside
    // the router's 80-char gate-token bound (restock's JID_TOK) or their
    // DEPENDENCY GATE can never be extracted: 'RQ-REBASE-BATCH-<short>-' +
    // members + '-<hash6>'.
    const idChars = 80 - ('RQ-REBASE-BATCH-'.length + (repo ?? 'unknown').length + 1 + 1 + 6);
    const groups = batch.order.length <= maxPrs && batch.order.join('-').length <= idChars
      ? [batch.order]
      : chunkOrder(batch.order, adjacency, maxPrs, idChars);
    let previousId: string | null = null;
    groups.forEach((group, index) => {
      const members = group
        .map(n => memberOf(byNumber.get(n)!))
        // Keep each job's member order aligned with the batch's planned order.
        .sort((a, b) => batch.order.indexOf(a.number) - batch.order.indexOf(b.number));
      const kind = group.length === 1 ? 'single' : groups.length === 1 ? 'cluster' : 'cluster-chunk';
      const after = index === 0 ? [] : [previousId!];
      const job = emitJob(kind, members, batch.sharedFiles.slice(0, MAX_SHARED_FILES), after, ctx);
      jobs.push(job);
      previousId = job.id;
      if (groups.length > 1) { chunks += 1; if (index > 0) chained += 1; }
    });
  }

  return {
    schema: REBASE_PLAN_SCHEMA,
    v: 1,
    repo: repoFull,
    generatedAt: now.toISOString(),
    counts: {
      open: prs.length,
      unreadable: input.unreadable ?? 0,
      duplicates: input.duplicates ?? 0,
      conflicting: conflicting.length,
      held: heldCount,
      covered: coveredPrs.length,
      jobs: jobs.length,
      clusters: jobs.filter(j => j.kind !== 'single').length,
      singles: jobs.filter(j => j.kind === 'single').length,
      chunks,
      chained,
      pinned: jobs.filter(j => j.pinned).length,
      noFileData: jobs.filter(j => j.evidence === 'no-file-data').length,
    },
    coverage: {
      state: input.existingState ?? (input.existing === undefined ? 'skipped' : 'ok'),
      coveredPrs: coveredPrs.slice(0, MAX_COVERED_LIST),
    },
    jobs,
  };
}
