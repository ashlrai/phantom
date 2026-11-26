/**
 * core/feed.ts — the Feed: one newest-first stream of what the fleet did, shared by
 * `phm feed`, `GET /api/feed` and the desktop Feed pane.
 *
 * It owns no store. Every row is projected from a reader that already exists:
 *   - the jobs ledger, dispatch events and leader plan log, through `readWorklog`
 *     (merged PRs with titles, failed and empty jobs with their reasons, incidents,
 *     Leader replies; it already folds one job's repeats into one row);
 *   - Phantom's own proposal merges (inbox store);
 *   - durable release announcements in leader/MASON-OUTBOX.md;
 *   - the main guardian's state file (which repos' main is red, since when).
 * Several merges in one repo in one clock hour read as one card that lists them.
 * Not shown, because nothing records them with a time: main going back to green,
 * and an incident closing.
 * Readers are injected (`FeedReaders`), so tests run on fixtures. A reader that
 * fails leaves its source `unknown`; its rows are absent, never guessed.
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { listProposalsDetailed } from './inbox/store.js';
import { realizedMergeOf } from './inbox/realized-merge.js';
import { parseOutbox } from './fleet/mason-outbox.js';
import { parseGuardianState } from './fleet/main-red-age.js';
import { readSource } from './fleet/runs-parked-queue.js';
import { validMilestoneTag } from './fleet/release-live-notice.js';
import { readWorklog, type WorklogReport } from './fleet/worklog.js';
import { scrubSecrets } from './util/scrub.js';
import { FEED_BURST_MIN, FEED_KINDS, FEED_MAX_LIMIT, FEED_SCHEMA, FEED_VERSION, type FeedItem, type FeedKind, type FeedQuery, type FeedReport, type FeedSourceState } from './feed-schema.js';

export { FEED_BURST_MIN, FEED_KINDS, FEED_MAX_LIMIT, FEED_SCHEMA, FEED_SOURCES, FEED_VERSION } from './feed-schema.js';
export type { FeedGroupEntry, FeedItem, FeedKind, FeedQuery, FeedReport, FeedSourceName, FeedSourceState } from './feed-schema.js';

/** What the readers hand back. `null` means the source could not be read. */
export interface FeedInputs {
  worklog: WorklogReport | null;
  proposalMerges: FeedItem[] | null;
  outbox: string | null;
  guardian: string | null;
}
export interface FeedReaders {
  worklog(hours: number, now: number): Promise<WorklogReport | null>;
  proposalMerges(): Promise<FeedItem[] | null>;
  outbox(): Promise<string | null>;
  guardian(): Promise<string | null>;
}

export const FEED_MAX_WINDOW_MS = 7 * 86_400_000;
export const FEED_QUERY_ERROR = 'Use limit 1 to 1000, since 1m to 7d or an ISO time within 7 days, and kind merged, released, failed, lane, incident or leader.';

/** The CLI and HTTP route accept the same query. `since` is a duration (30m, 6h, 2d) or an ISO time. */
export function parseFeedQuery(input: { limit?: string; since?: string; kind?: string }, now = Date.now()): FeedQuery | null {
  const limit = input.limit ?? '30';
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > FEED_MAX_LIMIT) return null;
  const query: FeedQuery = { limit: Number(limit) };
  if (input.kind !== undefined) {
    if (!(FEED_KINDS as readonly string[]).includes(input.kind)) return null;
    query.kind = input.kind as FeedKind;
  }
  if (input.since === undefined) return query;
  const match = /^([1-9]\d*)(m|h|d)$/.exec(input.since);
  const sinceMs = match ? now - Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd']
    : /^\d{4}-\d{2}-\d{2}T/.test(input.since) ? Date.parse(input.since) : NaN;
  if (!Number.isFinite(sinceMs) || sinceMs > now || now - sinceMs > FEED_MAX_WINDOW_MS) return null;
  return { ...query, sinceMs };
}

