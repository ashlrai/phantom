/** Advisory portfolio ranking. Scores never establish merge eligibility or authority. */
import { buildFleetEvalReport, foldJobsLedger } from './eval-report.js';
import { parseMergeBatchPrs } from './merge-batch.js';
import { scrubSecrets } from '../util/scrub.js';
import { dayBounds } from '../drive/merged-per-day.js';

const DAY = 86_400_000;
const text = (v: unknown): string => typeof v === 'string' ? v.slice(0, 32_000) : '';
const count = (v: unknown): number | null => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : null;
const rows = (v: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(v) || v.length > 5_000 || v.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('invalid PR snapshot');
  return v as Record<string, unknown>[];
};

/** Delta potential dominates small-diff rewards; words are heuristic evidence, never proof. */
export function leverageScore(pr: { title?: string; body?: string; files: string[]; additions?: number; deletions?: number }, dependents = 0, laneYield: number | null = null, ageDays = 0) {
  const description = `${pr.title ?? ''} ${pr.body ?? ''}`;
  const deltaPotential = /\b(enable|unlock|capability|implement|introduce|autonom|recover|automat)/i.test(description) ? 40 : 0;
  const userImpact = /\b(fix|feat|user|desktop|console|crash|data loss|outage)\b/i.test(description) ? 20 : 0;
  const tests = pr.files.some(f => /(^test\/|\.(test|spec)\.)/.test(f));
  const size = pr.additions === undefined || pr.deletions === undefined ? null : pr.additions + pr.deletions;
  const slop = /\b(todo|placeholder|lorem ipsum|as an ai)\b/i.test(description);
  const quality = (tests ? 5 : 0) + (size === null ? 0 : size <= 600 ? 3 : -5) - (slop ? 10 : 0);
  const staleness = Math.min(20, Math.max(0, ageDays));
  return { deltaPotential, userImpact, dependents, quality, tests, size, slop, laneYield, staleness,
    total: deltaPotential + userImpact + Math.min(30, dependents * 10) + quality + (laneYield ?? 0) * 5 - staleness };
}

