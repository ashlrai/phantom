#!/usr/bin/env node
// RQ-MR-REFIX-LOOP — dispatchd step. The dispatchd loop invokes this every
// 15 minutes (after Security pins the exact script sha; never install or run
// it against live PRs before then):
//
//   phantom exec -- node scripts/refix-loop.mjs \
//     [--queue PATH] [--hold-file PATH] [--state-file PATH]
//
// Requires `npm run build` (imports dist). `gh` must be on PATH and already
// authorized. Defaults live under ~/.ashlr-runs/queue/:
//   queue       ~/.ashlr-runs/queue/router-queue.md   (RQ JSONL rows)
//   hold-file   ~/.ashlr-runs/queue/hold-list.txt     ("<repo>#<pr>" per line,
//                                                     optional ashlrai/ prefix,
//                                                     "#" comments allowed)
//   state-file  <queue>.refix-state.json
// Unreadable hold file, malformed queue line, or any gh error stops the cycle
// with exit 1 and no retry. stderr carries only REFIX_* journal lines.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'node scripts/refix-loop.mjs [--queue PATH] [--hold-file PATH] [--state-file PATH]';
const GH_TIMEOUT_MS = 90_000;
const PR_LIMIT = 100;

const PR_QUERY = `query($name: String!, $cursor: String) {
  repository(owner: "ashlrai", name: $name) {
    pullRequests(states: OPEN, first: ${PR_LIMIT}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        headRefOid
        mergeStateStatus
        isInMergeQueue
        author { login }
        files(first: 100) { totalCount nodes { path } }
      }
    }
  }
}`;

function gh(args) {
  // gh never prompts here; output is parsed JSON only and stderr stays closed
  // (constant REFIX_GH_ERROR lines are the only failure signal the loop needs).
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' },
    });
  } catch {
    throw new Error(`gh failed: ${args[0]} ${args[1] ?? ''}`);
  }
}

function shortName(repo) {
  return repo.split('/').pop() ?? repo;
}

function listPullRequests(repo) {
  const prs = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const args = ['api', 'graphql', '-H', 'Graphql-Features: merge_queue',
      '-f', `query=${PR_QUERY}`, '-f', `name=${shortName(repo)}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const payload = JSON.parse(gh(args));
    const connection = payload?.data?.repository?.pullRequests;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error('gh failed: malformed response');
    for (const node of connection.nodes) {
      prs.push({
        number: node.number,
        headSha: String(node.headRefOid ?? ''),
        mergeState: String(node.mergeStateStatus ?? 'UNKNOWN'),
        inMergeQueue: node.isInMergeQueue === true,
        author: node.author?.login ?? '',
        files: (node.files?.nodes ?? []).map((file) => String(file.path ?? '')),
        filesTruncated: Number(node.files?.totalCount ?? 0) > (node.files?.nodes ?? []).length,
      });
    }
    if (!connection.pageInfo?.hasNextPage) return prs;
    cursor = connection.pageInfo.endCursor;
    if (!cursor) return prs;
  }
  return prs;
}

function readQueueIds(queuePath) {
  const ids = new Set();
  if (!existsSync(queuePath)) return ids;
  const text = readFileSync(queuePath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('queue line is not JSON'); }
    if (typeof row?.id !== 'string' || !row.id) throw new Error('queue row has no id');
    if (ids.has(row.id)) throw new Error('duplicate queue id');
    ids.add(row.id);
  }
  return ids;
}

function readHoldList(path) {
  // Fail closed: an unreadable or malformed hold file must stop the cycle
  // before any PR is touched, never silently unhold work.
  const text = readFileSync(path, 'utf8');
  const hold = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const match = /^(?:ashlrai\/)?([a-z0-9][a-z0-9._-]{0,99})#(\d{1,10})$/i.exec(line);
    if (!match) throw new Error('invalid hold-list entry');
    hold.add(`${match[1]}#${Number(match[2])}`);
  }
  return hold;
}

function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

async function main() {
  const root = join(homedir(), '.ashlr-runs', 'queue');
  const flags = { '--queue': join(root, 'router-queue.md'), '--hold-file': join(root, 'hold-list.txt'), '--state-file': '' };
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!(flag in flags) || !args[i + 1] || args[i + 1].startsWith('--')) {
      console.error(`usage: ${USAGE}`);
      return 2;
    }
    flags[flag] = resolve(args[i + 1]);
  }
  flags['--queue'] = resolve(flags['--queue']);
  flags['--hold-file'] = resolve(flags['--hold-file']);
  flags['--state-file'] = resolve(flags['--state-file'] || `${flags['--queue']}.refix-state.json`);

  const { runRefixCycle, normalizeState } =
    await import('../dist/core/drive/refix-loop.js');

  mkdirSync(dirname(flags['--queue']), { recursive: true, mode: 0o700 });
  const io = {
    listPullRequests,
    updateBranch: (repo, pr) => { gh(['pr', 'update-branch', String(pr), '--repo', repo]); },
    requiredCheckRed: (repo, pr) => {
      const checks = JSON.parse(gh(['pr', 'checks', String(pr), '--repo', repo, '--required', '--json', 'name,state,bucket']) || '[]');
      return Array.isArray(checks) && checks.some((check) => ['fail', 'cancel'].includes(check?.bucket));
    },
    readQueueIds: () => readQueueIds(flags['--queue']),
    appendQueueLine: (line) => appendFileSync(flags['--queue'], line, { mode: 0o600 }),
    readHoldList: () => readHoldList(flags['--hold-file']),
    loadState: () => {
      if (!existsSync(flags['--state-file'])) return undefined;
      return normalizeState(JSON.parse(readFileSync(flags['--state-file'], 'utf8')));
    },
    saveState: (state) => atomicWrite(flags['--state-file'], `${JSON.stringify(state)}\n`),
    log: (line) => console.error(line),
    now: () => Date.now(),
  };
  runRefixCycle(io);
  return 0;
}

// Only run when executed directly (the dispatchd step), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch(() => {
    console.error('REFIX_ERROR');
    process.exit(1);
  });
}
