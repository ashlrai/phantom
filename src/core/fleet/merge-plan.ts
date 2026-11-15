/**
 * core/fleet/merge-plan.ts — pure merge-throughput scoreboard and drain plan.
 *
 * One `gh pr list --state all` page answers the five questions the merge
 * treadmill asks separately today: how big is the backlog, how fast does it
 * drain, why are open PRs not landing, which PRs one update-branch refreshes,
 * and which open PRs a newer open attempt already replaces. The existing
 * verbs keep their own contracts — `fleet merge-batch` plans the order,
 * `fleet behind-sweep`/merge-drain runs the updates, `fleet
 * superseded-close` runs closes — this report only measures and proposes.
 *
 * SUPERSEDED-BY-OPEN. A PR is a close candidate when another OPEN PR is
 * evidence it replaces it: rework job ids (`bridge: RQ-FIX-<short>-<n>`,
 * `RQ-REBASE-<short>-<n>[-<head7>]`, `RQ-REBASE-BATCH-<short>-<members>-<h6>`,
 * `RQ-RECUT-<short>-<n>-<head7>` — the same grammars rebase-plan and
 * queuegen write) or an explicit supersession claim in the body
 * (`Supersedes #n`, `superseded by #n`, `recut/rework/rebase/recovery of
 * PR #n`, `handoff: PR #n`). Incidental `pull/` or `#n` mentions never count.
 * Edges form families; the highest-numbered member is the proposed landing
 * PR, every other member is proposed for close with a one-line reason naming
 * that replacement. A draft PR never supersedes (it cannot land). A
 * reference to a closed or absent number is a different verb's evidence
 * (superseded-close, landed-close) and only counts as `closed_origin_refs`.
 *
 * HONESTY. Missing evidence stays unknown: no `state` column means every row
 * is open (a plain `gh pr list` page), no `mergeStateStatus` column leaves
 * the state histogram and rebase candidates unknown rather than zero, and a
 * truncated merged page only ever understates merges_per_hour —
 * `oldest_merge_observed` exposes the page's real coverage.
 *
 * READ-ONLY and PURE: no I/O, no gh, no clock; the caller supplies `now`.
 */
import {
  MAX_FILES_PER_PR,
  MAX_PRS,
  type MergeBatchPr,
} from './merge-batch.js';
import { parsePrHygieneOpenPr } from './pr-hygiene.js';
import { scrubSecrets } from '../util/scrub.js';

export const MERGE_PLAN_SCHEMA = 'fleet.merge-plan.v1' as const;

const MAX_TEXT_CHARS = 200;
const MAX_BODY_CHARS = 8_000;
const MAX_CHECK_ROWS = 64;
const MAX_PROPOSALS = 100;
const MAX_OLDEST = 8;
const MAX_CAUSE_EXAMPLES = 8;

const iso = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

const bounded = (value: unknown, max = MAX_TEXT_CHARS): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MergePlanState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface MergePlanCheck {
  name: string;
  /** Check conclusion/state, upper-cased (SUCCESS, FAILURE, QUEUED, NEUTRAL, …). */
  conclusion: string;
}

/**
 * One PR row the scoreboard can reason about (bounded, normalized fields).
 * `url` rides along from parsePrHygieneOpenPr on gh rows but is never read.
 */
export interface MergePlanPr extends MergeBatchPr {
  /** Partition: merged when mergedAt or state MERGED, closed otherwise, open otherwise. */
  state: MergePlanState;
  mergedAt: string | null;
  closedAt: string | null;
  /** First bytes of the body, for supersession claims only. Never emitted. */
  body: string;
  /** Whether the row carried a body at all — absent body evidence stays unknown. */
  hasBody: boolean;
  /** Failed/non-passing check names stay rows in checks_failing. */
  checks: MergePlanCheck[];
  /** Auto-merge request armed (gh `autoMergeRequest`), null when the column is absent. */
  autoMerge: boolean | null;
}

export interface MergePlanParseOk {
  ok: true;
  kind: 'gh-pr-list' | 'merge-backlog' | 'pr-hygiene';
  repo: string | null;
  upstream: string;
  prs: MergePlanPr[];
  /** Rows that did not describe a PR at all. */
  unreadable: number;
  /** Rows repeating an already-seen PR number (first sighting wins). */
  duplicates: number;
  /** True when at least one row carried mergeStateStatus evidence. */
  hasStateEvidence: boolean;
  /** True when at least one row carried a body column. */
  hasBodyEvidence: boolean;
}
export type MergePlanParse = MergePlanParseOk | { ok: false; reason: string };

