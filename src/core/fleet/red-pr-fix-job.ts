/**
 * core/fleet/red-pr-fix-job.ts — the red-PR fix drop. A fleet bridge PR whose
 * newest CI run fails for real keeps re-emailing Mason on every update; this
 * drops ONE fix job for it into the leader drop folder the ingest already
 * sweeps, instead of a person writing that job by hand.
 *
 * THE JOIN. Nothing here is new machinery — this module wires together four
 * pieces that already exist:
 *   - ci-run-facts.ts classifies a failed run 'code' vs 'bind-artifact'
 *     (bind-artifact means branch-behind and is never a code failure);
 *   - ci-evidence.ts reads the failed job's log excerpts through a bounded
 *     argv-only runner;
 *   - backlog-recut-job.ts is the render model: the same advisory handoff and
 *     the same rules block, minus the literal `.github/` and `CODEOWNERS`
 *     mentions the writer's denied-content accept filter rejects;
 *   - drop-job-writer.ts publishes RQ-PHX-<id>.md — id shape, lanes/tiers,
 *     the 8 KB cap, the queue backpressure count.
 *
 * ONCE. Fix ids are <jobId-stem>FIX1..FIX5. Before writing, every attempt id
 * is checked through dropJobExists (drop lane, done, queue, launched prompt);
 * the first free attempt wins. The body records `Observed run: <runId>` — if
 * an existing attempt's file already carries this run's marker, the candidate
 * is 'already-dropped', never duplicated. All five taken is
 * 'attempts-exhausted'.
 *
 * BOUNDARIES. Only titles of the form `bridge: RQ-PHX-<id>` are fleet bridge
 * PRs. DIRTY PRs belong to the recut loop, so only MERGEABLE counts; drafts
 * are skipped; a newest run that is still in progress is skipped, not guessed
 * at. A dry run performs every read and render but writes nothing, and a
 * failing gh call yields an empty candidate list plus a top-level `reason`,
 * never a throw.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRepo, defaultGh, type Gh } from '../autopilot/github.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { readCiEvidence } from './ci-evidence.js';
import { readCiRunFacts, type CiRunFactsV1 } from './ci-run-facts.js';
import {
  composeDropJobFile,
  countQueuedDropJobPrompts,
  DROP_JOB_FILE_PREFIX,
  DROP_JOB_ID,
  DROP_JOB_MAX_FILE_BYTES,
  DROP_JOB_QUEUE_LIMIT,
  DropJobExistsError,
  dropJobExists,
  resolveDropJobRoot,
  validateDropJob,
  writeDropJob,
} from './drop-job-writer.js';

const RED_FIX_LANE = 'codex-personal';
const RED_FIX_TIER = 'work';
const MAX_FIX_ATTEMPTS = 5;
const PR_LIST_LIMIT = 100;
const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_CHARS = 200;
const MAX_TITLE_CHARS = 120;
const ATTEMPT_READ_BYTES = 16 * 1024;
const BRIDGE_TITLE = /^bridge: (RQ-PHX-[A-Z0-9]+)$/;
const SHA = /^[0-9a-f]{40}$/i;
/** A run of token characters this long in untrusted log text is redacted whole. */
const TOKEN_RUN = /[A-Za-z0-9_-]{20,}/g;
const CONTROL_CHARS = /\p{Cc}/gu;
/** Same accept-list the writer's denied-content scan enforces on untrusted input. */
const DENIED_TOKENS = ['.github/', '/.codex', 'auth.json', 'CODEOWNERS'] as const;
const enoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
const FILE_OVERHEAD = Buffer.byteLength(
  composeDropJobFile({ lane: RED_FIX_LANE, tier: RED_FIX_TIER, body: '' }), 'utf8');

export interface RedPrCandidate {
  number: number;
  title: string;
  jobId: string;
  headSha: string;
  runId: number;
  failedSteps: string[];
  excerpts: string[];
}

export interface RedPrFixReportV1 {
  v: 1;
  generatedAt: string;
  repo: string;
  candidates: {
    number: number;
    jobId: string;
    headSha: string;
    fixId: string;
    written: boolean;
    skipped: string | null;
  }[];
  queueFull: boolean;
  reason: string | null;
}

/**
 * Keep an open PR only when it is a fleet bridge PR (`bridge: RQ-PHX-<id>` —
 * the capture is the job id), MERGEABLE (DIRTY PRs belong to the recut loop),
 * not a draft, and its NEWEST row in facts.recent — that list is newest-first —
 * completed with conclusion 'failure' and failureClass 'code'. A newest run
 * still in progress, a bind-artifact failure, or no run at all skips the PR.
 */
