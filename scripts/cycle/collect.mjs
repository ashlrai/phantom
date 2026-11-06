#!/usr/bin/env node
// Metadata-only cycle backfill. The collector never reads the PostHog key.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

export const REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin'];
const QUEUED = new Set(['phantom', 'ashlr-md']);
const OWNER = 'masonwyatt23';
const PAGE = 'pageInfo { hasNextPage endCursor }';
const PR_QUERY = `query($repo:String!,$after:String) { repository(owner:"ashlrai",name:$repo) {
  pullRequests(first:100,after:$after,states:MERGED,orderBy:{field:CREATED_AT,direction:DESC}) {
    nodes { number createdAt mergedAt updatedAt headRefOid } ${PAGE}
  }
} }`;
const TIMELINE_QUERY = `query($repo:String!,$pr:Int!,$after:String) { repository(owner:"ashlrai",name:$repo) {
  pullRequest(number:$pr) { timelineItems(first:100,after:$after,itemTypes:[READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,PULL_REQUEST_REVIEW,ISSUE_COMMENT,ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT]) {
    nodes { __typename
      ... on ReadyForReviewEvent { createdAt }
      ... on ConvertToDraftEvent { createdAt }
      ... on PullRequestReview { submittedAt state author { login } authorAssociation }
      ... on IssueComment { createdAt updatedAt body author { login } authorAssociation }
      ... on AddedToMergeQueueEvent { createdAt }
      ... on RemovedFromMergeQueueEvent { createdAt }
      ... on AutoMergeEnabledEvent { createdAt }
      ... on AutoMergeDisabledEvent { createdAt }
    } ${PAGE}
  } }
} }`;
const SUITES_QUERY = `query($repo:String!,$sha:GitObjectID!,$after:String) { repository(owner:"ashlrai",name:$repo) {
  object(oid:$sha) { ... on Commit { checkSuites(first:100,after:$after) {
    nodes { id createdAt status conclusion app { slug } workflowRun { workflow { id } } } ${PAGE}
  } } }
} }`;
const RUNS_QUERY = `query($id:ID!,$pr:Int!,$after:String) { node(id:$id) { ... on CheckSuite {
  checkRuns(first:100,after:$after,filterBy:{checkType:ALL}) { nodes { name startedAt completedAt status conclusion isRequired(pullRequestNumber:$pr) } ${PAGE} }
} } }`;

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const nodes = connection => Array.isArray(connection) ? connection : connection?.nodes ?? [];
const seconds = (start, end) => Math.floor((end - start) / 1000);
const eventTime = item => time(item.submittedAt ?? (item.__typename === 'IssueComment' ? item.updatedAt ?? item.createdAt : item.createdAt));

export function insertId({ repo, pr, job_id, sha, stage, attempt }) {
  return createHash('sha256').update([repo, pr, job_id, sha, stage, attempt].join('|')).digest('hex').slice(0, 32);
}

const FIELDS = ['schema', 'job_id', 'pool', 'repo', 'pr', 'sha', 'source', 'attempt', 'stage', 'ts_start', 'ts_end', 'duration_s', '$insert_id'];
const STAGES = ['rework', 'ci_pr', 'review', 'green_to_enqueue', 'merge_group', 'green_to_merged'];

export function validateEvent(event) {
  const p = event?.properties;
  if (!p || Object.keys(event).sort().join() !== ['event', 'distinct_id', 'timestamp', 'properties'].sort().join()
    || Object.keys(p).sort().join() !== [...FIELDS].sort().join()
    || event.event !== 'cycle_stage' || p.schema !== 'cycle_stage.v1' || !REPOS.includes(p.repo)
    || !Number.isInteger(p.pr) || p.pr < 1 || p.job_id !== `pr-${p.repo}-${p.pr}` || p.pool !== 'none'
    || !/^[a-f0-9]{40}$/.test(p.sha) || p.source !== 'backfill' || p.attempt !== 1 || !STAGES.includes(p.stage)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.ts_start)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.ts_end)
    || !Number.isInteger(p.duration_s) || p.duration_s < 0
    || p.duration_s !== Math.floor((Date.parse(p.ts_end) - Date.parse(p.ts_start)) / 1000)
    || event.distinct_id !== `cycle:${p.repo}:${p.pr}` || event.timestamp !== p.ts_end
    || p.$insert_id !== insertId(p)) throw new Error('Invalid cycle event');
  return event;
}