const CHECK_FAILURE = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function checkRows(value: unknown): MergePlanCheck[] {
  if (!Array.isArray(value)) return [];
  const out: MergePlanCheck[] = [];
  for (const entry of value.slice(0, MAX_CHECK_ROWS)) {
    if (!isRecord(entry)) continue;
    const name = bounded(entry['name'] ?? entry['context'], 120);
    const conclusion = bounded(entry['conclusion'] ?? entry['state'], 30).toUpperCase();
    if (name && conclusion) out.push({ name, conclusion });
  }
  return out;
}

const sha = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value : null;

const autoMergeOf = (value: unknown): boolean | null => {
  if (!isRecord(value)) return null;
  const req = value['autoMergeRequest'];
  if (req === undefined) return null;
  return req !== null;
};

/** File list from either wire form — `[{path}]` gh rows or `["a/b.ts"]` report items. */
function fileList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const file of value.slice(0, MAX_FILES_PER_PR)) {
    if (typeof file === 'string') { out.push(file.slice(0, 400)); continue; }
    if (isRecord(file) && typeof file['path'] === 'string') out.push((file['path'] as string).slice(0, 400));
  }
  return out;
}

function ghRowToPr(row: unknown): MergePlanPr | null {
  const base = parsePrHygieneOpenPr(row);
  if (base === null || !isRecord(row)) return null;
  const mergedAt = iso(row['mergedAt'] ?? row['merged_at']);
  const closedAt = iso(row['closedAt'] ?? row['closed_at']);
  const stateRaw = bounded(row['state'], 12).toUpperCase();
  const state: MergePlanState = mergedAt !== null || stateRaw === 'MERGED'
    ? 'MERGED'
    : stateRaw === 'CLOSED' || closedAt !== null ? 'CLOSED' : 'OPEN';
  const body = row['body'];
  return {
    ...base,
    headSha: sha(row['headRefOid'] ?? row['headSha']),
    state, mergedAt, closedAt,
    body: bounded(body, MAX_BODY_CHARS),
    hasBody: typeof body === 'string' && body.length > 0,
    checks: checkRows(row['statusCheckRollup'] ?? row['statusCheckRollupNodes']),
    autoMerge: autoMergeOf(row),
  };
}