/** Feed text repeats across items and requests: each distinct line is scrubbed once, bounded. */
const plainMemo = new Map<string, string>();
const plain = (text: string): string => {
  let out = plainMemo.get(text);
  if (out === undefined) {
    out = scrubSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 400);
    if (plainMemo.size >= 20_000) plainMemo.clear();
    plainMemo.set(text, out);
  }
  return out;
};
const iso = (value: string): string | null => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
/** Per-tick dispatcher chatter that is never news on its own. */
const NOISE = /\b(?:EMPTY_SIGNAL|LOADGATE warn)\b/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const JOB_HREF = '/verse/?pane=worker-log';

/** A lane pausing or running again, in plain words. Null for a hold line about one stopped job, which stays an incident. */
function laneItem(at: string, text: string, count: number): FeedItem | null {
  const hold = /^Lane (hold|released): (.+)$/.exec(text);
  if (!hold || /^stopped /.test(hold[2]!)) return null;
  const rest = hold[2]!;
  const lane = /^(?:(?:placed|released) )?([A-Za-z0-9][A-Za-z0-9._-]{0,39})(?=\s|$)/.exec(rest)?.[1] ?? null;
  const name = lane ? `The ${lane} lane` : 'A lane';
  const what = hold[1] === 'released' ? 'is running again'
    : /^released /.test(rest) ? 'was reset and is running again'
    : /credits exhausted|plan limit|usage limit/i.test(rest) ? 'hit its plan limit and is paused'
    : /autobackoff/.test(rest) ? 'was paused after repeated failures' : 'was paused';
  return { id: `lane:${at}:${rest.slice(0, 80)}`, kind: 'lane', at, text: `${name} ${what}`, detail: plain(rest), href: '/verse/?pane=fleet-lanes',
    repo: null, lane, job: null, count };
}

/** Worklog rows → feed items. Launches and plain finishes are progress, not news, so they are left out. */
function worklogItems(report: WorklogReport): FeedItem[] {
  return report.rows.flatMap((row): FeedItem[] => {
    const at = iso(row.at);
    // A job id or link that looks like a secret drops the row rather than leak it.
    if (!at || (row.job && scrubSecrets(row.job) !== row.job) || (row.url && scrubSecrets(row.url) !== row.url)) return [];
    const base = { at, repo: row.repo, lane: row.lane, job: row.job, count: row.count, detail: null };
    const who = row.job ?? 'A job';
    switch (row.kind) {
      case 'merged': return [{ ...base, kind: 'merged', id: `merged:${row.url ?? `${row.job}:${at}`}`,
        text: plain(`${row.text}${row.repo ? ` in ${row.repo}` : ''}`), href: row.url ?? '/verse/?pane=fleet-merges' }];
      case 'empty': return [{ ...base, kind: 'failed', id: `failed:${row.job}:${at}`, text: plain(`${who} ${lowerFirst(row.text)}`), href: JOB_HREF }];
      case 'leader': return [{ ...base, kind: 'leader', id: `leader:${at}:${row.text.slice(0, 80)}`, text: plain(row.text.replace(/^Leader: /, '')), href: '/verse/?pane=leader-thread' }];
      case 'incident': {
        // The worklog folds failed exits and lane holds into its incident rows; the feed keeps them apart.
        if (/^Failed with exit code/.test(row.text)) return [{ ...base, kind: 'failed', id: `failed:${row.job}:${at}`, text: plain(`${who} ${lowerFirst(row.text)}`), href: JOB_HREF }];
        return [laneItem(at, row.text, row.count) ?? { ...base, kind: 'incident', id: `incident:${at}:${row.text.slice(0, 80)}`, text: plain(row.text), href: '/verse/?pane=fleet-bus' }];
      }
      default: return [];
    }
  });
}

function releaseItems(outbox: string): FeedItem[] {
  // Durable publication announcements, not refresh times or proof of installation.
  return parseOutbox(outbox, 1000).flatMap((notice): FeedItem[] => {
    const release = /(?:^|\n)Release (?:live|published): ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) (\S+)$/.exec(notice.text);
    const at = iso(notice.at);
    if (!release || !at || !validMilestoneTag(release[2]!)) return [];
    return [{ id: `released:${release[1]}@${release[2]}`, kind: 'released', at, text: `Released ${release[1]} ${release[2]}`,
      href: `https://github.com/${release[1]}/releases/tag/${encodeURIComponent(release[2]!)}`, repo: release[1]!, lane: null, job: null, detail: null, count: 1 }];
  });
}