/** Only named schema fields cross this boundary: no PR titles, comments or paths. */
export function stagesForPr(repo, pr) {
  if (!REPOS.includes(repo) || !Number.isInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/i.test(pr.headRefOid ?? '')) throw new Error('Invalid PR identity');
  const opened = time(pr.createdAt);
  const merged = time(pr.mergedAt);
  if (opened === null || merged === null || merged < opened) throw new Error('Invalid PR timestamps');
  const events = [];
  const base = { schema: 'cycle_stage.v1', job_id: `pr-${repo}-${pr.number}`, pool: 'none', repo, pr: pr.number, sha: pr.headRefOid.toLowerCase(), source: 'backfill', attempt: 1 };
  const add = (stage, start, end) => {
    // Unknown or inverted boundaries are missing evidence, never zero-duration samples.
    if (start === null || end === null || start < opened || end < start || end > merged) return;
    const properties = { ...base, stage, ts_start: new Date(start).toISOString(), ts_end: new Date(end).toISOString(), duration_s: seconds(start, end) };
    properties.$insert_id = insertId(properties);
    events.push({ event: 'cycle_stage', distinct_id: `cycle:${repo}:${pr.number}`, timestamp: properties.ts_end, properties });
  };
  const timeline = nodes(pr.timelineItems).filter(item => {
    const at = eventTime(item);
    return at !== null && at >= opened && at <= merged;
  }).sort((a, b) => eventTime(a) - eventTime(b));
  const readyEvents = timeline.filter(item => item.__typename === 'ReadyForReviewEvent');
  const ready = readyEvents.length ? time(readyEvents.at(-1).createdAt) : opened;
  const review = timeline.find(item => {
    if (eventTime(item) < ready) return false;
    const login = item.author?.login?.toLowerCase();
    const owner = login === OWNER || item.authorAssociation === 'OWNER';
    if (item.__typename === 'PullRequestReview') return (owner && ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(item.state))
      || (['coderabbitai', 'coderabbitai[bot]'].includes(login) && item.state === 'APPROVED');
    if (item.__typename !== 'IssueComment') return false;
    const body = item.body ?? '';
    const qualified = line => !/\b(not|don't|do not|except|but|pending|changes requested)\b/i.test(line);
    if (owner) return qualified(body) && /\b(lgtm|approved|looks good|ship it)\b/i.test(body);
    // CodeRabbit's footer includes instructions/negations unrelated to the
    // result. Parse explicit status lines rather than classifying that prose.
    return ['coderabbitai', 'coderabbitai[bot]'].includes(login) && body.split('\n').some(line => {
      const status = line.replace(/[*_`]/g, '').replace(/^[\s>#]+/, '');
      return qualified(status) && /^(?:✅\s*)?(?:no (?:actionable |additional )?(?:comments|issues|concerns)\b|lgtm\b|review passed\b|actionable comments posted:\s*0\b)/i.test(status);
    });
  });
  const reviewed = review ? eventTime(review) : null;
  const suites = nodes(pr.checkSuites).filter(suite => suite.app?.slug === 'github-actions' && time(suite.createdAt) !== null && time(suite.createdAt) <= merged);
  const ciStart = suites.length ? Math.min(...suites.map(suite => time(suite.createdAt))) : null;
  const latest = new Map();
  for (const suite of suites) for (const run of nodes(suite.checkRuns)) {
    const key = `${suite.workflowRun?.workflow?.id ?? ''}|${run.name}`;
    const at = time(run.startedAt) ?? time(suite.createdAt);
    // A rerun after merge must not replace the checks that gated the merge.
    if (at > merged) continue;
    if (!latest.has(key) || latest.get(key).at <= at) latest.set(key, { at, run });
  }
  const runs = [...latest.values()].map(value => value.run);
  const required = runs.filter(run => run.isRequired);
  // Snapshots without required-check markers use the all-Actions envelope
  // described in the baseline spec. Exact baseline.py parity needs its fixture.
  const selected = required.length ? required : runs;
  const complete = selected.length && selected.every(run => run.status === 'COMPLETED' && time(run.completedAt) !== null && time(run.completedAt) <= merged);
  const ciEnd = complete ? Math.max(...selected.map(run => time(run.completedAt))) : null;
  add('rework', opened, ciStart);
  add('ci_pr', ciStart, ciEnd);
  add('review', ready, reviewed);
  // A missing review is not proof that review happened at CI completion.
  const passed = selected.length && selected.every(run => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(run.conclusion));
  const green = ciEnd !== null && reviewed !== null && passed ? Math.max(ciEnd, reviewed) : null;
  if (!QUEUED.has(repo)) {
    add('green_to_merged', green, merged);
  } else {
    let queued = null;
    let auto = null;
    for (const item of timeline) {
      if (item.__typename === 'AddedToMergeQueueEvent') queued = time(item.createdAt);
      if (item.__typename === 'RemovedFromMergeQueueEvent') queued = null;
      if (item.__typename === 'AutoMergeEnabledEvent') auto = time(item.createdAt);
      if (item.__typename === 'AutoMergeDisabledEvent') auto = null;
    }
    add('green_to_enqueue', green, queued ?? auto);
    // Auto-merge enablement alone does not establish a merge-queue entry.
    add('merge_group', queued, merged);
  }
  return events;
}

/** gh stderr can contain headers or user content; errors expose no subprocess output. */
export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) throw new Error(`${command === 'gh' ? 'GitHub query' : 'Telemetry sender'} failed`);
  return result.stdout;
}

export function githubClient(run = runCommand) {
  return (query, variables) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    // -F interprets @file values. Use raw string fields for API cursors/SHA so
    // metadata can never cause gh to upload a local file.
    for (const [key, value] of Object.entries(variables)) if (value !== null) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    let result;
    try { result = JSON.parse(run('gh', args)); } catch { throw new Error('GitHub query failed'); }
    if (result.errors?.length || !result.data) throw new Error('GitHub returned incomplete data');
    return result.data;
  };
}

export function pages(fetchPage, stop = () => false) {
  const all = [];
  const seen = new Set();
  let after = null;
  while (true) {
    const connection = fetchPage(after);
    if (!connection || !Array.isArray(connection.nodes) || connection.nodes.some(node => !node) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete GitHub connection');
    all.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage || stop(connection.nodes)) return all;
    after = connection.pageInfo.endCursor;
    if (!after || seen.has(after)) throw new Error('Invalid GitHub pagination');
    seen.add(after);
  }
}

export function collectRepo(repo, since, query = githubClient(), pending = []) {
  // Comments can move UPDATED_AT-ordered nodes across a pagination cursor.
  // Creation order is stable; enumerate every summary because old PRs can merge
  // recently. A fixed upper merge boundary defers mid-scan merges to the next
  // pass so their insertion cannot advance this scan's watermark past a gap.
  const before = Date.now();
  const prs = pages(after => query(PR_QUERY, { repo, after }).repository?.pullRequests);
  const summaries = prs.filter(pr => {
    if (time(pr.mergedAt) === null) throw new Error('Invalid merge timestamp');
    return time(pr.mergedAt) >= time(since) && time(pr.mergedAt) <= before;
  });
  // Revisit incomplete observations even when a newer merge moved the cursor.
  const byNumber = new Map(pending.map(pr => [pr.number, pr]));
  for (const pr of summaries) byNumber.set(pr.number, pr);
  return [...byNumber.values()].map(pr => {
    stagesForPr(repo, pr); // Validate identities before using persisted rows in queries.
    const timeline = pages(after => query(TIMELINE_QUERY, { repo, pr: pr.number, after }).repository?.pullRequest?.timelineItems);
    const suites = pages(after => query(SUITES_QUERY, { repo, sha: pr.headRefOid, after }).repository?.object?.checkSuites);
    for (const suite of suites) {
      if (suite.app?.slug === 'github-actions') suite.checkRuns = { nodes: pages(after => query(RUNS_QUERY, { id: suite.id, pr: pr.number, after }).node?.checkRuns) };
    }
    return { ...pr, timelineItems: { nodes: timeline }, checkSuites: { nodes: suites } };
  });
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('Invalid cycle state');
  }
}

function saveCursor(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

function acquireLock(path) {
  if (existsSync(path)) {
    const previous = readJson(path, null);
    if (!Number.isInteger(previous?.pid) || previous.pid < 1) throw new Error('Invalid collector lock; inspect before removing');
    // Fail closed even for a dead PID: automatically unlinking a stale lock
    // races another collector that may have just recovered it.
    throw new Error('Collector lock exists; verify its owner before removing it');
  }
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch { throw new Error('Collector already running (cursor lock exists)'); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  return fd;
}

export function parseArgs(args) {
  const root = resolve(homedir(), '.ashlr', 'cycle');
  const options = { send: false, repos: REPOS, since: '1970-01-01T00:00:00Z', cursor: resolve(root, 'cursor.json'), spool: resolve(root, 'spool.jsonl') };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--send') options.send = true;
    else if (arg === '--dry-run') options.send = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--repo', '--since', '--cursor', '--spool', '--fixture'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      if (arg === '--repo') options.repos = value.split(',').map(repo => repo.replace(/^ashlrai\//, ''));
      else options[arg.slice(2)] = value;
    } else throw new Error('Invalid collector arguments (see --help)');
  }
  if (!options.repos.length || options.repos.some(repo => !REPOS.includes(repo)) || time(options.since) === null || resolve(options.cursor) === resolve(options.spool)) throw new Error('Invalid collector options');
  return options;
}

/** Disk spool is the durable outbox; cursor.sent tracks actual acknowledgments. */
export function collect(options, { query, run = runCommand } = {}) {
  const { cursor, spool } = options;
  mkdirSync(dirname(resolve(cursor)), { recursive: true });
  mkdirSync(dirname(resolve(spool)), { recursive: true });
  const lock = `${cursor}.lock`;
  const lockFd = acquireLock(lock);
  try {
    const state = readJson(cursor, { schema: 'cycle_cursor.v1', repos: {}, sent: [] });
    if (state?.schema !== 'cycle_cursor.v1' || !state.repos || typeof state.repos !== 'object' || Array.isArray(state.repos)
      || !Array.isArray(state.sent) || state.sent.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
      || Object.entries(state.repos).some(([repo, at]) => !REPOS.includes(repo) || time(at) === null)) throw new Error('Invalid cycle cursor');
    state.pending ??= {};
    if (typeof state.pending !== 'object' || state.pending === null || Array.isArray(state.pending)) throw new Error('Invalid cycle cursor');
    for (const [repo, prs] of Object.entries(state.pending)) {
      if (!REPOS.includes(repo) || !Array.isArray(prs)) throw new Error('Invalid pending PRs');
      for (const pr of prs) stagesForPr(repo, pr);
    }
    // A watermark without its outbox could otherwise silently lose unsent IDs.
    if (existsSync(cursor) && !existsSync(spool)) throw new Error('Cycle spool missing for existing cursor');
    const text = existsSync(spool) ? readFileSync(spool, 'utf8') : '';
    // Refuse partial writes instead of silently discarding unsent telemetry.
    if (text && !text.endsWith('\n')) throw new Error('Incomplete cycle spool');
    let outbox;
    try { outbox = text.split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { throw new Error('Invalid cycle spool'); }
    outbox.forEach(validateEvent);
    const known = new Set([...outbox.map(event => event.properties.$insert_id), ...state.sent]);
    const fixture = options.fixture ? readJson(options.fixture, null) : null;
    if (options.fixture && (!fixture?.repositories || typeof fixture.repositories !== 'object' || Array.isArray(fixture.repositories))) throw new Error('Invalid cycle fixture');
    const fresh = [];
    for (const repo of options.repos) {
      const since = time(options.since) > (time(state.repos[repo]) ?? -1) ? options.since : state.repos[repo];
      const pending = state.pending[repo] ?? [];
      if (!Array.isArray(pending)) throw new Error('Invalid pending PRs');
      const retry = new Set(pending.map(pr => pr.number));
      const prs = fixture ? fixture.repositories?.[repo] : collectRepo(repo, since, query, pending);
      if (!Array.isArray(prs)) throw new Error('Fixture is missing repository');
      let last = state.repos[repo];
      const unresolved = [];
      for (const pr of prs) {
        const events = stagesForPr(repo, pr);
        if (time(pr.mergedAt) < time(since) && !retry.has(pr.number)) continue;
        const observed = new Set(events.map(event => event.properties.stage));
        const expected = ['rework', 'ci_pr', 'review', ...(QUEUED.has(repo) ? ['green_to_enqueue', 'merge_group'] : ['green_to_merged'])];
        if (expected.some(stage => !observed.has(stage))) unresolved.push({ number: pr.number, createdAt: pr.createdAt, mergedAt: pr.mergedAt, updatedAt: pr.updatedAt, headRefOid: pr.headRefOid });
        for (const event of events) if (!known.has(event.properties.$insert_id)) {
          known.add(event.properties.$insert_id);
          fresh.push(event);
        }
        if (!last || time(pr.mergedAt) > time(last)) last = new Date(time(pr.mergedAt)).toISOString();
      }
      state.pending[repo] = unresolved;
      if (last) state.repos[repo] = last;
    }
    if (fresh.length) {
      appendFileSync(spool, fresh.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
      const fd = openSync(spool, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } else if (!existsSync(spool)) {
      writeFileSync(spool, '', { mode: 0o600 });
    }
    outbox.push(...fresh);
    saveCursor(cursor, state);
    const sent = new Set(state.sent);
    let delivered = 0;
    if (options.send) for (const event of outbox) {
      const id = event.properties.$insert_id;
      if (sent.has(id)) continue;
      let receipt;
      try {
        const output = run('phantom', ['exec', '--', 'node', fileURLToPath(new URL('./capture.mjs', import.meta.url))], { input: JSON.stringify(event), stdio: ['pipe', 'pipe', 'pipe'] });
        const line = output.split('\n').find(line => line.startsWith('CYCLE_RECEIPT '));
        receipt = JSON.parse(line?.slice('CYCLE_RECEIPT '.length) ?? 'null');
      } catch { throw new Error('Telemetry sender failed; events remain spooled'); }
      if (receipt?.sent !== true || receipt.insert_id !== id) break;
      sent.add(id);
      state.sent = [...sent];
      saveCursor(cursor, state);
      delivered++;
    }
    return { mode: options.send ? 'send' : 'dry-run', emitted: fresh.length, sent: delivered, pending: outbox.filter(event => !sent.has(event.properties.$insert_id)).length };
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/cycle/collect.mjs [--dry-run|--send] [--repo name,...] [--since ISO] [--cursor file] [--spool file] [--fixture file]\nDefault: dry-run, all seven repos. --send drains the spool via phantom exec.');
    else console.log(JSON.stringify(collect(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
