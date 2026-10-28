#!/usr/bin/env node
/** Read-only GitHub backfill. Events contain identifiers and timestamps only. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, appendFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOS = ['phantom', 'ashlr-md', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack'].map(name => `ashlrai/${name}`);
const QUEUED_REPOS = new Set(['ashlrai/phantom', 'ashlrai/ashlr-md']);
const terminal = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const min = values => values.filter(Boolean).sort()[0] ?? null;
const max = values => values.filter(Boolean).sort().at(-1) ?? null;

/** A normalized PR is assembled from paginated gh GraphQL responses. */
export function eventsForPr(repo, pr, { ownerReviewer = 'masonwyatt23', queued = QUEUED_REPOS.has(repo) } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr.number) || pr.number < 1 || !/^[a-f\d]{40}$/i.test(pr.headRefOid)) throw new Error('Invalid PR identity');
  const opened = iso(pr.createdAt);
  const merged = iso(pr.mergedAt);
  if (!opened || !merged || merged < opened) throw new Error('Invalid PR boundaries');
  // Router metadata is accepted only as identifiers, never copied from titles/bodies.
  const job = pr.headRefName?.match(/(?:^|\/)(RQ-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?:\/|$)/)?.[1] ?? `pr-${repo.split('/')[1]}-${pr.number}`;
  const properties = { schema: 'cycle_stage.v1', job_id: job, pool: 'none', repo, pr: pr.number, sha: pr.headRefOid.toLowerCase(), source: 'backfill', attempt: 1 };
  const events = [];
  const add = (stage, start, end) => {
    if (!start || !end || end < start || start < opened || end > merged) return;
    const insertId = createHash('sha256').update(`${repo}|${pr.number}|${job}|${properties.sha}|${stage}|1`).digest('hex').slice(0, 32);
    events.push({ event: 'cycle_stage', distinct_id: `cycle:${repo}:${pr.number}`, timestamp: end, properties: { ...properties, stage, ts_start: start, ts_end: end, duration_s: Math.floor((Date.parse(end) - Date.parse(start)) / 1000), $insert_id: insertId } });
  };
  const suites = (pr.checkSuites ?? []).filter(s => s.app?.slug === 'github-actions');
  const ciStart = min(suites.map(s => iso(s.createdAt)));
  const allChecks = (pr.checkSuites ?? []).flatMap(s => {
    const latest = new Map();
    for (const [index, check] of (s.checkRuns ?? []).entries()) {
      const key = check.name ?? index;
      const previous = latest.get(key);
      if (!previous || (iso(check.startedAt) ?? iso(check.completedAt) ?? '') >= (iso(previous.startedAt) ?? iso(previous.completedAt) ?? '')) latest.set(key, check);
    }
    return [...latest.values()].map(check => ({ ...check, actions: s.app?.slug === 'github-actions' }));
  });
  const required = allChecks.filter(c => c.isRequired === true);
  const checks = required.length ? required : allChecks.filter(c => c.actions);
  const ciEnd = checks.length && checks.every(c => c.status === 'COMPLETED' && iso(c.completedAt)) ? max(checks.map(c => iso(c.completedAt))) : null;
  add('rework', opened, ciStart);
  add('ci_pr', ciStart, ciEnd);
  const timeline = pr.timeline ?? [];
  const ready = max(timeline.filter(e => e.__typename === 'ReadyForReviewEvent').map(e => iso(e.createdAt))) ?? opened;
  const reviewEnd = min(timeline.filter(e => {
    const author = e.author?.login;
    if (e.__typename === 'PullRequestReview') return author === ownerReviewer || (['coderabbitai', 'coderabbitai[bot]'].includes(author) && e.state === 'APPROVED');
    if (e.__typename !== 'IssueComment') return false;
    return author === ownerReviewer || (['coderabbitai', 'coderabbitai[bot]'].includes(author) && /(?:no actionable comments|looks good to me|no issues found|^\s*approved[.!]?\s*$)/im.test(e.body ?? ''));
  }).map(e => iso(e.submittedAt ?? e.createdAt)).filter(t => t && t >= ready));
  add('review', ready, reviewEnd);
  // A draft with no ready event has no known review start.
  if (pr.isDraft) return events.filter(e => e.properties.stage !== 'review');
  const green = ciEnd && checks.every(c => terminal.has(c.conclusion)) && reviewEnd ? max([ciEnd, reviewEnd]) : null;
  if (queued) {
    const queueEvents = timeline.filter(e => ['AddedToMergeQueueEvent', 'RemovedFromMergeQueueEvent'].includes(e.__typename) && iso(e.createdAt) && iso(e.createdAt) <= merged).sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)));
    const lastQueueEvent = queueEvents.at(-1);
    const enqueue = lastQueueEvent?.__typename === 'AddedToMergeQueueEvent' ? iso(lastQueueEvent.createdAt) : null;
    const auto = min(timeline.filter(e => e.__typename === 'AutoMergeEnabledEvent').map(e => iso(e.createdAt)).filter(t => t && green && t >= green));
    add('green_to_enqueue', green, min([enqueue, auto].filter(t => t && green && t >= green)));
    add('merge_group', enqueue, merged);
  } else add('green_to_merged', green, merged);
  return events;
}

