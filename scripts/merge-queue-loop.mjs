#!/usr/bin/env node
// RQ-MERGEQ-BATCH-1 host adapter. Requires `npm run build` (imports dist).
//
//   node scripts/merge-queue-loop.mjs cycle [--dry-run] [--queue PATH]
//        [--hold-file PATH] [--state-file PATH] [--via-locus]
//     One enqueue/rebase/conflict pass over the seven approved repos
//     (src/core/drive/merge-queue-loop.ts). `gh` must already be authorized;
//     --via-locus runs it as `locus exec -- gh`. Conflicting same-repo
//     codex-bridge PRs are first recut automatically (dist core/fleet/
//     merge-recut.js): current default branch merged into the head, mechanical
//     conflicts resolved, one merge commit pushed back as a lease-protected
//     fast-forward; what is not provably mechanical still drains to the lane.
//     Prints the JSON summary.
//
//   node scripts/merge-queue-loop.mjs metrics --repo OWNER/NAME=CLONE_DIR ...
//        [--ref REF] [--day YYYY-MM-DD] [--out PATH]
//     Offline: counts merged PRs per UTC day from each local clone's
//     first-parent history (src/core/drive/merged-per-day.ts) and appends new
//     rows to the metrics JSONL. Default day: the latest one the ref proves
//     complete. No network; fetch the clones first if they are stale.
//
// Merge-queue batching (group size, build concurrency) is ruleset state and is
// out of scope here: any change goes to Security as a staged draft.
// Defaults live under ~/.ashlr-runs (queue/, metrics/).
// stderr carries only constant MERGEQ_* lines; provider output is never echoed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = [
  'node scripts/merge-queue-loop.mjs cycle [--dry-run] [--queue PATH] [--hold-file PATH] [--state-file PATH] [--via-locus]',
  'node scripts/merge-queue-loop.mjs metrics --repo OWNER/NAME=CLONE_DIR ... [--ref REF] [--day YYYY-MM-DD] [--out PATH]',
].join('\n');
const RUNS = join(homedir(), '.ashlr-runs');
const GH_TIMEOUT_MS = 90_000;
const REPO = /^ashlrai\/[a-z0-9][a-z0-9._-]{0,99}$/;

const SNAPSHOT_QUERY = `query($name: String!, $cursor: String) {
  repository(owner: "ashlrai", name: $name) {
    defaultBranchRef { name }
    mergeQueue { id }
    pullRequests(states: OPEN, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number headRefOid headRefName baseRefName isDraft author { login }
        headRepository { nameWithOwner }
        mergeable mergeStateStatus reviewDecision isInMergeQueue
        autoMergeRequest { enabledAt }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        files(first: 100) { totalCount nodes { path } }
      }
    }
  }
}`;
export const enqueueMergeQueuePr = (gh, repo, pr) => gh([
  'pr', 'merge', String(pr.number), '--repo', repo, '--auto', '--match-head-commit', pr.headSha,
]);
export const dequeueMergeQueuePr = (gh, _repo, pr) => {
  const payload = gh(['api', 'graphql', '-H', 'GraphQL-Features: merge_queue',
    '-f', 'query=mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { clientMutationId } }',
    '-f', `id=${pr.id}`]);
  if (payload?.errors || !payload?.data?.dequeuePullRequest) throw new Error('dequeue refused');
};
// MERGE method only: a base merge commit on top of the head, never a rewrite.
const UPDATE = `mutation($id: ID!, $oid: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $oid, updateMethod: MERGE }) { pullRequest { number } }
}`;

function parseFlags(args, spec) {
  const out = { _multi: {} };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const kind = spec[flag];
    if (kind === undefined) throw new Error('usage');
    if (kind === 'bool') { out[flag] = true; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('usage');
    i += 1;
    if (kind === 'multi') (out._multi[flag] ??= []).push(value);
    else out[flag] = value;
  }
  return out;
}

function pairs(values = []) {
  return values.map((value) => {
    const at = value.indexOf('=');
    const repo = value.slice(0, at);
    if (at < 1 || !REPO.test(repo)) throw new Error('usage');
    return [repo, resolve(value.slice(at + 1))];
  });
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readQueueIds(path) {
  const ids = new Set();
  if (!existsSync(path)) return ids;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('queue line is not JSON'); }
    if (typeof row?.id !== 'string' || !row.id) throw new Error('queue row has no id');
    ids.add(row.id);
  }
  return ids;
}

function readHoldList(path) {
  // Fail closed: an unreadable or malformed hold file stops the cycle.
  const hold = new Set();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const match = /^(?:ashlrai\/)?([a-z0-9][a-z0-9._-]{0,99})#(\d{1,10})$/i.exec(line);
    if (!match) throw new Error('invalid hold-list entry');
    hold.add(`${match[1]}#${Number(match[2])}`);
  }
  return hold;
}