/** Repos whose main is red now, stamped when they went red. Recoveries are not recorded with a time, so they are not shown. */
function mainItems(raw: string): FeedItem[] | null {
  const state = parseGuardianState(raw);
  if (!state) return null;
  return Object.entries(state).flatMap(([repo, entry]): FeedItem[] => {
    const since = typeof entry.red_first === 'string' ? entry.red_first : entry.red_since;
    const at = entry.state === 'red' && typeof since === 'string' ? iso(since) : null;
    if (!at) return [];
    return [{ id: `failed:main:${repo}:${at}`, kind: 'failed', at, text: `Main went red in ${repo}`,
      href: REPO.test(repo) ? `https://github.com/${repo}/commits` : '/verse/?pane=fleet-events', repo, lane: null, job: null, detail: null, count: 1 }];
  });
}

/** Links repeat across items (one pane per kind): each distinct one is scrubbed once, bounded. */
const hrefMemo = new Map<string, boolean>();
function cleanHref(href: string): boolean {
  let clean = hrefMemo.get(href);
  if (clean === undefined) {
    clean = scrubSecrets(href) === href;
    if (hrefMemo.size >= 20_000) hrefMemo.clear();
    hrefMemo.set(href, clean);
  }
  return clean;
}

const hourOf = (item: FeedItem): string => `${item.repo ?? 'unknown'}:${new Date(item.at).toISOString().slice(0, 13)}`;
/** Newest-first items in, the same out, with each burst of merges (one repo, one clock hour) as one card listing them. */
function groupBursts(ordered: FeedItem[], now: number): FeedItem[] {
  const bursts = new Map<string, FeedItem[]>();
  for (const item of ordered) {
    if (item.kind !== 'merged') continue;
    const hour = hourOf(item);
    const burst = bursts.get(hour);
    if (burst) burst.push(item); else bursts.set(hour, [item]);
  }
  return ordered.flatMap((item): FeedItem[] => {
    const burst = item.kind === 'merged' ? bursts.get(hourOf(item))! : [];
    if (burst.length < FEED_BURST_MIN) return [item];
    if (burst[0] !== item) return [];
    const when = now - Date.parse(item.at) < 3_600_000 ? 'in the last hour' : 'within an hour';
    // The hour is part of the id, so a card keeps its identity while more merges join it.
    return [{ id: `merged:burst:${hourOf(item)}`, kind: 'merged', at: item.at, text: `${burst.length} PRs merged in ${item.repo ?? 'an unknown repo'} ${when}`,
      detail: null, href: '/verse/?pane=fleet-merges', repo: item.repo, lane: null, job: null, count: 1,
      group: burst.map(({ text, href, at }) => ({ text, href, at })) }];
  });
}

/** Pure: project, filter, dedupe, order newest first, group bursts, fold identical neighbours, then apply the limit. */
export function buildFeed(inputs: FeedInputs, query: FeedQuery, now: number): FeedReport {
  const main = inputs.guardian === null ? null : mainItems(inputs.guardian);
  const ok = (value: unknown): FeedSourceState => value === null ? 'unknown' : 'available';
  const wl = inputs.worklog;
  const sources: FeedReport['sources'] = {
    jobs: wl && wl.sources.jobs.state === 'ok' ? 'available' : 'unknown',
    events: wl && wl.sources.events.state === 'ok' ? 'available' : 'unknown',
    leader: wl && wl.sources.leader.state === 'ok' ? 'available' : 'unknown',
    merges: ok(inputs.proposalMerges), releases: ok(inputs.outbox), main: ok(main),
  };
  const all = [
    ...(wl ? worklogItems(wl) : []), ...(inputs.proposalMerges ?? []),
    ...(inputs.outbox === null ? [] : releaseItems(inputs.outbox)), ...(main ?? []),
  ];
  const since = query.sinceMs ?? now - FEED_MAX_WINDOW_MS;
  const seen = new Set<string>();
  // Times parsed once per item, not once per comparison.
  const at = new Map(all.map(item => [item, Date.parse(item.at)]));
  const ordered = all
    .filter(item => (!query.kind || item.kind === query.kind) && at.get(item)! >= since && at.get(item)! <= now
      && !NOISE.test(item.text) && cleanHref(item.href))
    .sort((a, b) => at.get(b)! - at.get(a)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)));
  const items: FeedItem[] = [];
  for (const item of groupBursts(ordered, now)) {
    const last = items.at(-1);
    // A notice repeated every tick reads as one card with a count.
    if (last && !last.group && last.kind === item.kind && last.text === item.text) last.count += item.count;
    else items.push({ ...item });
  }
  // One millisecond past the newest event: `since` is inclusive, so this never repeats a card.
  const next = items[0] ? new Date(Date.parse(items[0].at) + 1).toISOString() : query.sinceMs === undefined ? null : new Date(query.sinceMs).toISOString();
  return { schema: FEED_SCHEMA, version: FEED_VERSION, items: items.slice(0, query.limit), more: items.length > query.limit, next, sources };
}

