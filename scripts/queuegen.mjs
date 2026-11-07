#!/usr/bin/env node
// RQ-MR-GEN-SHAPE-V2 — dispatchd step. The dispatchd loop invokes this every
// cycle (after Security pins the exact script sha; never install or run it
// against live PRs before then):
//
//   phantom exec -- node scripts/queuegen.mjs \
//     [--queue PATH] [--hold-file PATH] [--state-file PATH] [--mirrors-root PATH] [--dry-run]
//
// Requires `npm run build` (imports dist). `gh` must be on PATH and already
// authorized. Defaults live under ~/.ashlr-runs/queue/ and ~/.ashlr/fleet/mirrors:
//   queue        ~/.ashlr-runs/queue/router-queue.md   (- READY <ID> (attrs): text rows)
//   hold-file    ~/.ashlr-runs/queue/hold-list.txt     ("<repo>#<pr>" per line,
//                                                       optional ashlrai/ prefix,
//                                                       "#" comments allowed)
//   state-file   <queue>.queuegen-state.json
//   mirrors-root ~/.ashlr/fleet/mirrors                (<owner>__<repo> mirrors)
// Unreadable hold file, malformed queue line, or any gh error stops the cycle
// with exit 1 and no retry. stderr carries only QUEUEGEN_* journal lines.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'node scripts/queuegen.mjs [--queue PATH] [--hold-file PATH] [--state-file PATH] [--mirrors-root PATH] [--dry-run]';
const GH_TIMEOUT_MS = 90_000;
const GIT_TIMEOUT_MS = 60_000;
const PR_LIMIT = 100;
const LOG_TAIL_CHARS = 8_000;

const PR_QUERY = `query($name: String!, $cursor: String) {
  repository(owner: "ashlrai", name: $name) {
    pullRequests(states: OPEN, first: ${PR_LIMIT}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        headRefName
        headRefOid
        baseRefName
        baseRefOid
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
  // (constant QUEUEGEN_* journal lines are the only failure signal needed).
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
        headRef: String(node.headRefName ?? ''),
        headSha: String(node.headRefOid ?? ''),
        baseSha: String(node.baseRefOid ?? ''),
        baseRef: String(node.baseRefName ?? ''),
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

/** Every check run on the PR head, flagged required from branch protection. */
function checks(repo, pr) {
  const raw = JSON.parse(gh(['api', `repos/${repo}/commits/${pr.headSha}/check-runs?filter=all&per_page=100`]));
  const runs = Array.isArray(raw?.check_runs) ? raw.check_runs : [];
  let required = [];
  try {
    const protection = JSON.parse(gh(['api', `repos/${repo}/branches/${encodeURIComponent(pr.baseRef || 'main')}/protection`]));
    const rsc = protection?.required_status_checks;
    required = rsc?.contexts ?? (Array.isArray(rsc?.checks) ? rsc.checks.map((c) => c?.context) : []) ?? [];
  } catch { /* an unprotected base means no required contexts */ }
  const requiredNames = new Set((Array.isArray(required) ? required : []).map(String));
  const latest = new Map();
  for (const run of runs) {
    const name = String(run?.name ?? '');
    const current = latest.get(name);
    if (!current || Number(run?.id) > Number(current.id)) latest.set(name, run);
  }
  const out = [];
  for (const run of latest.values()) {
    const name = String(run?.name ?? '');
    const appSlug = String(run?.app?.slug ?? '');
    out.push({
      id: Number(run?.id ?? 0),
      name,
      status: String(run?.status ?? ''),
      conclusion: typeof run?.conclusion === 'string' ? run.conclusion.toLowerCase() : null,
      required: requiredNames.has(name) || (appSlug !== '' && requiredNames.has(`${appSlug}/${name}`)),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

let scrub = (text) => text;
try {
  const mod = await import('../dist/core/util/scrub-secrets.js');
  if (typeof mod.scrubSecrets === 'function') scrub = mod.scrubSecrets;
} catch { /* a missing build is fatal for runQueuegenCycle's import anyway */ }

function checkLogTail(repo, pr, check) {
  // A non-Actions check (or expired logs) 404s the job endpoint; the FIXUP
  // line still ships with the check name instead of dropping the PR.
  try {
    const text = gh(['api', `repos/${repo}/actions/jobs/${check.id}/logs`]);
    return scrub(String(text).slice(-LOG_TAIL_CHARS * 2)).slice(-LOG_TAIL_CHARS);
  } catch {
    return '';
  }
}

function mirrorFor(root, repo) {
  const owner = repo.split('/')[0] ?? '';
  const candidates = [join(root, `${owner}__${shortName(repo)}`), join(root, shortName(repo))];
  for (const path of candidates) if (existsSync(join(path, '.git'))) return path;
  throw new Error(`no mirror for ${repo}`);
}

/** Conflicted paths, [] when clean. git merge-tree: 0 clean, 1 conflicts, >1 error. */
function conflictFiles(mirrorsRoot, repo, pr) {
  const mirror = mirrorFor(mirrorsRoot, repo);
  try {
    execFileSync('git', ['-C', mirror, 'merge-tree', '--write-tree', '--name-only', pr.baseSha, pr.headSha], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return [];
  } catch (error) {
    if (error?.status === 1 && typeof error.stdout === 'string') {
      return error.stdout.split('\n').slice(1).map((line) => line.trim()).filter(Boolean).slice(0, 200);
    }
    throw new Error(`git merge-tree failed for ${repo}#${pr.number}`);
  }
}

