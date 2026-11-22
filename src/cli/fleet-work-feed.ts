/** Read-only bus v2 work feed; routing labels grant no authority. */
import { isAbsolute } from 'node:path';
import { busWorkFeedOwnerMatcher, busWorkFeedPendingToMatcher, busWorkFeedRepoKey, BUS_WORK_FEED_CONTAINS_MAX, BUS_WORK_FEED_LIMIT_MAX, formatBusWorkFeed, projectBusWorkFeedView, readBusWorkFeed, sliceBusWorkFeedView } from '../core/agents/bus-work-feed-read.js';
import { PROVIDERS, providerSchema, WORK_STATUSES, WORK_TIERS, type WorkDispatch, type WorkJob } from '../core/agents/bus-v2-schema.js';
import { parseSince } from '../core/fleet/agent-messages.js';

const usage = `Usage: ashlr fleet work-feed [--root <absolute>] [--status <${WORK_STATUSES.join('|')}>] [--job <id>] [--repo <owner/name>] [--provider <${PROVIDERS.join('|')}>] [--tier <${WORK_TIERS.join('|')}>] [--to <label>] [--owner <agent>] [--claims] [--open] [--claimable] [--since <15m|2h|1d|ISO>] [--contains <text>] [--limit <1-${BUS_WORK_FEED_LIMIT_MAX}>] [--json] [--help]
Read-only bus v2 work feed; --open keeps open-status candidates with claim keys, including unknown holds, and implies --claims; --claims joins live coordination holds and --claimable keeps only open jobs whose declared claim keys provably include a free one (it implies the claims join). --repo keeps jobs announced for that owner/name repo (case-insensitive, the claim-key rule), --provider keeps jobs announced for that provider, --tier keeps only jobs whose announcement declared that dispatch tier — a job carrying no dispatch spec declares none and never matches — --to keeps jobs whose announcement was addressed to that agent — the literal routing label, every label of one agent identity, and group:<channel>:<topic> addresses of registry channels the identity belongs to, minus that identity's own channel posts — and --owner keeps jobs announced by that agent, each under every label of one agent identity; --job keeps one job id; --since keeps only jobs whose last activity — the newest accepted status receipt time, or the announcement's while no status has moved the job — reaches the cutoff (15m, 2h, 1d, epoch ms or an ISO time); --contains keeps only jobs whose title, newest status detail or declared dispatch scope/acceptance carries the needle as a case-insensitive substring, matched over the same scrubbed display-clipped text the job line renders; --limit pages the filtered view newest-first and reports matched/omitted. Unknown feed or hold state stays unknown.`;

const LABEL = /^[\x21-\x7e]{1,128}(?![\s\S])/;

export async function cmdFleetWorkFeed(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, status: WorkJob['status'] | undefined, to: string | undefined,
    owner: string | undefined, jobId: string | undefined, repo: string | undefined,
    provider: WorkJob['provider'] | undefined, tier: WorkDispatch['tier'] | undefined,
    sinceRaw: string | undefined, contains: string | undefined, limit: number | undefined,
    json = false, claims = false, claimable = false, open = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--claims' && !claims) { claims = true; continue; }
    if (key === '--open' && !open) { open = true; continue; }
    if (key === '--claimable' && !claimable) { claimable = true; continue; }
    if (!['--root', '--status', '--to', '--owner', '--job', '--repo', '--provider', '--tier', '--since', '--contains', '--limit'].includes(key)) { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--limit' && limit === undefined && /^[0-9]+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= BUS_WORK_FEED_LIMIT_MAX) limit = parsed;
      else { console.error(usage); return 2; }
      continue;
    }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--since' && sinceRaw === undefined) sinceRaw = value;
    else if (key === '--contains' && contains === undefined &&
      value.trim() !== '' && value.length <= BUS_WORK_FEED_CONTAINS_MAX) contains = value;
    else if (key === '--status' && status === undefined && WORK_STATUSES.some(item => item === value)) {
      status = value as WorkJob['status'];
    } else if (key === '--to' && to === undefined && LABEL.test(value)) {
      to = value;
    } else if (key === '--owner' && owner === undefined && LABEL.test(value)) {
      owner = value;
    } else if (key === '--job' && jobId === undefined && LABEL.test(value)) {
      jobId = value;
    } else if (key === '--repo' && repo === undefined) {
      const normalized = busWorkFeedRepoKey(value);
      if (normalized === undefined) { console.error(usage); return 2; }
      repo = normalized;
    } else if (key === '--provider' && provider === undefined && providerSchema.safeParse(value).success) {
      provider = value as WorkJob['provider'];
    } else if (key === '--tier' && tier === undefined &&
      (WORK_TIERS as readonly string[]).includes(value)) {
      tier = value as WorkDispatch['tier'];
    } else { console.error(usage); return 2; }
  }
  if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) { console.error(usage); return 2; }
  // The same --since grammar agents bus inbox --since and phm messages --since
  // take — 15m, 2h, 1d, epoch ms or an ISO time — resolved once at read start.
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw);
  if (sinceRaw !== undefined && since === null) { console.error(usage); return 2; }
  const result = projectBusWorkFeedView(readBusWorkFeed({ root, claims: claims || claimable || open }), {
    status, jobId, repo, provider, tier, open: open || undefined, claimable: claimable || undefined, since: since ?? undefined,
    contains,
    toMatch: to === undefined ? undefined : busWorkFeedPendingToMatcher(to, { root }),
    ownerMatch: owner === undefined ? undefined : busWorkFeedOwnerMatcher(owner, { root }),
  });
  const paged = limit === undefined ? result : sliceBusWorkFeedView(result, limit);
  if (json) console.log(JSON.stringify(paged));
  else for (const line of formatBusWorkFeed(paged)) console.log(line);
  return paged.status === 'ok' ? 0 : 1;
}
