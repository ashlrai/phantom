#!/usr/bin/env node
// One bounded pass; GitHub remains the authority for merge queue admission.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = 'ashlrai/phantom';
const gate = 'Merge Gate';
const query = `query($number:Int!){repository(owner:"ashlrai",name:"phantom"){pullRequest(number:$number){headRefOid mergeable mergeStateStatus isDraft state baseRefName mergeQueueEntry { id } timelineItems(last:100,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { __typename ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt } } } mergedAt createdAt }}}`;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}
function api(path) { return JSON.parse(gh(['api', '--paginate', '--slurp', path])).flatMap(x => Array.isArray(x) ? x : [x]); }
function snapshot(number) {
  const pr = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `number=${number}`])).data.repository.pullRequest;
  const rules = api(`repos/${repo}/rules/branches/master?per_page=100`);
  const checks = api(`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`).flatMap(page => page.check_runs ?? []);
  const statuses = api(`repos/${repo}/commits/${pr.head.sha}/statuses?per_page=100`);
  return { pr, data, rules, checks, statuses };
}
export function eligible({ pr, data, rules, checks, statuses }) {
  if (!pr || !data || pr.state !== 'open' || pr.draft !== false || data.state !== 'OPEN' || data.isDraft !== false || pr.base?.ref !== 'master' || data.baseRefName !== 'master' || !pr.labels?.some(l => l.name === 'autorelease: pending')) return false;
  if (!pr.head?.sha || pr.head.sha !== data.headRefOid || pr.mergeable !== true || pr.mergeable_state !== 'clean' || data.mergeable !== 'MERGEABLE' || data.mergeStateStatus !== 'CLEAN' || data.mergeQueueEntry !== null) return false;
  const required = rules.flatMap(r => r.type === 'required_status_checks' ? (r.parameters?.required_status_checks ?? []) : []);
  if (!required.some(c => c.context === gate)) return false;
  const runs = checks.filter(c => c.name === gate && c.head_sha === pr.head.sha);
  const contexts = statuses.filter(s => s.context === gate);
  // Refuse conflicting, incomplete, missing or stale evidence rather than guess which producer is authoritative.
  return runs.length + contexts.length > 0 && runs.every(c => c.status === 'completed' && c.conclusion === 'success') && contexts.every(s => s.state === 'success');
}
export function evidence(data) {
  const events = data.timelineItems.nodes;
  const last = events.at(-1);
  const queuedAt = last?.__typename === 'AddedToMergeQueueEvent' ? last.createdAt : null;
  const elapsed = data.mergedAt ? (Date.parse(data.mergedAt) - Date.parse(data.createdAt)) / 1000 : null;
  return { queuedAt, mergedAt: data.mergedAt, openToMergeSeconds: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null };
}
function main() {
  const apply = process.argv.slice(2).includes('--apply');
  if (process.argv.slice(2).some(a => a !== '--apply')) throw new Error('usage: node scripts/release-enqueue.mjs [--apply]');
  const found = JSON.parse(gh(['search', 'prs', 'label:"autorelease: pending" is:pr is:open repo:ashlrai/phantom', '--limit', '1000', '--json', 'number']));
  if (found.length >= 1000) throw new Error('candidate search reached its limit; refusing incomplete discovery');
  let errors = 0;
  for (const { number } of found) {
    try {
      const first = snapshot(number);
      if (!eligible(first)) { console.log(JSON.stringify({ number, result: 'not eligible' })); continue; }
      if (!apply) { console.log(JSON.stringify({ number, head: first.pr.head.sha, result: 'eligible (dry run)' })); continue; }
      const current = snapshot(number);
      if (!eligible(current) || current.pr.head.sha !== first.pr.head.sha) { console.log(JSON.stringify({ number, result: 'changed; not enqueued' })); continue; }
      gh(['pr', 'merge', String(number), '-R', repo]);
      const observed = snapshot(number);
      const result = evidence(observed.data);
      console.log(JSON.stringify({ number, head: current.pr.head.sha, result: 'merge requested', ...result }));
      if (!result.queuedAt && !result.mergedAt) errors++;
    } catch { errors++; console.error(JSON.stringify({ number, result: 'error or evidence unavailable; inspect GitHub before retrying' })); }
  }
  if (!found.length) console.log(JSON.stringify({ result: 'no open release PRs' }));
  if (errors) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch { console.error('Release enqueue discovery failed; no further action taken.'); process.exitCode = 1; }
}