export function validateEvent(event) {
  const keys = ['schema', 'job_id', 'pool', 'repo', 'pr', 'sha', 'source', 'attempt', 'stage', 'ts_start', 'ts_end', 'duration_s', '$insert_id'];
  const p = event?.properties;
  if (!p || Object.keys(event).sort().join(',') !== 'distinct_id,event,properties,timestamp' || Object.keys(p).sort().join(',') !== keys.sort().join(',') ||
      event.event !== 'cycle_stage' || p.schema !== 'cycle_stage.v1' || p.source !== 'backfill' ||
      !/^[\w.-]+\/[\w.-]+$/.test(p.repo) || !/^[\w.-]+$/.test(p.job_id) || p.pool !== 'none' ||
      !Number.isSafeInteger(p.pr) || p.pr < 1 || !/^[a-f\d]{40}$/.test(p.sha) || p.attempt !== 1 ||
      !['rework', 'ci_pr', 'review', 'green_to_enqueue', 'merge_group', 'green_to_merged'].includes(p.stage) ||
      iso(p.ts_start) !== p.ts_start || iso(p.ts_end) !== p.ts_end || !p.ts_start || !p.ts_end || p.ts_end < p.ts_start ||
      p.duration_s !== Math.floor((Date.parse(p.ts_end) - Date.parse(p.ts_start)) / 1000) ||
      event.timestamp !== p.ts_end || event.distinct_id !== `cycle:${p.repo}:${p.pr}` ||
      p.$insert_id !== createHash('sha256').update(`${p.repo}|${p.pr}|${p.job_id}|${p.sha}|${p.stage}|${p.attempt}`).digest('hex').slice(0, 32)) throw new Error('Invalid cycle event');
  return event;
}

