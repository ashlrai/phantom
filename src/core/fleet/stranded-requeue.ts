/**
 * `phm jobs stranded --requeue`: plan (and with apply, queue) one recovery row for each finished job whose
 * branch was pushed but whose publish aborted on the default-branch fetch race. Only that race is requeued;
 * any other abort reason is listed with its reason and left for a person. Dry run by default.
 *
 * Row layout is the dispatcher's, tab-separated: id, repo, lane, tier, absolute prompt path.
 */
import { open, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { readReadyText, parseReadyRows, rewriteReadyRows, type RewriteReadyRowsOptions } from './ready-row-edit.js';
import { readStrandedBranches, type StrandedBranch } from './stranded-branches.js';
import { needsGh } from './job-gaps.js';

export const REQUEUE_SCHEMA = 'jobs.stranded.requeue.v1';
/** Recovery ids are `<job>R2` then `<job>R3`; an R3 that is spent means gave up. */
const TRIES = [2, 3] as const;
const RECOVERY_SUFFIX = /R[2-9]$/;
const MAX_ORIGINAL_PROMPT = 32 * 1024;
const FETCH_RACE = 'default-fetch';
/** At most this many rows per tick, whatever the caller asks for. */
const MAX_PER_TICK = 3;
/** The only lane with gh; every other lane has none, so gh work never goes anywhere else. */
export const GH_LANE = 'codex-personal';
export const NO_GH_LANE_WHY = 'needs gh; no gh lane free';
const GH_JOB_ID = /^(?:RQ-)?FIXUP-(?:CI|MAIN)-/i;
const HEAD_BYTES = 512;

export interface RequeuedRow { job: string; id: string; repo: string; lane: string; promptPath: string; written: boolean }
export interface RequeueReport {
  schema: typeof REQUEUE_SCHEMA;
  apply: boolean;
  /** `unknown` when a publish log or the queue could not be read; nothing is requeued from guesses. */
  status: 'ok' | 'unknown';
  requeued: RequeuedRow[];
  gaveUp: { job: string; tries: number }[];
  /** Skipped because a PR exists, a recovery is already queued or running, or the id is taken. */
  already: { job: string; why: string; by?: string }[];
  /** Aborts that are not a fetch race: listed, never requeued. */
  notRequeued: { job: string; reason: string }[];
  /** Not requeued this run: over the per-run limit, or gh work with no gh lane free; the next run picks them up. */
  deferred: { job: string; why: string }[];
  /** Cannot plan from the log alone (for example the repo is not in it). */
  unknown: { job: string; why: string }[];
  unreadable: string[];
  summary: string;
}
export interface RequeueOptions {
  limit?: number;
  now?: number;
  apply?: boolean;
  sinceHours?: number | null;
  ready?: RewriteReadyRowsOptions;
  /** Free slots on the gh lane, read only when a job needs gh. Null or missing means unknown, which counts as none. */
  ghSlots?: () => Promise<number | null>;
}

/** Free slots on the gh lane from the live lane readings; null when they cannot be read. */
export async function readGhLaneSlots(): Promise<number | null> {
  try {
    const { getFleetLaneSnapshot } = await import('./lane-console.js');
    const { gapLaneRoom } = await import('./gap-lane-room.js');
    const snapshot = await getFleetLaneSnapshot();
    const room = gapLaneRoom(snapshot.lanes.map(view => ({
      lane: view.lane, running: view.liveJobs ?? null, target: view.slotTarget ?? null, queued: view.queueDepth ?? null,
      held: view.hold?.held === true, remainingPct: view.credit.remainingPct, resetAt: view.credit.resetAt,
    })), Date.now());
    return room.open.find(o => o.lane === GH_LANE)?.free ?? 0;
  } catch { return null; }
}

const idPattern = (id: string): RegExp => new RegExp(`(?<![A-Za-z0-9._-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`);
export const baseJob = (job: string): string => job.replace(RECOVERY_SUFFIX, '');
/** `RQ-BURNPACEN22QQ8` -> `RQ-BURNPACE`: a recovery may be queued under a new tail (`RQ-BURNPACER2N22SQ8`). */
const familyPrefix = (base: string): string => { const p = base.replace(/N\d+[A-Z]+\d+$/, ''); return p.length >= 6 ? p : base; };
const ID_TOKEN = /[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+/g;
const needsGhJob = (base: string, original: string | null): boolean => GH_JOB_ID.test(base) || (original !== null && needsGh({ title: original, why: '' }));

async function readHead(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return '';
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  } catch { return ''; }
}

export function recoveryPrompt(job: string, id: string, branch: string, repo: string, original: string | null): string {
  return [
    `# ${id}: recover finished job ${job}`,
    '',
    `Job ${job} finished and pushed branch ${branch} to the fork, but publishing aborted on a fetch race, so no PR opened.`,
    `Repo: ${repo}.`,
    '',
    '## Step R',
    `1. Fetch ${branch} from the fork remote (git remote -v shows it).`,
    '2. List the paths that branch changed against its merge base. Bring over only those paths onto current master; touch nothing else.',
    '3. Run the tests that cover those paths.',
    '4. If current master already has the same content for those paths, make no change and say so in BRIDGE_NOTES.md.',
    `5. If the fetch fails, redo the original task below from scratch. Do not guess what the branch held.`,
    '',
    '## Original prompt',
    original === null ? '(the original prompt file was not found; the task text is unknown)' : original.trimEnd(),
    '',
  ].join('\n');
}

async function readOriginal(promptsDir: string, job: string): Promise<string | null> {
  try {
    const file = await open(join(promptsDir, `${job}.md`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const { size, isFile } = await file.stat().then(s => ({ size: s.size, isFile: s.isFile() }));
      if (!isFile) return null;
      const buffer = Buffer.alloc(Math.min(size, MAX_ORIGINAL_PROMPT));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8') + (size > MAX_ORIGINAL_PROMPT ? '\n(truncated)\n' : '');
    } finally { await file.close(); }
  } catch { return null; }
}

const summaryLine = (r: Pick<RequeueReport, 'apply' | 'requeued' | 'gaveUp' | 'already'>): string =>
  `${r.apply ? 'requeued' : 'would_requeue'}=${r.requeued.length} gave_up=${r.gaveUp.length} already=${r.already.length}`;

export async function planStrandedRequeue(runsDir: string, opts: RequeueOptions = {}): Promise<RequeueReport> {
  const limit = opts.limit ?? 3, queueDir = join(runsDir, 'queue'), promptsDir = join(queueDir, 'prompts');
  const stranded = await readStrandedBranches(runsDir, { now: opts.now, sinceHours: opts.sinceHours ?? null });
  const report: RequeueReport = {
    schema: REQUEUE_SCHEMA, apply: opts.apply === true, status: stranded.status, requeued: [], gaveUp: [], already: [],
    notRequeued: [], deferred: [], unknown: [], unreadable: stranded.unreadable, summary: '',
  };

  // Where ids can already live: ready.tsv, router-queue.md, a .publish log or a prompt file.
  let queueReadable = true;
  const readyText = await readReadyText(join(queueDir, 'ready.tsv')).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') queueReadable = false; return ''; });
  const routerText = await readFile(join(queueDir, 'router-queue.md'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') queueReadable = false; return ''; });
  const files = new Set([...await readdir(runsDir).catch(() => []), ...await readdir(promptsDir).catch(() => [])]);
  const readyIds = new Set(parseReadyRows(readyText).map(row => row.id));
  // Every id the queue knows, and the first lines of queued prompts, to spot a recovery filed under another id.
  const knownIds = new Set<string>([...readyIds, ...[...files].filter(f => /\.(?:publish|md)$/.test(f)).map(f => f.replace(/\.(?:publish|md)$/, '')), ...(routerText.match(ID_TOKEN) ?? [])]);
  const readyHeads = await Promise.all(parseReadyRows(readyText).map(async row => ({ id: row.id, head: await readHead(row.promptPath) })));
  const recoveredBy = (job: string, strandedIds: ReadonlySet<string>): string | null => {
    const named = new RegExp(`(?:recover finished job |codex-bridge/)${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`);
    const ready = readyHeads.find(r => r.id !== job && named.test(r.head));
    if (ready) return ready.id;
    const line = routerText.split('\n').find(l => named.test(l));
    if (line !== undefined) return (line.match(ID_TOKEN) ?? []).find(id => id !== job) ?? 'a queued job';
    const prefix = familyPrefix(baseJob(job));
    return [...knownIds].sort().find(id => id !== job && id.startsWith(prefix) && id.includes('R2') && !strandedIds.has(id) && !idPattern(`${baseJob(job)}R2`).test(id)) ?? null;
  };
  const taken = (id: string): boolean => readyIds.has(id) || files.has(`${id}.publish`) || files.has(`${id}.md`) || idPattern(id).test(routerText);
  if (!queueReadable) { report.status = 'unknown'; report.summary = 'unknown: the queue files could not be read'; return report; }

  const groups = new Map<string, StrandedBranch[]>();
  for (const b of stranded.branches) groups.set(baseJob(b.job), [...(groups.get(baseJob(b.job)) ?? []), b]);
  const strandedJobs = new Set(stranded.branches.map(b => b.job));
  const recoveredBases = new Set(stranded.recovered.map(r => baseJob(r.job)));

  const planned: { base: string; id: string; row: StrandedBranch }[] = [];
  const originals = new Map<string, string | null>();
  for (const [base, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const bad = rows.find(r => r.reason !== FETCH_RACE);
    if (bad) { report.notRequeued.push({ job: bad.job, reason: bad.reason }); continue; }
    if (recoveredBases.has(base)) { report.already.push({ job: base, why: 'a pull request exists' }); continue; }
    const by = recoveredBy(base, strandedJobs);
    if (by !== null) { report.already.push({ job: base, why: `${by} already recovers this branch`, by }); continue; }
    const live = TRIES.map(n => `${base}R${n}`).find(id => taken(id) && !strandedJobs.has(id));
    if (live) { report.already.push({ job: base, why: `${live} is already queued or published` }); continue; }
    const next = TRIES.find(n => !taken(`${base}R${n}`));
    const row = rows.find(r => r.job === base) ?? rows[0]!;
    if (next === undefined) { report.gaveUp.push({ job: base, tries: TRIES.length + 1 }); continue; }
    if (row.repo === null) { report.unknown.push({ job: base, why: 'repo is not in the publish log' }); continue; }
    planned.push({ base, id: `${base}R${next}`, row });
  }

  const cap = Math.min(limit, MAX_PER_TICK);
  let ghFree: number | null | undefined;
  for (const p of planned) {
    const repo = p.row.repo!.split('/')[1]!, promptPath = join(promptsDir, `${p.id}.md`);
    const original = await readOriginal(promptsDir, p.base);
    originals.set(p.base, original);
    if (report.requeued.length >= cap) { report.deferred.push({ job: p.base, why: 'over the per-tick limit; the next run picks it up' }); continue; }
    let lane = 'claude';
    if (needsGhJob(p.base, original)) {
      // gh work only ever goes to the gh lane; unknown room counts as none.
      ghFree ??= opts.ghSlots ? await opts.ghSlots().catch(() => null) : null;
      if ((ghFree ?? 0) <= 0) { report.deferred.push({ job: p.base, why: NO_GH_LANE_WHY }); continue; }
      ghFree = (ghFree ?? 0) - 1; lane = GH_LANE;
    }
    report.requeued.push({ job: p.base, id: p.id, repo, lane, promptPath, written: false });
  }

  if (opts.apply && report.requeued.length) {
    for (const r of report.requeued) {
      const original = originals.get(r.job) ?? null;
      const handle = await open(r.promptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => null);
      if (!handle) { report.unknown.push({ job: r.job, why: 'prompt file could not be created' }); continue; }
      try { await handle.writeFile(recoveryPrompt(r.job, r.id, `codex-bridge/${r.job}`, r.repo, original)); } finally { await handle.close(); }
      r.written = true;
    }
    const written = report.requeued.filter(r => r.written);
    if (written.length) {
      // Create the file when it is missing so the guarded writer has something to edit.
      await (await open(join(queueDir, 'ready.tsv'), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)).close();
      const result = await rewriteReadyRows(queueDir, rows => {
        const have = new Set(rows.map(row => row.id));
        const add = written.filter(r => !have.has(r.id)).map(r => {
          const raw = [r.id, r.repo, r.lane, 'work', r.promptPath].join('\t');
          return { id: r.id, repo: r.repo, lane: r.lane, tier: 'work', promptPath: r.promptPath, raw };
        });
        return add.length ? [...rows, ...add] : null;
      }, opts.ready);
      if (!result.verified) { report.status = 'unknown'; report.unknown.push({ job: 'ready.tsv', why: 'the dispatcher rewrote the file; rows could not be confirmed' }); }
    }
    report.requeued = written;
  }
  report.summary = summaryLine(report);
  return report;
}

/** Plain-word lines for people; agents read the JSON. */
export function requeueText(r: RequeueReport): string[] {
  const out = [r.summary];
  for (const x of r.requeued) out.push(`${r.apply ? 'requeued' : 'would requeue'} ${x.job} as ${x.id} (${x.repo}${x.lane === 'claude' ? '' : `, ${x.lane} only: needs gh`})`);
  for (const x of r.already) if (x.by) out.push(`already recovered ${x.job}: ${x.by}`);
  for (const x of r.gaveUp) out.push(`gave up on ${x.job}: ${x.tries} tries used`);
  for (const x of r.notRequeued) out.push(`not requeued ${x.job}: abort reason ${x.reason} is not a fetch race, a person must look`);
  for (const x of r.unknown) out.push(`unknown ${x.job}: ${x.why}`);
  for (const x of r.deferred) out.push(`later ${x.job}: ${x.why}`);
  if (r.unreadable.length) out.push(`unknown, unreadable logs: ${r.unreadable.join(', ')}`);
  if (!r.apply && r.requeued.length) out.push('Dry run. Add --apply to write the rows.');
  return out;
}