const MD_ID = /^- [A-Z][A-Z-]* ([A-Za-z0-9][A-Za-z0-9._-]+)\b/;

function readQueueIds(queuePath) {
  const ids = new Set();
  if (!existsSync(queuePath)) return ids;
  const text = readFileSync(queuePath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('{')) {
      let row;
      try { row = JSON.parse(line); } catch { throw new Error('queue line is not JSON'); }
      if (typeof row?.id !== 'string' || !row.id) throw new Error('queue row has no id');
      if (ids.has(row.id)) throw new Error('duplicate queue id');
      ids.add(row.id);
      continue;
    }
    const match = MD_ID.exec(line);
    if (match) {
      if (ids.has(match[1])) throw new Error('duplicate queue id');
      ids.add(match[1]);
    }
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
  const queueRoot = join(homedir(), '.ashlr-runs', 'queue');
  const flags = {
    '--queue': join(queueRoot, 'router-queue.md'),
    '--hold-file': join(queueRoot, 'hold-list.txt'),
    '--state-file': '',
    '--mirrors-root': join(homedir(), '.ashlr', 'fleet', 'mirrors'),
  };
  const dryRun = process.argv.includes('--dry-run');
  const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
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
  flags['--state-file'] = resolve(flags['--state-file'] || `${flags['--queue']}.queuegen-state.json`);
  flags['--mirrors-root'] = resolve(flags['--mirrors-root']);

  const { runQueuegenCycle, normalizeState } =
    await import('../dist/core/drive/queuegen.js');

  mkdirSync(dirname(flags['--queue']), { recursive: true, mode: 0o700 });
  const io = {
    listPullRequests,
    checks,
    checkLogTail,
    conflictFiles: (repo, pr) => conflictFiles(flags['--mirrors-root'], repo, pr),
    readQueueIds: () => readQueueIds(flags['--queue']),
    appendQueueLine: (line) => {
      if (dryRun) { console.log(`DRY ${line}`); return; }
      appendFileSync(flags['--queue'], `${line}\n`, { mode: 0o600 });
    },
    readHoldList: () => readHoldList(flags['--hold-file']),
    loadState: () => {
      if (!existsSync(flags['--state-file'])) return undefined;
      return normalizeState(JSON.parse(readFileSync(flags['--state-file'], 'utf8')));
    },
    saveState: (state) => { if (!dryRun) atomicWrite(flags['--state-file'], `${JSON.stringify(state)}\n`); },
    log: (line) => console.error(line),
    now: () => Date.now(),
  };
  runQueuegenCycle(io);
  return 0;
}

// Only run when executed directly (the dispatchd step), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch(() => {
    console.error('QUEUEGEN_ERROR');
    process.exit(1);
  });
}
