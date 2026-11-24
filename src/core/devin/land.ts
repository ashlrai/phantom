/**
 * `phm devin land` — land a Devin cloud session's work through the fleet's
 * pinned publisher. Devin sessions cannot push upstream, so a session attaches
 * `<slug>.bundle` (`git bundle create … origin/master..HEAD`) and `<slug>.pr.md`
 * (first line title, rest body). This module:
 *
 *   1. reads the session and its attachments through the Devin API (key from
 *      the existing custody, see service.ts connectedClient);
 *   2. downloads both files, verifies the bundle and finds the session's own
 *      commits (merge-base of the bundle tip with origin/<base>);
 *   3. with `apply`: adds the worktree `~/Projects/ashlrai/wt/<J>` on
 *      `codex-bridge/<J>`, rebases those commits onto origin/<base>, writes the
 *      job records publish.sh reads (`queue/run/<J>.line`, `<J>.base`,
 *      `<J>.body.md`), runs the unchanged `~/.ashlr-runs/bin/publish.sh <J>`,
 *      parses its `RESULT PR <url>` line, turns on auto-merge unless publish.sh
 *      withheld it, and appends the landing to the Devin ledger.
 *
 * Without `apply` nothing is created: the plan is computed from scratch copies
 * of the attachments and the repo's current origin ref. publish.sh, scrub.pl
 * and the other pinned files are invoked, never written; repos outside
 * publish.sh's allowlist are refused before any API call.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DevinClient, DevinSessionAttachment } from './client.js';
import { devinHome, ensureDevinDirectory, listDevinTasks, writeDevinTask } from './store.js';
import { DEVIN_SESSION_ID_PATTERN, type DevinTaskV1 } from './types.js';

/** publish.sh's repo allowlist (`case "$NAME" in …`); also postrun_pr.py REPOS. */
export const DEVIN_LAND_REPOS = ['phantom', 'phantom-secrets', 'ashlr-plugin', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack'] as const;
export const DEVIN_LAND_UPSTREAM_OWNER = 'ashlrai';
export const DEVIN_LAND_LANE = 'devin';
export const DEVIN_LAND_TIER = 'frontier';
export const DEVIN_LAND_LEDGER_FILE = 'landings.jsonl';
export const DEVIN_LAND_MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
export const DEVIN_LAND_MAX_PR_MD_BYTES = 256 * 1024;
export const DEVIN_LAND_MAX_COMMITS = 100;
const JOB_ID = /^[A-Za-z0-9._-]{1,80}$/;
const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,100}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PUBLISH_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 10 * 60_000;