/** The real readers, rooted at the runs dir (ASHLR_RUNS_DIR or ~/.ashlr-runs). */
export function defaultFeedReaders(runsDir = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs')): FeedReaders {
  return {
    worklog: (hours, now) => readWorklog(hours, { runsDir, now }).catch(() => null),
    async proposalMerges() {
      const read = listProposalsDetailed();
      if (!read.complete || read.sourceState === 'degraded') return null;
      return read.proposals.flatMap((proposal): FeedItem[] => {
        const evidence = realizedMergeOf(proposal);
        const at = evidence && iso(evidence.source === 'github-host' ? evidence.mergedAt : evidence.observedAt);
        if (!evidence || !at) return [];
        const href = evidence.source === 'github-host' ? evidence.prUrl : '/verse/?pane=fleet-merges';
        // `proposal.repo` is an absolute path; only its name leaves this machine.
        const repo = proposal.repo ? basename(proposal.repo) : null;
        return [{ id: `merged:${evidence.source === 'github-host' ? href : proposal.id}`, kind: 'merged', at,
          text: plain(`Merged ${proposal.title} in ${repo ?? 'an unknown repo'}`), href, repo, lane: null, job: null, detail: null, count: 1 }];
      });
    },
    async outbox() {
      const read = await readSource(join(runsDir, 'leader', 'MASON-OUTBOX.md'), 256 * 1024, true);
      return read.state === 'healthy' ? read.text : null;
    },
    guardian: () => readFile(join(runsDir, 'guardian', 'state.json'), 'utf8').catch(() => null),
  };
}

/** How long one served Feed answers repeat polls: every open window's badge and pane poll it. */
export const FEED_SHARE_MS = 5_000;
let shared: { key: string; at: number; report: Promise<FeedReport> } | null = null;

/** readFeed with the real readers, shared by every poll of the same query within FEED_SHARE_MS. */
export function readFeedShared(query: FeedQuery, now = Date.now()): Promise<FeedReport> {
  const key = JSON.stringify(query);
  if (shared && shared.key === key && now - shared.at >= 0 && now - shared.at < FEED_SHARE_MS) return shared.report;
  const report = readFeed(query, defaultFeedReaders(), now);
  shared = { key, at: now, report };
  report.catch(() => { if (shared?.report === report) shared = null; });
  return report;
}

export async function readFeed(query: FeedQuery, readers: FeedReaders = defaultFeedReaders(), now = Date.now()): Promise<FeedReport> {
  const hours = (now - (query.sinceMs ?? now - FEED_MAX_WINDOW_MS)) / 3_600_000;
  const settle = <T>(read: () => Promise<T | null>): Promise<T | null> => read().catch(() => null);
  const [worklog, proposalMerges, outbox, guardian] = await Promise.all([
    settle(() => readers.worklog(Math.max(hours, 1 / 60), now)), settle(() => readers.proposalMerges()),
    settle(() => readers.outbox()), settle(() => readers.guardian()),
  ]);
  return buildFeed({ worklog, proposalMerges, outbox, guardian }, query, now);
}