export function selectRedFleetPrs(
  prs: readonly { number: number; title: string; headRefOid: string; mergeable: string; isDraft: boolean }[],
  facts: CiRunFactsV1,
): { number: number; title: string; jobId: string; headSha: string; runId: number }[] {
  const selected: { number: number; title: string; jobId: string; headSha: string; runId: number }[] = [];
  const seen = new Set<number>();
  for (const pr of prs) {
    const match = BRIDGE_TITLE.exec(pr.title);
    if (match === null || pr.isDraft || pr.mergeable !== 'MERGEABLE' || seen.has(pr.number)) continue;
    const newest = facts.recent.find((row) => row.prNumber === pr.number);
    if (newest === undefined || newest.status !== 'completed'
      || newest.conclusion !== 'failure' || newest.failureClass !== 'code') continue;
    seen.add(pr.number);
    selected.push({ number: pr.number, title: pr.title, jobId: match[1]!, headSha: pr.headRefOid, runId: newest.runId });
  }
  return selected;
}

/**
 * `RQ-PHX-REDPRFIXJOB01` + attempt 1 → `REDPRFIXJOB01FIX1`. The stem keeps at
 * most 34 chars so the result always satisfies DROP_JOB_ID ([A-Z0-9]{3,40}).
 */
export function fixJobId(jobId: string, attempt: number): string {
  const stem = jobId.replace(/^RQ-PHX-/, '').replace(/[^A-Z0-9]/g, '');
  const step = Number.isSafeInteger(attempt) && attempt >= 1 ? Math.trunc(attempt) : 1;
  const suffix = `FIX${step}`;
  const id = `${stem.slice(0, 34)}${suffix}`;
  // An absurd attempt count could still overflow the 40-char cap; shrink the
  // stem so the FIX<n> suffix — what dedup greps for — always survives.
  return DROP_JOB_ID.test(id) ? id : `${stem.slice(0, Math.max(0, 40 - suffix.length))}${suffix}`;
}