function makeGh(viaLocus) {
  return (args) => {
    const [cmd, argv] = viaLocus ? ['locus', ['exec', '--', 'gh', ...args]] : ['gh', args];
    try {
      const output = execFileSync(cmd, argv, {
        encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' },
      });
      return args[0] === 'api' ? JSON.parse(output) : undefined;
    } catch {
      // Provider text may carry credentials; callers see a constant error only.
      throw new Error('gh failed');
    }
  };
}

const CHECKS = new Set(['SUCCESS', 'PENDING', 'EXPECTED', 'FAILURE', 'ERROR']);
const MERGEABLE = new Set(['MERGEABLE', 'CONFLICTING']);

export function readSnapshot(gh, repo, claims = []) {
  const name = repo.split('/')[1];
  const prs = [];
  let cursor = null;
  let defaultBranch = null;
  let mergeQueue = false;
  for (let page = 0; page < 40; page += 1) {
    const args = ['api', 'graphql', '-H', 'GraphQL-Features: merge_queue',
      '-f', `query=${SNAPSHOT_QUERY}`, '-f', `name=${name}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const payload = gh(args);
    const repository = payload?.data?.repository;
    const connection = repository?.pullRequests;
    if (payload?.errors || !connection || !Array.isArray(connection.nodes)) throw new Error('malformed');
    defaultBranch ??= String(repository.defaultBranchRef?.name ?? '');
    mergeQueue = mergeQueue || typeof repository.mergeQueue?.id === 'string';
    for (const node of connection.nodes) {
      const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
      const files = (node.files?.nodes ?? []).map((file) => String(file?.path ?? ''));
      prs.push({
        id: String(node.id ?? ''),
        number: Number(node.number),
        headSha: String(node.headRefOid ?? ''),
        headRef: String(node.headRefName ?? ''),
        headRepo: typeof node.headRepository?.nameWithOwner === 'string' && node.headRepository.nameWithOwner
          ? node.headRepository.nameWithOwner : null,
        baseRef: String(node.baseRefName ?? ''),
        isDraft: node.isDraft === true,
        author: String(node.author?.login ?? ''),
        mergeable: MERGEABLE.has(node.mergeable) ? node.mergeable : 'UNKNOWN',
        mergeState: String(node.mergeStateStatus ?? 'UNKNOWN'),
        checks: CHECKS.has(rollup) ? rollup : 'NONE',
        reviewDecision: typeof node.reviewDecision === 'string' ? node.reviewDecision : null,
        inMergeQueue: node.isInMergeQueue === true,
        autoMerge: Boolean(node.autoMergeRequest),
        activeOwner: claims.some(c => c.live && [`pr:${repo}#${node.number}`, `repo:${repo}`].includes(c.key.toLowerCase())),
        files,
        filesTruncated: Number(node.files?.totalCount ?? 0) > files.length,
      });
    }
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
      if (!defaultBranch) throw new Error('malformed');
      return { repo, defaultBranch, mergeQueue, prs };
    }
    cursor = connection.pageInfo.endCursor;
  }
  // A backlog past the page bound is reported as a read failure, never as a
  // silently partial snapshot.
  throw new Error('too many pages');
}

async function cycle(args) {
  const flags = parseFlags(args, {
    '--dry-run': 'bool', '--via-locus': 'bool', '--queue': 'value', '--hold-file': 'value', '--state-file': 'value',
  });
  const queue = resolve(flags['--queue'] ?? join(RUNS, 'queue', 'router-queue.md'));
  const holdFile = resolve(flags['--hold-file'] ?? join(RUNS, 'queue', 'hold-list.txt'));
  const stateFile = resolve(flags['--state-file'] ?? `${queue}.mergeq-state.json`);
  const { runMergeQueueCycle, normalizeMergeQueueState } = await import('../dist/core/drive/merge-queue-loop.js');
  const { claimBoard } = await import('../dist/core/agents/claim-store.js');
  const { makeMergeRecutResolver } = await import('../dist/core/fleet/merge-recut.js');
  const gh = makeGh(flags['--via-locus'] === true);
  const run = (query, pr) => gh(['api', 'graphql', '-H', 'GraphQL-Features: merge_queue',
    '-f', `query=${query}`, '-f', `id=${pr.id}`, '-f', `oid=${pr.headSha}`]);
  const ensureOk = (payload) => { if (payload?.errors) throw new Error('refused'); };
  const summary = runMergeQueueCycle({
    readSnapshot: (repo) => {
      const owners = claimBoard();
      if (owners.source === 'unavailable') throw new Error('owners unavailable');
      return readSnapshot(gh, repo, owners.claims);
    },
    enqueue: (repo, pr) => enqueueMergeQueuePr(gh, repo, pr),
    dequeue: (repo, pr) => dequeueMergeQueuePr(gh, repo, pr),
    updateBranch: (_repo, pr) => ensureOk(run(UPDATE, pr)),
    // Automatic recut for conflicting fleet PRs; dry runs never call it and a
    // 'transient' outcome (moved head/branch, provider failure) never drains.
    resolveConflict: makeMergeRecutResolver(makeRecutRunner()),
    readQueueIds: () => readQueueIds(queue),
    appendQueueLine: (line) => {
      mkdirSync(dirname(queue), { recursive: true, mode: 0o700 });
      appendFileSync(queue, line, { mode: 0o600 });
    },
    readHoldList: () => readHoldList(holdFile),
    loadState: () => (existsSync(stateFile)
      ? normalizeMergeQueueState(JSON.parse(readFileSync(stateFile, 'utf8'))) : undefined),
    saveState: (state) => atomicWrite(stateFile, `${JSON.stringify(state)}\n`),
    log: (line) => console.error(line),
    now: () => Date.now(),
  }, { dryRun: flags['--dry-run'] === true });
  console.log(JSON.stringify(summary));
  return summary.repoErrors > 0 || summary.failed > 0 ? 1 : 0;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', TZ: 'UTC' },
  });
}