/** A merge-backlog / pr-hygiene item describes an open PR only. */
function itemToPr(row: unknown): MergePlanPr | null {
  if (!isRecord(row)) return null;
  const number = row['number'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  const mergeStateStatus = bounded(row['mergeStateStatus'], 40).toUpperCase() || 'UNKNOWN';
  const flaggedConflicted = Array.isArray(row['flags']) && row['flags'].includes('conflicted');
  return {
    number: number as number,
    title: bounded(row['title']),
    headRef: bounded(row['headRef'] ?? row['headRefName']),
    headSha: sha(row['headSha'] ?? row['headRefOid']),
    isDraft: row['isDraft'] === true,
    mergeable: flaggedConflicted || mergeStateStatus === 'DIRTY' ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus,
    createdAt: iso(row['createdAt']),
    updatedAt: iso(row['updatedAt']),
    files: fileList(row['files']),
    state: 'OPEN',
    mergedAt: null, closedAt: null,
    body: '', hasBody: false,
    checks: checkRows(row['statusCheckRollup']),
    autoMerge: null,
  };
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const repoName = (value: unknown): string | null =>
  typeof value === 'string' && REPO_RE.test(value) ? value : null;

/**
 * The same three wire shapes `fleet merge-batch` accepts: a raw `gh pr list`
 * array (any --state; `body`, `statusCheckRollup`, `autoMergeRequest`,
 * `mergedAt`, `closedAt` columns feed the extra sections), a merge-backlog
 * read, or a fleet.pr-hygiene.v1 report. Envelope items describe open PRs
 * only — throughput and body sections stay unknown for them.
 */
export function parseMergePlanPrs(raw: unknown): MergePlanParse {
  let rows: unknown[];
  let kind: MergePlanParseOk['kind'];
  let repo: string | null = null;
  let upstream = 'ok';
  let rowToPr: (row: unknown) => MergePlanPr | null;
  if (Array.isArray(raw)) {
    rows = raw;
    kind = 'gh-pr-list';
    rowToPr = ghRowToPr;
  } else if (isRecord(raw) && Array.isArray(raw['items'])) {
    rows = raw['items'] as unknown[];
    kind = raw['schema'] === 'fleet.pr-hygiene.v1' ? 'pr-hygiene' : 'merge-backlog';
    repo = repoName(raw['repo']);
    if (kind === 'pr-hygiene' && isRecord(raw['reads']) && typeof raw['reads']['open'] === 'string') {
      upstream = raw['reads']['open'];
    } else if (typeof raw['source'] === 'string') {
      upstream = raw['source'];
    }
    rowToPr = itemToPr;
  } else {
    return { ok: false, reason: 'input is neither a gh pr list array nor a {items:[…]} report' };
  }
  const seen = new Set<number>();
  const prs: MergePlanPr[] = [];
  let unreadable = 0;
  let duplicates = 0;
  for (const row of rows.slice(0, MAX_PRS)) {
    const pr = rowToPr(row);
    if (pr === null) { unreadable += 1; continue; }
    if (seen.has(pr.number)) { duplicates += 1; continue; }
    seen.add(pr.number);
    prs.push(pr);
  }
  return {
    ok: true, kind, repo, upstream, prs, unreadable, duplicates,
    hasStateEvidence: prs.some(pr => pr.mergeStateStatus !== 'UNKNOWN'),
    hasBodyEvidence: prs.some(pr => pr.hasBody),
  };
}

// ---------------------------------------------------------------------------
// Superseded-by-open detection
// ---------------------------------------------------------------------------

export type ReworkEvidence =
  | 'title-fix' | 'title-rebase' | 'title-recut' | 'title-rebase-batch'
  | 'body-supersedes' | 'body-superseded-by' | 'body-rework' | 'body-handoff';

export interface ReworkEdge {
  /** The open PR carrying the evidence. */
  reworker: number;
  /** The open PR it replaces. */
  origin: number;
  evidence: ReworkEvidence;
}

export type SupersededKind = 'origin' | 'stale-rework';

export interface SupersededProposal {
  number: number;
  /** Bounded and secret-scrubbed — a title is untrusted text. */
  title: string;
  /** The open PR proposed to land instead. */
  supersededBy: number;
  kind: SupersededKind;
  /** The one-line close reason, naming the replacement. */
  reason: string;
  evidence: ReworkEvidence[];
}

const shortName = (repo: string): string => repo.split('/').pop() ?? repo;
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BRIDGE = /^bridge:\s*/i;

/**
 * Title grammars naming the PR an open rework PR replaces. `repo` anchors the
 * `<short>` segment (repo short name, case-insensitive); a null repo accepts
 * every short name — rows already share the snapshot's repo.
 */
function titleOrigins(title: string, repo: string | null): { origin: number; evidence: ReworkEvidence }[] {
  const id = title.replace(BRIDGE, '').trim();
  const anchor = repo === null ? '[A-Za-z0-9._-]+' : escapeRe(shortName(repo));
  const out: { origin: number; evidence: ReworkEvidence }[] = [];
  const fix = new RegExp(`^RQ-FIX-${anchor}-(\\d{1,7})$`, 'i').exec(id);
  if (fix) out.push({ origin: Number(fix[1]), evidence: 'title-fix' });
  const recut = new RegExp(`^RQ-RECUT-${anchor}-(\\d{1,7})-[0-9a-f]{7}$`, 'i').exec(id);
  if (recut) out.push({ origin: Number(recut[1]), evidence: 'title-recut' });
  const batch = new RegExp(`^RQ-REBASE-BATCH-${anchor}-((?:\\d{1,7}-)+\\d{1,7})-[0-9a-f]{6}$`, 'i').exec(id);
  if (batch) {
    for (const member of batch[1]!.split('-')) out.push({ origin: Number(member), evidence: 'title-rebase-batch' });
    return out;
  }
  const rebase = new RegExp(`^RQ-REBASE-${anchor}-(\\d{1,7})(?:-[0-9a-f]{7})?$`, 'i').exec(id);
  if (rebase) out.push({ origin: Number(rebase[1]), evidence: 'title-rebase' });
  return out;
}

/**
 * Explicit supersession claims in a body — the phrases recut/fix bridge PRs
 * actually write ("Supersedes #4588", "recut handoff: PR #3711", "recovery of
 * ashlrai/phantom PR #4348"). Plain `pull/`, `#` and `PR #n` mentions never
 * count: they are as often fetch refs and overlap notes as claims.
 * `direction: 'origin'` — the named PR is what this PR replaces (the common
 * case). `direction: 'reworker'` — the PR claims it is itself replaced
 * ("superseded by #N"), so the named PR is the newer attempt.
 */
function bodyClaims(body: string): { number: number; direction: 'origin' | 'reworker'; evidence: ReworkEvidence }[] {
  const out: { number: number; direction: 'origin' | 'reworker'; evidence: ReworkEvidence }[] = [];
  for (const m of body.matchAll(/\b[Ss]upersedes\s+#(\d{1,7})\b/g)) {
    out.push({ number: Number(m[1]), direction: 'origin', evidence: 'body-supersedes' });
  }
  for (const m of body.matchAll(/\b[Ss]uperseded\s+by\s+#(\d{1,7})\b/g)) {
    out.push({ number: Number(m[1]), direction: 'reworker', evidence: 'body-superseded-by' });
  }
  const rework = /\b(?:[Rr]ecut|[Rr]ework|[Rr]ebase|[Rr]eplaces?|[Rr]ecovery|[Hh]andoff)\b[^\n]{0,80}?\bPR\s+#(\d{1,7})\b/g;
  for (const m of body.matchAll(rework)) {
    const evidence: ReworkEvidence = /handoff/i.test(m[0].slice(0, 20)) ? 'body-handoff' : 'body-rework';
    out.push({ number: Number(m[1]), direction: 'origin', evidence });
  }
  return out;
}

/**
 * Rework edges among OPEN PRs only. A draft reworker carries no evidence — it
 * cannot land. `closedRefs` counts edges whose origin left the open set (a
 * different verb's evidence, never planned here).
 */
export function reworkEdges(prs: readonly MergePlanPr[], repo: string | null): { edges: ReworkEdge[]; closedRefs: number } {
  const open = new Set(prs.map(pr => pr.number));
  const edges: ReworkEdge[] = [];
  let closedRefs = 0;
  for (const pr of prs) {
    if (pr.isDraft) continue;
    for (const found of titleOrigins(pr.title, repo)) {
      if (found.origin === pr.number) continue;
      if (open.has(found.origin)) edges.push({ reworker: pr.number, origin: found.origin, evidence: found.evidence });
      else closedRefs += 1;
    }
    for (const claim of bodyClaims(pr.body)) {
      const edge = claim.direction === 'origin'
        ? { reworker: pr.number, origin: claim.number, evidence: claim.evidence }
        : { reworker: claim.number, origin: pr.number, evidence: claim.evidence };
      if (edge.reworker === edge.origin) continue;
      // The named side must be an open row; a reworker not in the snapshot
      // cannot land and never supersedes.
      if (!open.has(edge.reworker) || !open.has(edge.origin)) { closedRefs += 1; continue; }
      edges.push(edge);
    }
  }
  return { edges, closedRefs };
}

/**
 * Edge components → close proposals. Union-find joins reworker→origin edges
 * into families (a rebase of a rebase is one family); the highest-numbered
 * member is the proposed landing PR and every other member is proposed for
 * close with the replacement named — mirroring reworkSuperseded's
 * newest-wins rule for same-origin reworks, except that a member which
 * itself declared "superseded by #n" can never win (its own text says it
 * loses). Bounded to MAX_PROPOSALS rows; `truncated` carries the overflow.
 */
export function supersededOpenPrs(
  prs: readonly MergePlanPr[],
  repo: string | null,
): { proposals: SupersededProposal[]; families: number; edges: number; closedRefs: number; truncated: number } {
  const { edges, closedRefs } = reworkEdges(prs, repo);
  const parent = new Map<number, number>();
  const find = (n: number): number => {
    let root = n;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(n, root);
    return root;
  };
  for (const edge of edges) {
    for (const n of [edge.reworker, edge.origin]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(edge.reworker), find(edge.origin));
  }
  const families = new Map<number, Set<number>>();
  for (const n of parent.keys()) {
    const root = find(n);
    families.set(root, new Set([...(families.get(root) ?? []), n]));
  }
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const edgeEvidence = new Map<number, Set<ReworkEvidence>>();
  /** An origin of a 'superseded by #n' edge declared its own replacement. */
  const selfDeclared = new Set<number>();
  const reworkers = new Set<number>();
  for (const e of edges) {
    reworkers.add(e.reworker);
    if (e.evidence === 'body-superseded-by') selfDeclared.add(e.origin);
    for (const n of [e.reworker, e.origin]) {
      edgeEvidence.set(n, new Set([...(edgeEvidence.get(n) ?? []), e.evidence]));
    }
  }
  const proposals: SupersededProposal[] = [];
  let truncated = 0;
  for (const members of families.values()) {
    const eligible = [...members].filter(n => !selfDeclared.has(n));
    const winner = Math.max(...(eligible.length > 0 ? eligible : [...members]));
    for (const member of members) {
      if (member === winner) continue;
      const pr = byNumber.get(member);
      if (!pr) continue;
      const kind: SupersededKind = reworkers.has(member) ? 'stale-rework' : 'origin';
      const reason = kind === 'origin'
        ? `Superseded by #${winner}, the open rework PR that replaces this one.`
        : `Superseded by #${winner}, the newer open rework of the same origin.`;
      if (proposals.length >= MAX_PROPOSALS) { truncated += 1; continue; }
      proposals.push({
        number: member,
        title: scrubSecrets(pr.title.slice(0, MAX_TEXT_CHARS)),
        supersededBy: winner,
        kind,
        reason,
        evidence: [...(edgeEvidence.get(member) ?? [])].sort(),
      });
    }
  }
  proposals.sort((a, b) => a.number - b.number);
  return { proposals, families: families.size, edges: edges.length, closedRefs, truncated };
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

export interface MergePlanStats { n: number; p50: number; p90: number; max: number }

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;

function summaryStats(values: number[]): MergePlanStats | null {
  const known = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { n: known.length, p50: round(percentile(known, 50)), p90: round(percentile(known, 90)), max: round(known[known.length - 1]!) };
}

export interface FailureCause {
  cause: string;
  prs: number;
  examples: number[];
}

/**
 * Why open PRs are not landing, ranked. A PR lands in every cause it
 * evidences; a missing mergeStateStatus lands only in 'unknown-state'.
 * `check-failure` covers any failed rollup row and `check-failure:<name>`
 * names the check — the merge-queue failure causes a scheduler can act on.
 */
export function failureCauses(prs: readonly MergePlanPr[]): { causes: FailureCause[]; checks: FailureCause[] } {
  const byCause = new Map<string, number[]>();
  const byCheck = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, pr: number) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(pr);
  };
  for (const pr of prs) {
    if (pr.isDraft) add(byCause, 'draft', pr.number);
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') add(byCause, 'conflict', pr.number);
    if (pr.mergeStateStatus === 'BEHIND') add(byCause, 'behind', pr.number);
    if (pr.mergeStateStatus === 'BLOCKED') add(byCause, 'blocked', pr.number);
    if (pr.mergeStateStatus === 'UNSTABLE') add(byCause, 'unstable-checks', pr.number);
    let failed = false;
    for (const check of pr.checks) {
      if (!CHECK_FAILURE.has(check.conclusion)) continue;
      failed = true;
      add(byCheck, check.name, pr.number);
    }
    if (failed) add(byCause, 'check-failure', pr.number);
    if (pr.mergeStateStatus === 'UNKNOWN' && pr.mergeable === 'UNKNOWN') add(byCause, 'unknown-state', pr.number);
  }
  const rank = (map: Map<string, number[]>, prefix?: string): FailureCause[] =>
    [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([name, list]) => ({
        cause: prefix === undefined ? name : `${prefix}${name}`,
        prs: list.length,
        examples: [...new Set(list)].sort((x, y) => x - y).slice(0, MAX_CAUSE_EXAMPLES),
      }));
  return { causes: rank(byCause), checks: rank(byCheck, 'check-failure:') };
}

export interface MergePlanOptions {
  /** Owner/name hint when the snapshot itself carries none. */
  repo?: string | null;
  /** Window for merges/closes rates; default 24. */
  hours?: number;
  /** Cap on bounded member lists (oldest, rebase candidates); default 10, max 50. */
  top?: number;
  now?: Date;
  /**
   * The caller's `planSupersededClose` result (merged-job prompts read).
   * Absent means prompts were not read → 'no-prompts' when merged rows exist.
   */
  mergedClose?: { prs: number[] };
}

export interface MergePlanReport {
  schema: typeof MERGE_PLAN_SCHEMA;
  v: 1;
  repo: string | null;
  generatedAt: string;
  window_hours: number;
  counts: {
    rows: number;
    open: number;
    merged_rows: number;
    closed_rows: number;
    drafts: number;
    unreadable: number;
    duplicate_rows: number;
  };
  /**
   * Null when the snapshot carries no merged/closed rows at all — a plain
   * open-PR page cannot measure a rate. `oldest_merge_observed` exposes how
   * far back the merged page really reaches.
   */
  throughput: {
    merges_in_window: number;
    merges_per_hour: number;
    closes_in_window: number;
    closes_per_hour: number;
    ttm_minutes: MergePlanStats | null;
    oldest_merge_observed: string | null;
  } | null;
  open: {
    states: Record<string, number>;
    /** 'unknown' when no row carried mergeStateStatus evidence. */
    states_evidence: 'ok' | 'unknown';
    age_hours: MergePlanStats | null;
    oldest: { number: number; title: string; age_hours: number }[];
  };
  failure_causes: FailureCause[];
  checks_failing: FailureCause[];
  duplicates: {
    state: 'ok' | 'no-body-evidence';
    edges: number;
    families: number;
    /** Edges to numbers outside the open set (other verbs' evidence). */
    closed_origin_refs: number;
    proposals: SupersededProposal[];
    truncated: number;
  };
  actions: {
    /** Open, non-draft, BEHIND and not conflicting — update-branch candidates. */
    rebase_candidates: { state: 'ok' | 'unknown'; count: number; prs: { number: number; auto_merge: boolean | null }[] };
    /** Filled by the caller from planMergeBatches on the same rows. */
    batch_plan: { batches: number; independent: number; serial: number; overlap_edges: number; expected_rebases: number } | null;
    superseded_open: number;
    /** Filled by the caller when merged rows and job prompts are available. */
    superseded_merged: { state: 'ok' | 'no-prompts' | 'no-merged-rows'; count: number; prs: number[] };
  };
}

export function planMergePlan(parsed: MergePlanParseOk, opts: MergePlanOptions = {}): MergePlanReport {
  const now = opts.now ?? new Date();
  const hours = opts.hours ?? 24;
  const top = Math.max(1, Math.min(opts.top ?? 10, 50));
  const repo = parsed.repo ?? opts.repo ?? null;
  const open = parsed.prs.filter(pr => pr.state === 'OPEN');
  const merged = parsed.prs.filter(pr => pr.state === 'MERGED');
  const closed = parsed.prs.filter(pr => pr.state === 'CLOSED');
  const since = now.getTime() - hours * 3_600_000;
  const inWindow = (at: string | null) => at !== null && Date.parse(at) >= since && Date.parse(at) <= now.getTime();

  const windowedMerges = merged.filter(pr => inWindow(pr.mergedAt));
  const windowedCloses = closed.filter(pr => inWindow(pr.closedAt));
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const mergedTimes = merged.flatMap(pr => pr.mergedAt === null ? [] : [pr.mergedAt]).sort();
  const throughput: MergePlanReport['throughput'] = merged.length === 0 && closed.length === 0
    ? null
    : {
      merges_in_window: windowedMerges.length,
      merges_per_hour: round2(windowedMerges.length / hours),
      closes_in_window: windowedCloses.length,
      closes_per_hour: round2(windowedCloses.length / hours),
      ttm_minutes: summaryStats(windowedMerges.flatMap(pr => {
        if (pr.createdAt === null || pr.mergedAt === null) return [];
        return [(Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 60_000];
      })),
      oldest_merge_observed: mergedTimes[0] ?? null,
    };

  const states: Record<string, number> = {};
  for (const pr of open) states[pr.mergeStateStatus] = (states[pr.mergeStateStatus] ?? 0) + 1;
  const ages = open.flatMap(pr => pr.createdAt === null ? [] : [(now.getTime() - Date.parse(pr.createdAt)) / 3_600_000]);
  const oldest = open
    .filter(pr => pr.createdAt !== null)
    .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))
    .slice(0, Math.min(top, MAX_OLDEST))
    .map(pr => ({
      number: pr.number,
      title: scrubSecrets(pr.title.slice(0, MAX_TEXT_CHARS)),
      age_hours: Math.round((now.getTime() - Date.parse(pr.createdAt!)) / 36_000) / 10,
    }));

  const { causes, checks } = failureCauses(open);
  const superseded = supersededOpenPrs(open, repo);

  const behind = open
    .filter(pr => !pr.isDraft && pr.mergeStateStatus === 'BEHIND' && pr.mergeable !== 'CONFLICTING')
    .sort((a, b) => a.number - b.number);
  const rebaseCandidates = !parsed.hasStateEvidence
    ? { state: 'unknown' as const, count: 0, prs: [] as { number: number; auto_merge: boolean | null }[] }
    : {
      state: 'ok' as const,
      count: behind.length,
      prs: behind.slice(0, MAX_PROPOSALS).map(pr => ({ number: pr.number, auto_merge: pr.autoMerge })),
    };

  const supersededByMerged: MergePlanReport['actions']['superseded_merged'] = merged.length === 0
    ? { state: 'no-merged-rows', count: 0, prs: [] }
    : opts.mergedClose === undefined
      ? { state: 'no-prompts', count: 0, prs: [] }
      : { state: 'ok', count: opts.mergedClose.prs.length, prs: opts.mergedClose.prs };

  return {
    schema: MERGE_PLAN_SCHEMA,
    v: 1,
    repo,
    generatedAt: now.toISOString(),
    window_hours: hours,
    counts: {
      rows: parsed.prs.length,
      open: open.length,
      merged_rows: merged.length,
      closed_rows: closed.length,
      drafts: open.filter(pr => pr.isDraft).length,
      unreadable: parsed.unreadable,
      duplicate_rows: parsed.duplicates,
    },
    throughput,
    open: {
      states,
      states_evidence: parsed.hasStateEvidence ? 'ok' : 'unknown',
      age_hours: summaryStats(ages),
      oldest,
    },
    failure_causes: causes,
    checks_failing: checks.slice(0, top),
    duplicates: {
      state: parsed.hasBodyEvidence ? 'ok' : 'no-body-evidence',
      edges: superseded.edges,
      families: superseded.families,
      closed_origin_refs: superseded.closedRefs,
      proposals: superseded.proposals,
      truncated: superseded.truncated,
    },
    actions: {
      rebase_candidates: rebaseCandidates,
      batch_plan: null,
      superseded_open: superseded.proposals.length + superseded.truncated,
      superseded_merged: supersededByMerged,
    },
  };
}

// ---------------------------------------------------------------------------
// Before/after
// ---------------------------------------------------------------------------

export interface MergePlanDelta {
  previous_generatedAt: string;
  open: number | null;
  merged_rows: number | null;
  merges_per_hour: number | null;
  ttm_p50_minutes: number | null;
  superseded_open: number | null;
}

/** Before/after deltas between two merge-plan reports; missing sides stay null. */
export function diffMergePlans(previous: unknown, current: MergePlanReport): MergePlanDelta | null {
  if (!isRecord(previous) || previous['schema'] !== MERGE_PLAN_SCHEMA) return null;
  const prevCounts = isRecord(previous['counts']) ? previous['counts'] : {};
  const prevThroughput = isRecord(previous['throughput']) ? previous['throughput'] : null;
  const prevTtm = prevThroughput !== null && isRecord(prevThroughput['ttm_minutes']) ? prevThroughput['ttm_minutes'] : null;
  const prevActions = isRecord(previous['actions']) ? previous['actions'] : {};
  const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? Math.round((b - a) * 100) / 100 : null);
  return {
    previous_generatedAt: bounded(previous['generatedAt'], 40),
    open: diff(num(prevCounts['open']), current.counts.open),
    merged_rows: diff(num(prevCounts['merged_rows']), current.counts.merged_rows),
    merges_per_hour: diff(prevThroughput === null ? null : num(prevThroughput['merges_per_hour']), current.throughput?.merges_per_hour ?? null),
    ttm_p50_minutes: diff(prevTtm === null ? null : num(prevTtm['p50']), current.throughput?.ttm_minutes?.p50 ?? null),
    superseded_open: diff(num(prevActions['superseded_open']), current.actions.superseded_open),
  };
}