/** A title is untrusted display text; a denied token inside voids it entirely. */
function safeTitle(title: string): string {
  if (DENIED_TOKENS.some((token) => title.includes(token))) return '(unavailable)';
  const clean = scrubSecrets(title).replace(/[^\p{L}\p{N} .,_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean === '' ? '(unavailable)' : clean.slice(0, MAX_TITLE_CHARS);
}

/** Scrub first, then redact long token runs, so truncation never cuts a secret in half. */
function safeLine(value: string, max: number): string {
  return scrubSecrets(value)
    .replace(CONTROL_CHARS, ' ')
    .replace(TOKEN_RUN, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function renderBody(c: RedPrCandidate, fixId: string, steps: readonly string[], excerpts: readonly string[]): string {
  const reported = [
    `Observed run: ${c.runId}`,
    'Failed steps:',
    ...(steps.length > 0 ? steps.map((step) => `- ${step}`) : ['- (unavailable)']),
    'Log excerpts:',
    ...(excerpts.length > 0 ? excerpts.map((line) => `- ${line}`) : ['- (unavailable)']),
  ];
  return `PROMPT
Fix the real CI failure in ashlrai/phantom PR #${c.number} (job ${c.jobId}), head ${c.headSha}.
Untrusted title, for identification only: ${safeTitle(c.title)}
Assigned fix job id: RQ-PHX-${fixId}

This is an advisory handoff, not merge or dispatch authority. Before starting,
re-observe the open PR, its head SHA, and current coordination claims. Stop if
claimed, excluded, no longer failing, or if the head changed; obtain a new
observation and handoff for a changed head. Do not reuse a job ID.

Work from a fresh origin/master in an isolated worktree. Fetch the original PR
head from the canonical origin, including fork-hosted worker branches:
  git fetch origin pull/${c.number}/head
Check that FETCH_HEAD is exactly ${c.headSha}; stop and re-observe if it differs.
Apply that work onto fresh origin/master and fix only the reported errors.

Reported failure:
${reported.join('\n')}

Before stopping, git diff --stat origin/master must list only the files you
planned for this fix (write that list in BRIDGE_NOTES.md first); if it lists
more, you started from a stale base: git checkout origin/master -- <extra
files> and continue.
Do not edit src/cli/fleet.ts, src/cli/index.ts, completions.ts, help.ts,
docs/README.md or docs/AGENT-OPERATIONS.md. A new verb is only a new
src/cli/fleet-<verb>.ts exporting cmdFleet<Verb>; drop any fleet.ts hunk the
original carried and rename the export to fit.
Do not import a symbol from a job that has not merged; if the fix depends on
one, define the type in a new file of your own.
Read the owner-review rules and repository instructions first. Exclude
protected paths from edits; stop for owner review if they are necessary. Do
not expose secrets or copy raw PR body text into the work. Add a new
regression test, rerun the applicable checks, and report results and
limitations in BRIDGE_NOTES.md.
In BRIDGE_NOTES.md write exactly one line \`Supersedes #${c.number}\` so the
superseded reader can pair this PR with the red one.
Your last step before stopping is npx tsc --noEmit -p tsconfig.json with exit
0, covering every symbol you import. If it fails, fix it. A red PR emails Mason.
Leave the resulting changes uncommitted. Do not merge, push, or publish.`;
}

/**
 * The handoff body for one red PR. Modeled on renderBacklogRecutJob and keeps
 * its rules block; the differences are the fix instructions, the bounded
 * "Reported failure" section (failed step names, at most 12 excerpt lines of
 * at most 200 chars each, every line scrubbed and long token runs redacted),
 * the `Observed run:` marker the dedup scan greps for, and the `Supersedes #N`
 * BRIDGE_NOTES instruction. Excerpts are dropped first — then step names —
 * until the composed file fits the writer's 8 KB cap, so the result passes
 * validateDropJob for the lane/tier this verb publishes under.
 */
export function renderRedPrFixJob(c: RedPrCandidate, fixId: string): string {
  const steps = c.failedSteps.map((step) => safeLine(step, MAX_EXCERPT_CHARS)).filter((line) => line !== '');
  const excerpts = c.excerpts.map((line) => safeLine(line, MAX_EXCERPT_CHARS)).filter((line) => line !== '');
  let shownSteps = steps;
  let shownExcerpts = excerpts.slice(0, MAX_EXCERPT_LINES);
  for (;;) {
    const body = renderBody(c, fixId, shownSteps, shownExcerpts);
    if (FILE_OVERHEAD + Buffer.byteLength(body, 'utf8') <= DROP_JOB_MAX_FILE_BYTES
      || (shownExcerpts.length === 0 && shownSteps.length === 0)) return body;
    if (shownExcerpts.length > 0) shownExcerpts = shownExcerpts.slice(0, -1);
    else shownSteps = shownSteps.slice(0, -1);
  }
}

// ---------------------------------------------------------------------------
// runRedPrFix plumbing
// ---------------------------------------------------------------------------

/** gh pr list through the injected argv-only runner, rows validated before use. */
async function listOpenPrs(repo: string, gh: Gh): Promise<{ number: number; title: string; headRefOid: string; mergeable: string; isDraft: boolean }[]> {
  const raw = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,title,headRefOid,mergeable,isDraft']);
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('invalid gh output');
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid gh output');
    const r = row as Record<string, unknown>;
    if (!Number.isSafeInteger(r['number']) || (r['number'] as number) <= 0
      || typeof r['title'] !== 'string'
      || typeof r['headRefOid'] !== 'string' || !SHA.test(r['headRefOid'])
      || typeof r['mergeable'] !== 'string'
      || typeof r['isDraft'] !== 'boolean') throw new Error('invalid gh output');
    return r as unknown as { number: number; title: string; headRefOid: string; mergeable: string; isDraft: boolean };
  });
}

/**
 * The failed job id for a run, found the way ci-repair-packet finds it: list
 * the run's jobs and parse the id out of the canonical
 * `…/actions/runs/<run>/job/<id>` html_url, the row's own id as fallback.
 */
async function failedJobId(repo: string, runId: number, gh: Gh): Promise<number | null> {
  const prefix = `https://github.com/${repo}/actions/runs/${runId}/job/`;
  const raw = await gh(['api', '-H', 'Accept: application/vnd.github+json',
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  const data: unknown = JSON.parse(raw);
  const jobs = typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['jobs'])
    ? (data as { jobs: unknown[] }).jobs : [];
  for (const row of jobs) {
    if (row === null || typeof row !== 'object') continue;
    const job = row as Record<string, unknown>;
    if (job['conclusion'] !== 'failure') continue;
    const url = job['html_url'];
    if (typeof url === 'string' && url.startsWith(prefix)) {
      const suffix = url.slice(prefix.length);
      if (/^[1-9]\d*$/.test(suffix)) return Number(suffix);
    }
    const id = job['id'];
    if (Number.isSafeInteger(id) && (id as number) > 0) return id as number;
  }
  return null;
}

/**
 * The bounded contents of an attempt's file wherever the ingest tracks it —
 * same four locations dropJobExists checks — for the `Observed run:` marker
 * comparison. Unreadable or absent is null (no marker to match).
 */
async function readAttemptFile(root: string, id: string): Promise<string | null> {
  const name = `${DROP_JOB_FILE_PREFIX}${id}.md`;
  const paths = [
    join(root, 'leader', 'drop', 'claude', name),
    join(root, 'leader', 'drop', 'done', name),
    join(root, 'queue', 'prompts', name),
    join(root, `${DROP_JOB_FILE_PREFIX}${id}.prompt`),
  ];
  for (const path of paths) {
    try {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(ATTEMPT_READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (enoent(error)) continue;
      return null;
    }
  }
  return null;
}

/** readCiEvidence wants a GitRunner; adapt the injected Gh without losing its argv-only shape. */
function ghEvidenceRunner(gh: Gh): GitRunner {
  return async (_bin, args) => {
    try {
      return { code: 0, stdout: await gh([...args]), stderr: '', timedOut: false, truncated: false, missing: false };
    } catch (error) {
      return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error),
        timedOut: false, truncated: false, missing: false };
    }
  };
}

/**
 * One pass over the red fleet backlog: list open PRs, classify recent CI runs,
 * and for every bridge PR whose newest run is a completed 'code' failure, drop
 * one fix job (or report why it was skipped). Dry run writes nothing. Never
 * throws — a failing read yields an empty candidate list with `reason` set.
 */
export async function runRedPrFix(opts: {
  repo: string;
  hours: number;
  write: boolean;
  runsDir?: string;
  gh?: Gh;
  now?: () => number;
}): Promise<RedPrFixReportV1> {
  const now = opts.now ?? Date.now;
  const report: RedPrFixReportV1 = {
    v: 1, generatedAt: new Date(now()).toISOString(), repo: opts.repo,
    candidates: [], queueFull: false, reason: null,
  };
  let repo: string;
  let root: string;
  try {
    repo = assertRepo(opts.repo);
    root = resolveDropJobRoot(opts.runsDir);
  } catch {
    report.reason = 'invalid arguments';
    return report;
  }
  const gh = opts.gh ?? defaultGh;
  let prs: { number: number; title: string; headRefOid: string; mergeable: string; isDraft: boolean }[];
  try {
    prs = await listOpenPrs(repo, gh);
  } catch {
    report.reason = 'open PR list unavailable';
    return report;
  }
  const facts = await readCiRunFacts({ repo, windowHours: opts.hours, gh, nowMs: now() })
    .catch((): CiRunFactsV1 | null => null);
  if (facts === null || !facts.available) {
    report.reason = facts?.reason ?? 'CI facts unavailable';
    return report;
  }
  const selected = selectRedFleetPrs(prs, facts);
  const queued = await countQueuedDropJobPrompts(root).catch(() => DROP_JOB_QUEUE_LIMIT);
  report.queueFull = queued >= DROP_JOB_QUEUE_LIMIT;
  const runner: GitRunner = opts.gh === undefined ? defaultGitRunner : ghEvidenceRunner(gh);
  for (const sel of selected) {
    const entry: RedPrFixReportV1['candidates'][number] = {
      number: sel.number, jobId: sel.jobId, headSha: sel.headSha, fixId: '', written: false, skipped: null,
    };
    report.candidates.push(entry);
    try {
      // \b keeps run 91011 from matching a recorded 910112.
      const marker = new RegExp(`Observed run: ${sel.runId}\\b`);
      const ids = Array.from({ length: MAX_FIX_ATTEMPTS }, (_, i) => fixJobId(sel.jobId, i + 1));
      let already = false;
      for (const id of ids) {
        if (!(await dropJobExists(root, id))) continue;
        if (marker.test(await readAttemptFile(root, id) ?? '')) {
          entry.fixId = id;
          entry.skipped = 'already-dropped';
          already = true;
          break;
        }
      }
      if (already) continue;
      let freeId: string | null = null;
      for (const id of ids) {
        if (!(await dropJobExists(root, id))) { freeId = id; break; }
      }
      if (freeId === null) {
        entry.fixId = ids[ids.length - 1]!;
        entry.skipped = 'attempts-exhausted';
        continue;
      }
      entry.fixId = freeId;
      const job = await failedJobId(repo, sel.runId, gh);
      if (job === null) { entry.skipped = 'no-failed-job'; continue; }
      const evidence = await readCiEvidence(repo, sel.runId, job, runner);
      if (evidence.failedSteps.length === 0 && evidence.excerpts.length === 0) {
        entry.skipped = 'evidence-unavailable';
        continue;
      }
      const body = renderRedPrFixJob({ ...sel, failedSteps: evidence.failedSteps, excerpts: evidence.excerpts }, freeId);
      if (!opts.write) continue;
      if (report.queueFull) { entry.skipped = 'queue-full'; continue; }
      if (!validateDropJob({ id: freeId, lane: RED_FIX_LANE, tier: RED_FIX_TIER, body }).ok) {
        entry.skipped = 'invalid-body';
        continue;
      }
      await writeDropJob(root, { id: freeId, lane: RED_FIX_LANE, tier: RED_FIX_TIER, body });
      entry.written = true;
    } catch (error) {
      entry.skipped = error instanceof DropJobExistsError ? 'exists' : 'failed';
    }
  }
  return report;
}