const PR_FIELDS = 'number createdAt mergedAt headRefOid headRefName isDraft';
const TIMELINE_FIELDS = `__typename ... on ReadyForReviewEvent { createdAt } ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt } ... on AutoMergeEnabledEvent { createdAt } ... on PullRequestReview { author { login } state submittedAt } ... on IssueComment { author { login } body createdAt }`;
export function gh(query, variables, execute = execFileSync) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) if (value !== null) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  let result;
  try { result = JSON.parse(execute('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })); }
  catch { throw new Error('gh GraphQL request failed (details suppressed)'); }
  if (result.errors || !result.data) throw new Error('gh GraphQL returned errors');
  return result.data;
}
function pages(fetchPage) {
  const nodes = [];
  let cursor = null;
  const seen = new Set();
  do {
    const page = fetchPage(cursor);
    if (!page || !Array.isArray(page.nodes) || page.nodes.some(node => !node) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete GitHub connection');
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error('Invalid GitHub pagination cursor');
    seen.add(cursor);
  } while (cursor);
  return nodes;
}

export function collectRepo(repo, since, until, request = gh) {
  const [owner, name] = repo.split('/');
  const variables = { owner, name };
  const search = `repo:${repo} is:pr is:merged merged:${since}..${until} sort:updated-asc`;
  const prs = pages(cursor => {
    const data = request(`query($search:String!,$cursor:String) { search(query:$search,type:ISSUE,first:100,after:$cursor) { issueCount nodes { ... on PullRequest { ${PR_FIELDS} } } pageInfo { hasNextPage endCursor } } }`, { search, cursor });
    if (data.search.issueCount > 1000) throw new Error('GitHub search exceeds 1000 PRs; use a narrower time window');
    return data.search;
  });
  for (const pr of prs) {
    const base = { ...variables, number: pr.number };
    pr.timeline = pages(cursor => request(`query($owner:String!,$name:String!,$number:Int!,$cursor:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { timelineItems(first:100,after:$cursor,itemTypes:[READY_FOR_REVIEW_EVENT,ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,AUTO_MERGE_ENABLED_EVENT,PULL_REQUEST_REVIEW,ISSUE_COMMENT]) { nodes { ${TIMELINE_FIELDS} } pageInfo { hasNextPage endCursor } } } } }`, { ...base, cursor }).repository.pullRequest.timelineItems);
    pr.checkSuites = pages(cursor => request(`query($owner:String!,$name:String!,$sha:GitObjectID!,$cursor:String) { repository(owner:$owner,name:$name) { object(oid:$sha) { ... on Commit { checkSuites(first:100,after:$cursor) { nodes { id createdAt app { slug } } pageInfo { hasNextPage endCursor } } } } } }`, { ...variables, sha: pr.headRefOid, cursor }).repository.object.checkSuites);
    for (const suite of pr.checkSuites) {
      suite.checkRuns = pages(cursor => request(`query($id:ID!,$number:Int!,$cursor:String) { node(id:$id) { ... on CheckSuite { checkRuns(first:100,after:$cursor) { nodes { name startedAt status conclusion completedAt isRequired(pullRequestNumber:$number) } pageInfo { hasNextPage endCursor } } } } }`, { id: suite.id, number: pr.number, cursor }).node.checkRuns);
    }
  }
  return prs;
}

function removeIfPresent(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function run(options, { collect = collectRepo } = {}) {
  const statePath = resolve(options.state);
  const spoolPath = resolve(options.spool);
  if (statePath === spoolPath) throw new Error('State and spool paths must differ');
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = openSync(`${statePath}.lock`, 'wx', 0o600); }
  catch { throw new Error('Collector state is locked; ensure no collector is running before removing the lock'); }
  try {
    let state = { schema: 'cycle-collector.v1', cursors: {}, insertIds: [] };
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read collector state'); }
    if (state.schema !== 'cycle-collector.v1' || !state.cursors || typeof state.cursors !== 'object' || Array.isArray(state.cursors) || !Array.isArray(state.insertIds) || state.insertIds.some(id => !/^[a-f\d]{32}$/.test(id))) throw new Error('Invalid collector state');
    const seen = new Set(state.insertIds);
    // Recover a crash after durable spool append but before cursor replacement.
    try {
      for (const line of readFileSync(spoolPath, 'utf8').split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        validateEvent(event);
        seen.add(event.properties.$insert_id);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot recover collector spool'); }
    if (Object.values(state.cursors).some(value => !iso(value))) throw new Error('Invalid cursor timestamp');
    const pending = [];
    for (const repo of options.repos) {
      const since = options.since ?? (state.cursors[repo] ? new Date(Date.parse(state.cursors[repo]) - 86_400_000).toISOString() : new Date(Date.parse(options.until) - 86_400_000).toISOString());
      const prs = collect(repo, since, options.until);
      for (const pr of prs) {
        if (!iso(pr.mergedAt) || iso(pr.mergedAt) < since || iso(pr.mergedAt) > options.until) continue;
        for (const event of eventsForPr(repo, pr, options)) if (!seen.has(event.properties.$insert_id)) {
          pending.push(event);
          seen.add(event.properties.$insert_id);
        }
      }
      // Inclusive watermark: re-fetch ties and delayed evidence; ids remove duplicates.
      const latest = max(prs.map(pr => iso(pr.mergedAt)).filter(t => t && t <= options.until));
      if (latest) state.cursors[repo] = max([state.cursors[repo], latest]);
    }
    mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
    if (pending.length) appendFileSync(spoolPath, pending.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600, flush: true });
    state.insertIds = [...seen].sort();
    const temporary = `${statePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, statePath);
    } finally { removeIfPresent(temporary); }
    return { events: pending.length, repos: options.repos.length, mode: 'dry-run' };
  } finally { closeSync(lock); unlinkSync(`${statePath}.lock`); }
}

export function parseArgs(args) {
  const options = { repos: [], state: '.ashlr/cycle-metrics/cursor.json', spool: '.ashlr/cycle-metrics/events.jsonl', until: new Date().toISOString() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { options.send = false; continue; }
    if (arg === '--send') { options.send = true; continue; }
    if (arg === '--help') return null;
    if (!['--repo', '--since', '--until', '--state', '--spool', '--owner-reviewer'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unsupported or incomplete option: ${arg}`);
    const value = args[++i];
    if (arg === '--repo') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error('Expected --repo owner/name');
      options.repos.push(value);
    } else if (arg === '--since' || arg === '--until') {
      if (!/^\d{4}-\d\d-\d\d(?:T.*Z)?$/.test(value) || !iso(value) || iso(value).slice(0, 10) !== value.slice(0, 10)) throw new Error('Expected a UTC date or timestamp');
      options[arg.slice(2)] = iso(value);
    } else options[arg === '--owner-reviewer' ? 'ownerReviewer' : arg.slice(2)] = value;
  }
  if (!options.repos.length) options.repos = DEFAULT_REPOS;
  options.repos = [...new Set(options.repos)];
  if (options.since && options.since > options.until) throw new Error('--since must not exceed --until');
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) console.log('Usage: node scripts/cycle-collect.mjs [--repo owner/name] [--since UTC] [--until UTC] [--state file] [--spool file] [--dry-run|--send] [--owner-reviewer login]\nRead-only gh GraphQL collection of S4–S8. Default: local JSONL spool; no telemetry upload.');
    else {
      const result = run(options);
      let delivery;
      if (options.send) {
        try { delivery = JSON.parse(execFileSync('phantom', ['exec', '--', process.execPath, fileURLToPath(new URL('./cycle-send.mjs', import.meta.url)), '--spool', resolve(options.spool)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 })); }
        catch { throw new Error('Delivery failed; events remain spooled for retry (details suppressed)'); }
      }
      console.log(JSON.stringify({ ...result, mode: options.send ? 'send' : 'dry-run', ...(delivery ? { delivery } : {}) }));
    }
  } catch (error) { console.error(`cycle-collect: ${error.message}`); process.exitCode = 1; }
}
