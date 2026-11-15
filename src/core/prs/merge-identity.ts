/**
 * Merge identity: tell merges by automation apart from manual ones using only
 * what GitHub already records on a merged PR (see docs/MERGE-IDENTITY.md).
 *
 * The PURE half (`classifyMerge`, `summarizeMerges`) takes plain records and
 * never touches the network. `readMerges` is the only gh caller and takes an
 * injected runner so tests stay offline.
 */
import { assertRepo, defaultGh, type Gh } from '../autopilot/github.js';

export type ActorClass = 'automation' | 'human' | 'unknown';

export interface MergeActor {
  login: string;
  /** GraphQL __typename: User, Bot, Mannequin or Organization. */
  type: string;
}

export interface MergeRecord {
  number: number;
  mergedAt: string;
  /** GraphQL `mergedBy`; for a merge queue merge this is the queue bot. */
  mergedBy: MergeActor | null;
  /** Actor of the latest AddedToMergeQueueEvent, when the PR went through the queue. */
  enqueuer: MergeActor | null;
}

export interface ClassifiedMerge {
  number: number;
  mergedAt: string;
  class: ActorClass;
  /** The login the class rests on; null when GitHub recorded none. */
  actor: string | null;
  via: 'merged-by' | 'queue-enqueuer' | 'none';
}

export interface MergeSummary {
  v: 1;
  repo: string;
  since: string;
  until: string | null;
  total: number;
  counts: Record<ActorClass, number>;
  actors: Array<{ login: string; class: ActorClass; count: number }>;
  /** True when the search hit its page cap, so older merges in the window may be missing. */
  truncated: boolean;
}

/** The queue bot is a relay: the person or app that enqueued the PR is the real actor. */
const MERGE_QUEUE_LOGIN = 'github-merge-queue';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** REST reports `name[bot]`, GraphQL reports `name`; compare on the bare name. */
export function bareLogin(login: string): string {
  return login.replace(/\[bot\]$/i, '').toLowerCase();
}

function actorClass(actor: MergeActor, automationLogins: ReadonlySet<string>): ActorClass {
  if (actor.type === 'Bot' || /\[bot\]$/i.test(actor.login)) return 'automation';
  return automationLogins.has(bareLogin(actor.login)) ? 'automation' : 'human';
}

/** Classify one merge (PURE). `automationLogins` are extra non-bot logins to count as automation. */
export function classifyMerge(record: MergeRecord, automationLogins: readonly string[] = []): ClassifiedMerge {
  const extra = new Set(automationLogins.map(bareLogin));
  const base = { number: record.number, mergedAt: record.mergedAt };
  const merger = record.mergedBy;
  if (!merger) return { ...base, class: 'unknown', actor: null, via: 'none' };
  if (bareLogin(merger.login) === MERGE_QUEUE_LOGIN) {
    const enqueuer = record.enqueuer;
    if (!enqueuer) return { ...base, class: 'unknown', actor: null, via: 'none' };
    return { ...base, class: actorClass(enqueuer, extra), actor: enqueuer.login, via: 'queue-enqueuer' };
  }
  return { ...base, class: actorClass(merger, extra), actor: merger.login, via: 'merged-by' };
}

/** Count merges by class and by actor (PURE). Merges outside [since, until) are dropped. */
export function summarizeMerges(
  records: readonly MergeRecord[],
  opts: { repo: string; since: string; until?: string; automationLogins?: readonly string[]; truncated?: boolean },
): MergeSummary {
  const sinceMs = Date.parse(opts.since);
  const untilMs = opts.until ? Date.parse(opts.until) : Infinity;
  const counts: Record<ActorClass, number> = { automation: 0, human: 0, unknown: 0 };
  const byActor = new Map<string, { login: string; class: ActorClass; count: number }>();
  let total = 0;
  for (const record of records) {
    const at = Date.parse(record.mergedAt);
    if (!(at >= sinceMs && at < untilMs)) continue;
    const merge = classifyMerge(record, opts.automationLogins);
    total++;
    counts[merge.class]++;
    if (merge.actor) {
      const key = bareLogin(merge.actor);
      const row = byActor.get(key) ?? { login: merge.actor, class: merge.class, count: 0 };
      row.count++;
      byActor.set(key, row);
    }
  }
  const actors = [...byActor.values()].sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
  return { v: 1, repo: opts.repo, since: opts.since, until: opts.until ?? null, total, counts, actors, truncated: opts.truncated === true };
}

const QUERY = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        mergedAt
        mergedBy { __typename login }
        timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT]) {
          nodes { ... on AddedToMergeQueueEvent { enqueuer { __typename login } } }
        }
      }
    }
  }
}`;

function actorOf(value: unknown): MergeActor | null {
  if (!value || typeof value !== 'object') return null;
  const { login, __typename } = value as Record<string, unknown>;
  return typeof login === 'string' && login ? { login, type: typeof __typename === 'string' ? __typename : '' } : null;
}

/** Parse one GraphQL search node into a record; non-PR and unmerged nodes yield null (PURE). */
export function parseMergeNode(node: unknown): MergeRecord | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (typeof n['number'] !== 'number' || typeof n['mergedAt'] !== 'string') return null;
  const items = (n['timelineItems'] as { nodes?: unknown[] } | undefined)?.nodes ?? [];
  const event = items[0] as Record<string, unknown> | undefined;
  return { number: n['number'], mergedAt: n['mergedAt'], mergedBy: actorOf(n['mergedBy']), enqueuer: actorOf(event?.['enqueuer']) };
}

/** Read merged PRs in a window, read-only (one GraphQL search per page, newest first not guaranteed). */
export async function readMerges(
  repo: string,
  since: string,
  opts: { until?: string; gh?: Gh } = {},
): Promise<{ records: MergeRecord[]; truncated: boolean }> {
  const gh = opts.gh ?? defaultGh;
  const range = opts.until ? `${since}..${opts.until}` : `>=${since}`;
  const q = `repo:${assertRepo(repo)} is:pr is:merged merged:${range}`;
  const records: MergeRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `q=${q}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const parsed = JSON.parse(await gh(args)) as { data?: { search?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: unknown[] } } };
    const search = parsed.data?.search;
    if (!search) throw new Error('GitHub search returned no data.');
    for (const node of search.nodes ?? []) {
      const record = parseMergeNode(node);
      if (record) records.push(record);
    }
    if (!search.pageInfo?.hasNextPage || !search.pageInfo.endCursor) return { records, truncated: false };
    cursor = search.pageInfo.endCursor;
  }
  return { records, truncated: true };
}
