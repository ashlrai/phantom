import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { elapsed, LOOP_REPOS, row, time, type LoopPr, type LoopReport, type Row } from './loop.js';
import type { CiTime, QueueClaim } from './loop-inputs.js';

const execute = promisify(execFile);
export type LoopGh = (args: string[]) => Promise<unknown>;
/** No shell, bounded output/time, and no subprocess stderr in reports (it can contain credentials). */
export const loopGh: LoopGh = async args => {
  const result = await execute('gh', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } });
  return JSON.parse(result.stdout);
};
const PR_FIELDS = 'map({number,created_at,updated_at,merged_at,draft,state,head:{sha:.head.sha,ref:.head.ref},is_revert:(.title | test("^revert(?:\\b|:)";"i"))})';
const TIMELINE_FIELDS = 'map({event,created_at})';
const REVIEW_FIELDS = 'map({state,submitted_at})';
const CHECK_FIELDS = '{total_count,check_runs:[.check_runs[]|{id,head_sha,name,status,conclusion,started_at,completed_at,app:{slug:.app.slug}}]}';
const STATUS_FIELDS = 'map({id,context,state,created_at,updated_at,creator:{login:.creator.login}})';
interface Paged { values: Row[]; complete: boolean }
async function pages(gh: LoopGh, endpoint: string, projection: string, field?: string, cutoff?: number): Promise<Paged> {
  const values: Row[] = [];
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 10; page++) {
    try {
      const result = await gh(['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, '--jq', projection]);
      const items = field ? row(result)[field] : result;
      if (!Array.isArray(items) || items.some(item => Object.keys(row(item)).length === 0)) return { values, complete: false };
      if (field) {
        const total = row(result)['total_count'];
        if (!Number.isSafeInteger(total) || Number(total) < 0 || (expectedTotal !== undefined && expectedTotal !== total)) return { values, complete: false };
        expectedTotal = Number(total);
      }
      values.push(...items.map(row));
      if (cutoff !== undefined && items.some(item => (time(row(item)['updated_at']) ?? Infinity) < cutoff)) return { values, complete: true };
      if (items.length < 100) {
        return { values, complete: expectedTotal === undefined || values.length === expectedTotal };
      }
    } catch { return { values, complete: false }; }
  }
  return { values, complete: false };
}
function readyAt(pr: Row, timeline: Paged, now: number): string | null {
  if (!timeline.complete) return null;
  const transitions = timeline.values.filter(event => event['event'] === 'ready_for_review' || event['event'] === 'convert_to_draft')
    .sort((a, b) => (time(a['created_at']) ?? Infinity) - (time(b['created_at']) ?? Infinity));
  // A PR whose first transition is to draft started ready. With no transitions,
  // a non-draft PR was ready at creation. Never use the last update as ready time.
  const first = transitions[0];
  const value = first?.['event'] === 'ready_for_review' ? first['created_at'] : pr['draft'] === false || first?.['event'] === 'convert_to_draft' ? pr['created_at'] : null;
  return elapsed(pr['created_at'], value, now) === null ? null : String(value);
}

export async function observeLoopPr(
  gh: LoopGh, repo: string, pr: Row, claims: QueueClaim[], ledger: CiTime[], now: number, wallClock = now,
): Promise<{ pr: LoopPr; complete: boolean }> {
  const number = Number(pr['number']), head = row(pr['head']), sha = String(head['sha']);
  const [timeline, reviews, checks, statuses] = await Promise.all([
    pages(gh, `repos/${repo}/issues/${number}/timeline`, TIMELINE_FIELDS),
    pages(gh, `repos/${repo}/pulls/${number}/reviews`, REVIEW_FIELDS),
    pages(gh, `repos/${repo}/commits/${sha}/check-runs?filter=all`, CHECK_FIELDS, 'check_runs'),
    pages(gh, `repos/${repo}/commits/${sha}/statuses`, STATUS_FIELDS),
  ]);
  const validPast = (value: unknown): boolean => elapsed(pr['created_at'], value, wallClock) !== null;
  const validTimestamp = (value: unknown): boolean => time(value) !== null && time(value)! >= 0 && time(value)! <= wallClock;
  timeline.complete &&= timeline.values.every(event => typeof event['event'] === 'string' &&
    (!['ready_for_review', 'convert_to_draft'].includes(String(event['event'])) || validPast(event['created_at'])));
  reviews.complete &&= reviews.values.every(review => ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING'].includes(String(review['state'])) &&
    (review['state'] === 'PENDING' || validPast(review['submitted_at'])));
  checks.complete &&= checks.values.every(check => Number.isSafeInteger(check['id']) && Number(check['id']) > 0 && check['head_sha'] === sha &&
    typeof check['name'] === 'string' && typeof check['status'] === 'string' &&
    (check['started_at'] === null || validTimestamp(check['started_at'])) &&
    (check['completed_at'] === null || validTimestamp(check['completed_at'])));
  statuses.complete &&= statuses.values.every(status => Number.isSafeInteger(status['id']) && Number(status['id']) > 0 && typeof status['context'] === 'string' &&
    ['error', 'failure', 'pending', 'success'].includes(String(status['state'])) && validTimestamp(status['created_at']));
  const ready = readyAt(pr, timeline, now);
  const matching = claims.filter(claim => claim.repo === repo && (claim.pr === number ||
    (claim.pr === null && claim.task && String(head['ref']).split('/').includes(claim.task))));
  // Ambiguous claims must not silently attribute work to the wrong agent.
  const claim = matching.length === 1 ? matching[0] : undefined;
  const uniqueChecks = [...new Map(checks.values.map(check => [check['id'], check])).values()].filter(check => check['head_sha'] === sha);
  checks.complete &&= uniqueChecks.length === checks.values.length;
  const durations = uniqueChecks.map(check => elapsed(check['started_at'], check['completed_at'], now));
  const ci = checks.complete && uniqueChecks.length > 0 && durations.every(value => value !== null)
    ? durations.reduce<number>((sum, value) => sum + value!, 0) : null;
  const ledgerMatches = ledger.filter(entry => entry.repo === repo && entry.pr === number && entry.head_sha === sha && entry.recorded_at <= now)
    .sort((a, b) => b.recorded_at - a.recorded_at);
  const newest = ledgerMatches[0];
  const ledgerTime = newest && !ledgerMatches.some(entry => entry.recorded_at === newest.recorded_at && entry.duration_ms !== newest.duration_ms) ? newest.duration_ms : null;
  const approvals = reviews.values.filter(review => review['state'] === 'APPROVED').map(review => review['submitted_at']);
  const passes = uniqueChecks.filter(check => check['conclusion'] === 'success' &&
    /^coderabbit(?:ai)?$/i.test(String(row(check['app'])['slug']))).map(check => check['completed_at']);
  const statusPasses = statuses.values.filter(status => status['state'] === 'success' && /^coderabbit(?:ai)?$/i.test(String(status['context'])) &&
    /^coderabbitai(?:\[bot\])?$/.test(String(row(status['creator'])['login']))).map(status => status['created_at']);
  const reviewDurations = [...approvals, ...passes, ...statusPasses].map(at => elapsed(ready, at, now)).filter((value): value is number => value !== null);
  // Missing pages can hide an earlier approval/pass: don't report a false first.
  const review = reviews.complete && checks.complete && statuses.complete && reviewDurations.length ? Math.min(...reviewDurations) : null;
  return { complete: timeline.complete && reviews.complete && checks.complete && statuses.complete && matching.length <= 1,
    pr: { repo, number, head_sha: sha, opened_at: String(pr['created_at']), ready_at: ready,
      merged_at: typeof pr['merged_at'] === 'string' ? pr['merged_at'] : null,
      reverted: pr['is_revert'] === true, agent: claim?.agent ?? null,
      durations_ms: { queue_wait: elapsed(claim?.queued_at, claim?.claimed_at, now), agent: elapsed(claim?.claimed_at, pr['created_at'], now),
        ci: ci ?? ledgerTime, review, merge: elapsed(ready, pr['merged_at'], now) },
      ci_ledger_ms: ledgerTime, ci_source: ci !== null ? 'github' : ledgerTime !== null ? 'ci_time.v1' : 'unknown' } };
}

export async function collectLoopGithub(gh: LoopGh, claims: QueueClaim[], ledger: CiTime[], now: number, wallClock = now): Promise<{
  prs: LoopPr[]; sources: LoopReport['sources']; repos: LoopReport['repos'];
}> {
  const prs: LoopPr[] = [], sources: LoopReport['sources'] = [], repos: LoopReport['repos'] = [];
  // Three repos at a time bounds subprocess fan-out; every endpoint also has a page cap.
  for (let i = 0; i < LOOP_REPOS.length; i += 3) {
    const results = await Promise.all(LOOP_REPOS.slice(i, i + 3).map(async repo => {
      const [open, closed] = await Promise.all([
        pages(gh, `repos/${repo}/pulls?state=open&sort=updated&direction=desc`, PR_FIELDS),
        pages(gh, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, PR_FIELDS, undefined, now - 7 * 86400_000),
      ]);
      let complete = open.complete && closed.complete;
      const selected = new Map<number, Row>();
      for (const pr of [...closed.values, ...open.values]) {
        const merged = time(pr['merged_at']);
        if (!['open', 'closed'].includes(String(pr['state'])) || typeof pr['draft'] !== 'boolean' || typeof pr['is_revert'] !== 'boolean' ||
          time(pr['updated_at']) === null || time(pr['updated_at'])! > wallClock || (pr['merged_at'] !== null && (merged === null || merged > wallClock)) ||
          !Number.isSafeInteger(pr['number']) || Number(pr['number']) <= 0 || !/^[a-f0-9]{40}$/i.test(String(row(pr['head'])['sha'])) ||
          time(pr['created_at']) === null || time(pr['created_at'])! > wallClock || (merged !== null && merged < time(pr['created_at'])!)) {
          complete = false; continue;
        }
        if (time(pr['created_at'])! > now) continue;
        if (pr['state'] !== 'open' && (merged === null || merged < now - 7 * 86400_000 || merged > now)) continue;
        selected.set(Number(pr['number']), pr);
      }
      const observed: LoopPr[] = [];
      let detailsComplete = true;
      for (const pr of selected.values()) {
        const result = await observeLoopPr(gh, repo, pr, claims, ledger, now, wallClock);
        observed.push(result.pr); detailsComplete &&= result.complete;
      }
      return { repo, complete, detailsComplete, observed };
    }));
    for (const result of results) {
      prs.push(...result.observed);
      repos.push({ repo: result.repo, complete: result.complete, merged_prs: result.complete ? result.observed.filter(pr => pr.merged_at).length : null });
      sources.push({ source: `github:${result.repo}`, complete: result.complete && result.detailsComplete,
        reason: result.complete && result.detailsComplete ? null : 'unavailable-invalid-or-page-limit' });
    }
  }
  return { prs, sources, repos };
}