// Synchronous MergeRecutRunner (src/core/fleet/merge-recut.ts) for the loop's
// conflict arm: one disposable object store + worktree per recut, bounded
// processes, no shell, and provider output is never echoed upward.
const READ_LIMIT_BYTES = 2 * 1024 * 1024;
export function makeRecutRunner() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', TZ: 'UTC' };
  return {
    git(args, opts = {}) {
      try {
        const stdout = execFileSync('git', [...args], {
          cwd: opts.cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'], env,
        });
        return { code: 0, stdout: stdout ?? '' };
      } catch (error) {
        // Provider text may carry credentials; the core module reasons on
        // constant strings only, so discard it here too.
        if (opts.allowFail && typeof error.status === 'number') return { code: error.status, stdout: '' };
        throw new Error('git failed');
      }
    },
    readFile(path) {
      if (statSync(path).size > READ_LIMIT_BYTES) throw new Error('oversized file');
      return readFileSync(path, 'utf8');
    },
    writeFile(path, text) { writeFileSync(path, text, { mode: 0o600 }); },
    mkdir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); },
    mkdtemp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); },
    rmrf(path) { rmSync(path, { recursive: true, force: true }); },
    run(cwd, argv) {
      try {
        execFileSync(argv[0], argv.slice(1), { cwd, timeout: 300_000, stdio: 'ignore', env });
        return true;
      } catch { return false; }
    },
  };
}

async function metrics(args) {
  const flags = parseFlags(args, { '--repo': 'multi', '--ref': 'value', '--day': 'value', '--out': 'value' });
  const repos = pairs(flags._multi['--repo']);
  if (repos.length === 0) throw new Error('usage');
  const ref = flags['--ref'] ?? 'refs/remotes/origin/HEAD';
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.startsWith('-')) throw new Error('usage');
  const out = resolve(flags['--out'] ?? join(RUNS, 'metrics', 'merged-per-day.jsonl'));
  const { measureMergedPerDay, latestCompleteDay, metricsAppend } = await import('../dist/core/drive/merged-per-day.js');
  const rows = [];
  const measuredAt = new Date().toISOString();
  for (const [repo, dir] of repos) {
    const commits = git(dir, ['log', '--first-parent', '--max-count=20000', '--format=%H%x09%cI%x09%s', `${ref}^{commit}`, '--'])
      .split('\n').filter(Boolean).map((line) => {
        const [sha, committedAt, ...subject] = line.split('\t');
        return { sha, committedAt, subject: subject.join('\t') };
      });
    if (commits.length === 0) throw new Error('empty ref');
    const day = flags['--day'] ?? latestCompleteDay(commits[0].committedAt);
    rows.push(measureMergedPerDay({ repo, ref, day, commits, measuredAt }));
  }
  const lines = metricsAppend(existsSync(out) ? readFileSync(out, 'utf8') : '', rows);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  for (const line of lines) appendFileSync(out, line, { mode: 0o600 });
  console.log(JSON.stringify({ out, appended: lines.length, rows }));
  return rows.every((row) => row.verified) ? 0 : 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h' || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command === 'cycle') return await cycle(args);
    if (command === 'metrics') return await metrics(args);
  } catch (error) {
    if (error?.message === 'usage') { console.error(`usage:\n${USAGE}`); return 2; }
    throw error;
  }
  console.error(`usage:\n${USAGE}`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch(() => {
    console.error('MERGEQ_ERROR');
    process.exit(1);
  });
}