export function rankPrLeverage(input: unknown, jobsText: string | null, nowMs: number, day = new Date(nowMs - DAY).toISOString().slice(0, 10)) {
  const { start, end } = dayBounds(day);
  if (end > nowMs) throw new Error('delta day must be complete');
  const seen = new Set<string>();
  const prs = rows(input).map(raw => {
    const url = text(raw['url']).toLowerCase();
    const match = /^https:\/\/github\.com\/(ashlrai\/[a-z0-9._-]+)\/pull\/([1-9]\d*)$/.exec(url);
    const parsed = parseMergeBatchPrs([raw]);
    const pr = parsed.ok ? parsed.prs[0] : undefined;
    if (!match || !pr || pr.number !== Number(match[2])) throw new Error('PR needs canonical ashlrai URL and number');
    const duplicate = seen.has(url); seen.add(url);
    return { ...pr, raw, url, repo: match[1]!, body: text(raw['body']), duplicate,
      state: text(raw['state']).toUpperCase() || (raw['mergedAt'] ? 'MERGED' : 'OPEN'),
      job: text(raw['title']).match(/\bRQ-[A-Z0-9_-]+/i)?.[0]?.toUpperCase() ?? null };
  }).filter(pr => !pr.duplicate);
  const history = buildFleetEvalReport({ jobsText, prsTexts: [JSON.stringify(input)], nowMs, windowDays: 90 });
  const ledger = foldJobsLedger(jobsText ?? '', nowMs - 90 * DAY, nowMs);
  const open = prs.filter(pr => pr.state === 'OPEN');
  const mergedUrls = new Set([...prs.filter(pr => pr.state === 'MERGED').map(pr => pr.url),
    ...[...ledger.outcomes].filter(([, outcome]) => outcome.state === 'MERGED').map(([url]) => url)]);
  const dependencies = new Map(open.map(other => [other.url, [...new Set([
    ...open.filter(pr => pr.url !== other.url && pr.job !== null && new RegExp(`after[=:]\\s*${pr.job}(?![A-Z0-9_-])`, 'i').test(other.body)).map(pr => pr.url),
    ...[...other.body.matchAll(/(?:depends on|blocked by|after[=:])\s*(https:\/\/github\.com\/ashlrai\/[a-z0-9._-]+\/pull\/[1-9]\d*)/gi)].map(match => match[1]!.toLowerCase()),
  ])].filter(url => url !== other.url && !mergedUrls.has(url))]));
  const ranked = open.map(pr => {
    const dependents = [...dependencies.values()].filter(urls => urls.includes(pr.url)).length;
    const jobId = ledger.jobByUrl.get(pr.url);
    const lane = scrubSecrets(text(pr.raw['lane']) || (jobId ? ledger.jobs.get(jobId)?.routes.at(-1)?.lane : null) || '') || null;
    const prior = history.byLane.find(group => group.name === lane);
    const laneYield = prior && prior.finished > 0 ? Math.min(1, prior.merged / prior.finished) : null;
    const laneDurability = prior?.durability.ci95?.[0] ?? null;
    const age = pr.updatedAt ? Math.max(0, (nowMs - Date.parse(pr.updatedAt)) / DAY) : 0;
    const signals = leverageScore({ title: pr.title, body: pr.body, files: pr.files,
      ...(count(pr.raw['additions']) !== null ? { additions: Number(pr.raw['additions']) } : {}),
      ...(count(pr.raw['deletions']) !== null ? { deletions: Number(pr.raw['deletions']) } : {}) }, dependents, laneYield, age);
    const conflict = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
    return { url: pr.url, repo: pr.repo, number: pr.number, job: pr.job, title: scrubSecrets(pr.title), lane, signals,
      score: signals.total + (laneDurability ?? 0) * 3 - (conflict ? 15 : 0),
      action: conflict || pr.mergeStateStatus === 'BEHIND' || age > 14 ? 'agent-rebase-or-close' : pr.isDraft ? 'draft' : signals.total <= 0 ? 'agent-review-or-close' : 'consider-merge',
      evidence: { laneDurability, filesComplete: pr.filesComplete === true, ageDays: pr.updatedAt ? age : null } };
  }).sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  // Connected overlap components are REVIEW groups, never proof of equivalence.
  const clusters: { strongest: string; reconcile: string[] }[] = [];
  const visited = new Set<string>();
  for (const candidate of ranked) {
    if (visited.has(candidate.url)) continue;
    const group = [candidate.url]; visited.add(candidate.url);
    for (const url of group) {
      const a = open.find(p => p.url === url)!;
      for (const b of open) {
        if (visited.has(b.url) || a.repo !== b.repo) continue;
        const shared = a.files.filter(f => b.files.includes(f)).length;
        if ((a.job && a.job === b.job) || (a.filesComplete && b.filesComplete && shared >= 2 && shared / Math.max(a.files.length, b.files.length) >= 0.8)) {
          visited.add(b.url); group.push(b.url);
        }
      }
    }
    if (group.length > 1) clusters.push({ strongest: candidate.url, reconcile: group.slice(1) });
  }
  const reconcile = new Set(clusters.flatMap(c => c.reconcile));
  const mergeOrder: string[] = [];
  const remaining = new Set([...open.map(pr => pr.url), ...[...dependencies.values()].flat()]);
  for (;;) {
    const next = ranked.find(pr => remaining.has(pr.url) && !reconcile.has(pr.url) && pr.action === 'consider-merge'
      && dependencies.get(pr.url)!.every(url => !remaining.has(url)));
    if (!next) break;
    mergeOrder.push(next.url); remaining.delete(next.url);
  }
  const merged = prs.filter(pr => pr.state === 'MERGED' && Date.parse(text(pr.raw['mergedAt'])) >= start && Date.parse(text(pr.raw['mergedAt'])) < end);
  const daily = buildFleetEvalReport({ jobsText, prsTexts: [JSON.stringify(input)], nowMs, untilMs: end, windowDays: 1 });
  const measured = merged.filter(pr => daily.pullRequests.some(p => p.url === pr.url && p.checkState === 'clean')
    && count(pr.raw['additions']) !== null && count(pr.raw['deletions']) !== null);
  const completed = foldJobsLedger(jobsText ?? '', start, end).activity.filter(a => a.kind === 'finish' && !a.failed && !a.empty);
  return { schema: 'fleet.pr-leverage.v1', generatedAt: new Date(nowMs).toISOString(), advisory: true,
    coverage: 'provided-snapshot', sources: history.sources, ranked, clusters, mergeOrder, dependencies: Object.fromEntries(dependencies),
    dependencyBlocked: ranked.filter(pr => remaining.has(pr.url) && dependencies.get(pr.url)!.some(url => remaining.has(url))).map(pr => pr.url),
    delta: { schema: 'fleet.delta.v1', day, repos: [...new Set([...prs.map(p => p.repo), ...daily.pullRequests.map(p => p.repo)])].sort(), prsMerged: daily.merges.total,
      verifiedLines: measured.reduce((sum, pr) => sum + Number(pr.raw['additions']) + Number(pr.raw['deletions']), 0),
      unmeasuredPrs: daily.merges.total - measured.length, jobsCompleted: jobsText === null ? null : new Set(completed.map(a => a.jobId).filter(Boolean)).size } };
}