export type DevinLandApi = Pick<DevinClient, 'getSession' | 'listSessionAttachments' | 'downloadAttachment'>;

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export type CommandRunner = (cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CommandResult>;

export interface DevinLandRequest {
  sessionId: string;
  /** Allowlisted name or `ashlrai/<name>`; default `phantom`. */
  repo?: string;
  /** Default branch to land on; default from origin/HEAD, else `master`. */
  base?: string;
  /** Job id; default `DEVIN-<first 12 id chars>`. */
  job?: string;
  /** Attachment name of the bundle when the session attached more than one. */
  bundle?: string;
  apply: boolean;
}

export interface DevinLandDeps {
  /** Host home: `~/.ashlr-runs` and `~/Projects/ashlrai` live under it. */
  home?: string;
  api?: () => Promise<{ client: DevinLandApi; orgId: string } | { error: string }>;
  run?: CommandRunner;
  now?: () => Date;
}

export interface DevinLandCommit { sha: string; subject: string }

export interface DevinLandResult {
  v: 1;
  ok: boolean;
  mode: 'dry-run' | 'apply';
  sessionId: string;
  repo: string | null;
  job: string | null;
  session?: { url: string; title: string | null; status: string };
  bundle?: { name: string; bytes: number; sha256: string; ref: string; tip: string };
  prMd?: { name: string; title: string };
  base?: { branch: string; sha: string };
  mergeBase?: string;
  commitCount?: number;
  commits?: DevinLandCommit[];
  worktree?: string;
  branch?: string;
  /** What `apply` does (dry run) or did (apply), in order. */
  steps: string[];
  publish?: { result: string; pr: string | null; sens: string; headSha: string | null };
  autoMerge?: { armed: boolean; detail: string; reasonCode?: 'arm-refused' };
  ledger?: { path: string; taskId: string | null };
  error?: string;
}

class LandError extends Error {}

export function normalizeLandRepo(input: string | undefined): string | null {
  const raw = (input ?? 'phantom').trim();
  const name = raw.startsWith(`${DEVIN_LAND_UPSTREAM_OWNER}/`) ? raw.slice(DEVIN_LAND_UPSTREAM_OWNER.length + 1) : raw;
  return (DEVIN_LAND_REPOS as readonly string[]).includes(name) ? name : null;
}

export function defaultLandJobId(sessionId: string): string {
  return `DEVIN-${sessionId.replace(/^devin-/, '').slice(0, 12)}`;
}

/** First non-empty line (minus a leading `#`) is the title; the rest, trimmed, is the body. */
export function parsePrMd(text: string): { title: string; body: string } | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return null;
  const title = lines[first]!.replace(/^#+\s*/, '').trim().slice(0, 200);
  if (title === '') return null;
  return { title, body: lines.slice(first + 1).join('\n').trim() };
}

/** Last `RESULT …` line of a publish.sh log, with the PR url when it is `RESULT PR` for this repo. */
export function parsePublishResult(log: string, repo: string): { result: string; pr: string | null; sens: string; headSha: string | null } {
  const rows = log.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('RESULT'));
  const result = rows.at(-1) ?? '';
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^RESULT PR (https://github\\.com/${DEVIN_LAND_UPSTREAM_OWNER}/${escaped}/pull/[1-9][0-9]*)(?:\\s+HEADSHA=([^\\s]+))?(?:\\s+SENS=\\[(.*)\\])?\\s*$`).exec(result);
  const headSha = match?.[2] && SHA.test(match[2]) ? match[2] : null;
  return { result: result.split(/\s+/).slice(0, 3).join(' '), pr: match ? match[1]! : null, sens: match ? (match[3] ?? '').trim() : '', headSha };
}

/**
 * publish.sh arms auto-merge itself when its gates pass. A sensitive path, a
 * judge veto, red CI, an unknown head or a deferral to arm_gate.py is a
 * decision, never overridden here; only `skipped-or-failed` (the gh call
 * itself failed) or no AUTO_MERGE line at all is retried.
 */
export function autoMergeDecision(log: string, sens: string): { arm: boolean; detail: string } {
  if (sens !== '') return { arm: false, detail: `publish.sh flagged sensitive paths (${sens}); left for Security review` };
  const withheld = log.split('\n').find((line) => /^NOTE AUTO_MERGE (?!skipped-or-failed)(skipped|not armed|deferred)/.test(line.trim()));
  if (withheld) return { arm: false, detail: withheld.trim() };
  if (log.split('\n').some((line) => /^AUTO_MERGE on/.test(line.trim()))) return { arm: false, detail: 'already armed by publish.sh' };
  return { arm: true, detail: 'arming with the publish result head SHA' };
}

const defaultRun: CommandRunner = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, [...args], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    const exit = (error as { code?: unknown } | null)?.code;
    resolve({ code: error ? (typeof exit === 'number' && exit !== 0 ? exit : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

async function defaultApi(): Promise<{ client: DevinLandApi; orgId: string } | { error: string }> {
  const { connectedClient } = await import('./service.js');
  const connected = await connectedClient();
  return 'error' in connected ? { error: connected.error } : connected;
}

/** Child env: the host's, with any GIT_* override dropped so git acts only on the paths given. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  env['HOME'] = home;
  return env;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\t\r\n]+/g, ' ');
  return [...flat].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f).join('').trim().slice(0, max);
}

function attachmentKey(attachment: DevinSessionAttachment): { uuid: string; name: string } {
  try {
    const parts = new URL(attachment.url).pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const at = parts.lastIndexOf('attachments');
    if (at !== -1 && parts.length === at + 3) return { uuid: parts[at + 1]!, name: parts[at + 2]! };
  } catch { /* fall through */ }
  return { uuid: attachment.attachmentId, name: attachment.name };
}

function pickAttachments(list: readonly DevinSessionAttachment[], bundleName: string | undefined): { bundle: DevinSessionAttachment; prMd: DevinSessionAttachment } {
  const fromDevin = list.filter((a) => a.source === 'devin');
  const bundles = fromDevin.filter((a) => a.name.endsWith('.bundle') && (bundleName === undefined || a.name === bundleName));
  if (bundles.length === 0) throw new LandError(bundleName ? `The session has no attachment named ${bundleName}.` : 'The session attached no .bundle file.');
  const names = [...new Set(bundles.map((a) => a.name))];
  if (names.length > 1) throw new LandError(`The session attached several bundles (${names.join(', ')}); pick one with --bundle.`);
  const bundle = bundles.at(-1)!;
  const slug = bundle.name.slice(0, -'.bundle'.length);
  const prMds = fromDevin.filter((a) => a.name === `${slug}.pr.md`);
  const anyPrMd = fromDevin.filter((a) => a.name.endsWith('.pr.md'));
  const prMd = prMds.at(-1) ?? (new Set(anyPrMd.map((a) => a.name)).size === 1 ? anyPrMd.at(-1) : undefined);
  if (!prMd) throw new LandError(`The session attached no ${slug}.pr.md.`);
  return { bundle, prMd };
}

function writeExclusive(path: string, content: string): void {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}

function appendLedger(entry: Record<string, unknown>): string {
  ensureDevinDirectory();
  const path = join(devinHome(), DEVIN_LAND_LEDGER_FILE);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return path;
}

function recordTrackedTask(sessionId: string, repo: string, pr: string, title: string, now: Date): string | null {
  const task = listDevinTasks(500).find((t: DevinTaskV1) => t.sessionId === sessionId);
  if (!task || task.repo !== `${DEVIN_LAND_UPSTREAM_OWNER}/${repo}`) return null;
  const number = Number(pr.split('/').at(-1));
  const next: DevinTaskV1 = {
    ...task,
    state: task.state === 'merged' ? task.state : 'pr-open',
    stateReason: 'Landed through publish.sh by phm devin land.',
    pr: { number, url: pr, state: 'open', draft: false, title },
    updatedAt: now.toISOString(),
  };
  writeDevinTask(next);
  return task.id;
}

export async function landDevinSession(request: DevinLandRequest, deps: DevinLandDeps = {}): Promise<DevinLandResult> {
  const out: DevinLandResult = { v: 1, ok: false, mode: request.apply ? 'apply' : 'dry-run', sessionId: request.sessionId, repo: null, job: null, steps: [] };
  const home = deps.home ?? homedir();
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? (() => new Date());
  const env = childEnv(home);
  let scratch: string | null = null;
  try {
    if (!DEVIN_SESSION_ID_PATTERN.test(request.sessionId)) throw new LandError('That is not a Devin session id.');
    const repo = normalizeLandRepo(request.repo);
    if (!repo) throw new LandError(`Refused: ${request.repo} is not on publish.sh's allowlist (${DEVIN_LAND_REPOS.join(', ')}).`);
    out.repo = repo;
    const job = request.job ?? defaultLandJobId(request.sessionId);
    if (!JOB_ID.test(job) || job.includes('..')) throw new LandError('The job id may use only letters, digits, ".", "_" and "-".');
    out.job = job;

    const runs = join(home, '.ashlr-runs');
    const repoDir = join(home, 'Projects', DEVIN_LAND_UPSTREAM_OWNER, repo);
    const worktree = join(home, 'Projects', DEVIN_LAND_UPSTREAM_OWNER, 'wt', job);
    const branch = `codex-bridge/${job}`;
    const publish = join(runs, 'bin', 'publish.sh');
    const lineFile = join(runs, 'queue', 'run', `${job}.line`);
    const baseFile = join(runs, `${job}.base`);
    const bodyFile = join(runs, `${job}.body.md`);
    const publishLog = join(runs, `${job}.publish`);
    out.worktree = worktree;
    out.branch = branch;
    if (/\s/.test(worktree)) throw new LandError('The worktree path contains whitespace, which publish.sh cannot read.');

    const git = async (cwd: string, args: string[], what: string): Promise<string> => {
      const result = await run('git', args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
      if (result.code !== 0) throw new LandError(`${what} failed: ${oneLine(result.stderr || result.stdout, 300) || `exit ${result.code}`}`);
      return result.stdout;
    };

    // Preflight: everything that would make apply unsafe is refused before any download.
    if (!existsSync(join(repoDir, '.git'))) throw new LandError(`No ${DEVIN_LAND_UPSTREAM_OWNER}/${repo} checkout at ~/Projects/${DEVIN_LAND_UPSTREAM_OWNER}/${repo}.`);
    if (!existsSync(publish) || !lstatSync(publish).isFile()) throw new LandError('~/.ashlr-runs/bin/publish.sh is missing.');
    for (const [path, what] of [[worktree, 'worktree'], [lineFile, 'job record'], [baseFile, 'base record'], [bodyFile, 'PR body'], [join(runs, `${job}.prompt`), 'prompt'], [publishLog, 'publish log']] as const) {
      if (existsSync(path)) throw new LandError(`Job ${job} already has a ${what}; pass a new --job.`);
    }
    if ((await run('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoDir, env, timeoutMs: GIT_TIMEOUT_MS })).code === 0) {
      throw new LandError(`Branch ${branch} already exists; pass a new --job.`);
    }

    let baseBranch = request.base ?? null;
    if (baseBranch === null) {
      const head = await run('git', ['-C', repoDir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoDir, env, timeoutMs: GIT_TIMEOUT_MS });
      baseBranch = head.code === 0 && head.stdout.trim().startsWith('origin/') ? head.stdout.trim().slice('origin/'.length) : 'master';
    }
    if (!BRANCH_NAME.test(baseBranch) || baseBranch.includes('..') || baseBranch.startsWith('-')) throw new LandError('The base branch name is not valid.');

    // Devin API: the session, its attachments, then the two files.
    const api = await (deps.api ?? defaultApi)();
    if ('error' in api) throw new LandError(api.error);
    const session = await api.client.getSession(api.orgId, request.sessionId);
    out.session = { url: session.url, title: session.title, status: session.status };
    const { bundle, prMd } = pickAttachments(await api.client.listSessionAttachments(api.orgId, request.sessionId), request.bundle);
    const bundleKey = attachmentKey(bundle);
    const prKey = attachmentKey(prMd);
    const bundleBytes = await api.client.downloadAttachment(api.orgId, bundleKey.uuid, bundleKey.name, DEVIN_LAND_MAX_BUNDLE_BYTES);
    const prBytes = await api.client.downloadAttachment(api.orgId, prKey.uuid, prKey.name, DEVIN_LAND_MAX_PR_MD_BYTES);
    const pr = parsePrMd(prBytes.toString('utf8'));
    if (!pr) throw new LandError(`${prMd.name} has no title line.`);
    out.prMd = { name: prMd.name, title: pr.title };

    let landDir: string;
    if (request.apply) {
      landDir = join(runs, 'devin-land', job);
      mkdirSync(landDir, { recursive: true, mode: 0o700 });
    } else {
      scratch = mkdtempSync(join(tmpdir(), 'phm-devin-land-'));
      landDir = scratch;
    }
    const bundlePath = join(landDir, `${job}.bundle`);
    writeFileSync(bundlePath, bundleBytes, { mode: 0o600 });
    writeFileSync(join(landDir, `${job}.pr.md`), prBytes, { mode: 0o600 });

    if (request.apply) {
      await git(repoDir, ['-C', repoDir, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], `git fetch origin ${baseBranch}`);
      out.steps.push(`fetched origin/${baseBranch}`);
    }
    const baseSha = (await git(repoDir, ['-C', repoDir, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`], `resolve origin/${baseBranch}`)).trim();
    if (!SHA.test(baseSha)) throw new LandError(`origin/${baseBranch} did not resolve to a commit.`);
    out.base = { branch: baseBranch, sha: baseSha };

    await git(repoDir, ['-C', repoDir, 'bundle', 'verify', '--quiet', bundlePath], 'git bundle verify');
    const heads = (await git(repoDir, ['-C', repoDir, 'bundle', 'list-heads', bundlePath], 'git bundle list-heads'))
      .split('\n').map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 2 && SHA.test(parts[0]!)) as Array<[string, string]>;
    const head = heads.find(([, ref]) => ref === 'HEAD') ?? (heads.length === 1 ? heads[0] : undefined);
    if (!head) throw new LandError(heads.length === 0 ? 'The bundle carries no refs.' : 'The bundle carries several refs and no HEAD.');
    const [tip, ref] = head;
    out.bundle = { name: bundle.name, bytes: bundleBytes.length, sha256: createHash('sha256').update(bundleBytes).digest('hex'), ref, tip };
    await git(repoDir, ['-C', repoDir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundlePath, ref], 'git fetch from the bundle');
    await git(repoDir, ['-C', repoDir, 'cat-file', '-e', `${tip}^{commit}`], 'read the bundle tip');

    const mergeBase = (await git(repoDir, ['-C', repoDir, 'merge-base', baseSha, tip], 'git merge-base')).trim();
    if (!SHA.test(mergeBase)) throw new LandError('The bundle shares no history with the base branch.');
    out.mergeBase = mergeBase;
    const count = Number((await git(repoDir, ['-C', repoDir, 'rev-list', '--count', `${mergeBase}..${tip}`], 'count commits')).trim());
    if (!Number.isSafeInteger(count) || count < 1) throw new LandError(`The session has no commits that are not already on origin/${baseBranch}.`);
    if (count > DEVIN_LAND_MAX_COMMITS) throw new LandError(`The session carries ${count} commits; at most ${DEVIN_LAND_MAX_COMMITS} land at once.`);
    if ((await git(repoDir, ['-C', repoDir, 'rev-list', '--merges', `${mergeBase}..${tip}`], 'look for merge commits')).trim() !== '') {
      throw new LandError('The session commits include a merge commit; land a linear history.');
    }
    out.commitCount = count;
    out.commits = (await git(repoDir, ['-C', repoDir, 'log', '--reverse', '--format=%H%x09%s', `${mergeBase}..${tip}`], 'list commits'))
      .split('\n').filter(Boolean).map((line) => {
        const [sha, ...subject] = line.split('\t');
        return { sha: sha!, subject: oneLine(subject.join('\t'), 200) };
      });

    const plan = [
      `git worktree add -b ${branch} ~/Projects/${DEVIN_LAND_UPSTREAM_OWNER}/wt/${job} ${tip.slice(0, 12)}`,
      `git rebase --onto origin/${baseBranch} HEAD~${count}`,
      `write queue/run/${job}.line, ${job}.base, ${job}.body.md, ${job}.prompt and BRIDGE_NOTES.md`,
      `run ~/.ashlr-runs/bin/publish.sh ${job}`,
      'gh pr merge --auto --squash --match-head-commit <publish head SHA> (unless publish.sh withheld auto-merge)',
      `append to the Devin ledger (${DEVIN_LAND_LEDGER_FILE})`,
    ];
    if (!request.apply) {
      out.steps.push(...plan);
      out.ok = true;
      return out;
    }

    // Apply: worktree + rebase.
    await git(repoDir, ['-C', repoDir, 'worktree', 'add', '--quiet', '-b', branch, worktree, tip], 'git worktree add');
    out.steps.push(plan[0]!);
    const rebase = await run('git', ['-C', worktree, '-c', 'core.hooksPath=/dev/null', 'rebase', '--quiet', '--onto', baseSha, mergeBase], { cwd: worktree, env, timeoutMs: GIT_TIMEOUT_MS });
    if (rebase.code !== 0) {
      await run('git', ['-C', worktree, 'rebase', '--abort'], { cwd: worktree, env, timeoutMs: GIT_TIMEOUT_MS });
      await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktree], { cwd: repoDir, env, timeoutMs: GIT_TIMEOUT_MS });
      await run('git', ['-C', repoDir, 'branch', '-D', branch], { cwd: repoDir, env, timeoutMs: GIT_TIMEOUT_MS });
      throw new LandError(`The session commits do not rebase cleanly onto origin/${baseBranch}; the worktree was removed.`);
    }
    const rebasedCount = Number((await git(worktree, ['-C', worktree, 'rev-list', '--count', `${baseSha}..HEAD`], 'count rebased commits')).trim());
    const rebasedBase = (await git(worktree, ['-C', worktree, 'merge-base', baseSha, 'HEAD'], 'check the rebased base')).trim();
    if (rebasedCount !== count || rebasedBase !== baseSha) throw new LandError(`The rebase produced ${rebasedCount} commits on ${rebasedBase.slice(0, 12)}; expected ${count} on ${baseSha.slice(0, 12)}.`);
    out.steps.push(plan[1]!);

    // Job records, exactly the shapes publish.sh reads; never overwritten.
    mkdirSync(join(runs, 'queue', 'run'), { recursive: true, mode: 0o700 });
    const prompt = oneLine(`Land Devin session ${request.sessionId}: ${pr.title}`, 400);
    writeExclusive(lineFile, `${job}\t${repo}\t${DEVIN_LAND_LANE}\t${DEVIN_LAND_TIER}\t${prompt}\n`);
    writeExclusive(baseFile, `${baseSha} ${branch} ${worktree} ${DEVIN_LAND_LANE}\n`);
    writeExclusive(bodyFile, `${pr.body}\n`);
    // The done-contract a PUBLISH_JUDGE_CMD judge reads; dispatchd writes it for queued jobs.
    writeExclusive(join(runs, `${job}.prompt`), `${pr.title}\n\n${pr.body}\n`);
    // publish.sh rebuilds <J>.body.md and its commit subject from BRIDGE_NOTES.md (moved out before staging).
    writeExclusive(join(worktree, 'BRIDGE_NOTES.md'), `${pr.title}\n\n${pr.body}\n\nDevin session: ${session.url}\n`);
    out.steps.push(plan[2]!);

    const published = await run('/bin/bash', [publish, job], { cwd: worktree, env, timeoutMs: PUBLISH_TIMEOUT_MS });
    const log = existsSync(publishLog) ? readFileSync(publishLog, 'utf8') : `${published.stdout}\n${published.stderr}`;
    out.publish = parsePublishResult(log, repo);
    out.steps.push(plan[3]!);

    let autoMerge: DevinLandResult['autoMerge'];
    if (out.publish.pr) {
      const decision = autoMergeDecision(log, out.publish.sens);
      if (decision.arm) {
        if (!out.publish.headSha) {
          autoMerge = { armed: false, detail: 'arm-refused: publish result head SHA is unknown; left for the next guarded pass.', reasonCode: 'arm-refused' };
        } else {
          const merged = await run('gh', ['pr', 'merge', out.publish.pr, '--repo', `${DEVIN_LAND_UPSTREAM_OWNER}/${repo}`, '--auto', '--squash', '--match-head-commit', out.publish.headSha], { cwd: worktree, env, timeoutMs: 120_000 });
          autoMerge = merged.code === 0
            ? { armed: true, detail: 'gh pr merge --auto --squash --match-head-commit' }
            : { armed: false, detail: `gh pr merge failed: ${oneLine(merged.stderr || merged.stdout, 200) || `exit ${merged.code}`}` };
        }
      } else {
        autoMerge = { armed: decision.detail === 'already armed by publish.sh', detail: decision.detail };
      }
      out.autoMerge = autoMerge;
      out.steps.push(plan[4]!);
    }

    const at = now();
    const taskId = out.publish.pr ? recordTrackedTask(request.sessionId, repo, out.publish.pr, pr.title, at) : null;
    const ledgerPath = appendLedger({
      v: 1, kind: 'devin-land', at: at.toISOString(), sessionId: request.sessionId, repo: `${DEVIN_LAND_UPSTREAM_OWNER}/${repo}`, job, branch,
      base: baseSha, mergeBase, tip, commits: count, bundleSha256: out.bundle.sha256, result: out.publish.result, pr: out.publish.pr,
      autoMerge: autoMerge ?? null, taskId,
    });
    out.ledger = { path: ledgerPath, taskId };
    out.steps.push(plan[5]!);
    if (!out.publish.pr) throw new LandError(`publish.sh did not open a PR (${out.publish.result || 'no RESULT line'}).`);
    out.ok = true;
    return out;
  } catch (error) {
    out.error = error instanceof LandError || (error instanceof Error && error.name === 'DevinApiError') ? error.message : `Unexpected failure: ${error instanceof Error ? error.message : String(error)}`;
    return out;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
