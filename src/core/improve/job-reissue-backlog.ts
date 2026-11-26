/**
 * Job-reissue audit journal recurring cells → self-improvement backlog items.
 *
 * `reissueJob` (src/core/fleet/job-reissue.ts) is the fleet's resurrection
 * path: an operator or agent looking at failed outcomes re-queues a dead
 * job's prompt under a fresh `RQ-PHX-<stem>R<n>` id through the verse
 * outcomes `fleet-reissue` endpoint, and every written reissue appends one
 * audit row — `{at, from, to, lane, tier, file}` — to
 * <runsDir>/queue/job-reissues.jsonl. Until now the journal's only reader
 * was the audit itself: nothing folded it, so work that keeps dying and
 * needing manual resurrection never became backlog items. A single reissue
 * is a normal recovery; the recurring shapes are what this feed carries:
 *
 *  - a job family reissued again and again — the same work keeps failing
 *    or stalling whatever lane it lands on, so the job spec, its prompt,
 *    or the detection gap that let it die silently is the thing to fix;
 *  - many distinct families reissued on one lane — a lane-level signal
 *    (capacity, auth, quota, dispatch) rather than one bad job.
 *
 * jobReissueBacklogItems carries both cells into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue them
 * exactly like the lost-launch, stuck-job, stray-stop and sibling
 * runs-dir sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *  - The writer's tolerance. The audit appends one JSON line per written
 *    reissue; a crash-torn tail line or a foreign row shape is skipped,
 *    never parsed into evidence — every consumed row is fully validated
 *    (parseable `at`, the `RQ-PHX-` source id shape the writer enforces),
 *    so evidence can only under-count, never invent a reissue.
 *  - Recurring means recorded and current. A family cell emits only at
 *    JOB_REISSUE_MIN_ROWS contributing rows inside the window; a lane
 *    cell only at JOB_REISSUE_MIN_FAMILIES distinct families — one
 *    resurrected job or one busy afternoon never queues a session.
 *  - Family identity is exact, not stem-guessed. `from`/`to` pairs are
 *    unioned into connected components, so a reissue-of-a-reissue joins
 *    its family while an unrelated id that merely ends in `R<n>` never
 *    does. Rows whose `to` is absent or malformed still count under
 *    their `from` component — the reissue was written either way.
 *  - Repo attribution is the fleet rule. The audit row records lane,
 *    tier and file but no repository — the journal describes this
 *    install's reissue machinery, so items emit only when the backlog
 *    target's repository name is 'phantom' (the last-segment rule the
 *    sibling fleet-evidence sources apply).
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    family's member ids, or the lane label — never the counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, ids must match the drop-job id shape before they
 *    are quoted, recorded lane/tier labels are scrubbed and flattened,
 *    the prompt names the journal path and writer, and the brief carries
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; family and lane cells are bounded by id and lane diversity. */
export const JOB_REISSUE_MAX_ITEMS = 8;
const JOB_REISSUE_ITEM_HARD_MAX = 25;
/** Reissue rows one family needs inside the window before it counts as recurring. */
export const JOB_REISSUE_MIN_ROWS = 3;
/** Distinct families one lane needs inside the window before it counts as recurring. */
export const JOB_REISSUE_MIN_FAMILIES = 3;
/** Reissues are rare manual/API events; a week gives recurring patterns room without letting stale ones linger. */
export const JOB_REISSUE_WINDOW_HOURS = 168;
/** Bounded tail of the audit journal — reissue volume is tiny; this is generous. */
const JOB_REISSUE_TAIL_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/tier strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_LANE_CHARS = 60;
const MAX_TIER_CHARS = 40;
/** Distinct lane/tier tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 5;
/** The fleet's own repository label: reissue evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The source-id shape reissueJob enforces on its input (`RQ-PHX-<id>`). */
const REISSUE_FROM = /^RQ-PHX-[A-Z0-9]{3,40}$/;
/** The bare id shape writeDropJob accepts (`<id>` after the prefix). */
const REISSUE_TO = /^[A-Z0-9]{3,40}$/;
/** Any id safe to quote into a prompt: drop-job ids plus the RQ-PHX- prefix form. */
const SAFE_QUOTE_ID = /^RQ-PHX-[A-Z0-9-]{3,60}$|^[A-Z0-9][A-Z0-9-]{2,60}$/;

export interface JobReissueItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/job-reissues.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default JOB_REISSUE_WINDOW_HOURS). */
  sinceHours?: number;
  /** Most items one call emits (default JOB_REISSUE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated audit row: a recorded reissue write. */
export interface JobReissueRow {
  atMs: number;
  atIso: string;
  /** Normalized bare source id (prefix stripped), e.g. EXAMPLE31 or EXAMPLE31R1. */
  from: string;
  /** Normalized bare resurrection id when recorded and well-formed; null otherwise. */
  to: string | null;
  lane: string | null;
  tier: string | null;
  /** Basename of the recorded drop file when it matches the safe shape; null otherwise. */
  file: string | null;
}

export interface JobReissueTally {
  /** Sanitized recorded text. */
  text: string;
  count: number;
}

/** One recurring job family: the connected component of from→to reissue edges. */
export interface JobReissueFamilyCell {
  kind: 'chain';
  /** Representative bare id for prompts and the item id: the family's original source prompt (a member no row names as a `to`), else the smallest member. Stable as the family grows. */
  label: string;
  /** Every member bare id, sorted — quoted as evidence inside the prompt. */
  members: string[];
  /** Recorded reissue rows inside the window. */
  rows: number;
  /** Distinct source prompt ids (`from` values) recorded. */
  fromCount: number;
  /** Distinct resurrection ids (`to` values) recorded. */
  toCount: number;
  /** Bounded example source prompt ids. */
  froms: string[];
  /** Bounded example resurrection ids. */
  tos: string[];
  lanes: JobReissueTally[];
  tiers: JobReissueTally[];
  firstSeen: string | null;
  lastSeen: string | null;
}

/** One recurring lane cell: distinct families reissued on the same recorded lane. */
export interface JobReissueLaneCell {
  kind: 'lane';
  /** Sanitized recorded lane label, or 'unknown' when rows recorded none. */
  lane: string;
  /** Distinct job families with at least one in-window reissue on this lane. */
  families: number;
  /** Total in-window reissue rows on this lane. */
  rows: number;
  tiers: JobReissueTally[];
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface JobReissueCells {
  chains: JobReissueFamilyCell[];
  lanes: JobReissueLaneCell[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const bareId = (id: string): string => id.startsWith('RQ-PHX-') ? id.slice('RQ-PHX-'.length) : id;

/** Basename of the recorded drop path when it is a safe drop-job file name; else null. */
function safeFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const base = value.split(/[\\/]/).pop() ?? '';
  return /^RQ-PHX-[A-Z0-9]{3,40}\.md$/.test(base) ? base : null;
}

/**
 * One audit row, or null when it is not reissue evidence this fold consumes.
 * `at` and `from` are required — without them the row cannot be placed in
 * the window or attributed to a family. `to`, `lane`, `tier` and `file`
 * degrade to null rather than disqualifying the row.
 */
export function parseJobReissueRow(value: unknown): JobReissueRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const at = row['at'];
  const from = row['from'];
  if (typeof at !== 'string' || typeof from !== 'string' || !REISSUE_FROM.test(from)) return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const to = row['to'];
  return {
    atMs,
    atIso: at,
    from: bareId(from),
    to: typeof to === 'string' && REISSUE_TO.test(to) ? to : null,
    lane: typeof row['lane'] === 'string' && row['lane'].trim() !== '' ? row['lane'] : null,
    tier: typeof row['tier'] === 'string' && row['tier'].trim() !== '' ? row['tier'] : null,
    file: safeFileName(row['file']),
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): JobReissueTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Union-find over the bare ids a row connects (`from` → `to`). A row with
 * no usable `to` still joins its `from` as a singleton member, so every
 * recorded reissue lands in exactly one family.
 */
class Families {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    this.ensure(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path halving keeps deep reissue chains flat.
    let cur = id;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  private ensure(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  union(a: string, b: string): void {
    this.ensure(a);
    this.ensure(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  member(id: string): void {
    this.ensure(id);
  }

  members(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const list = groups.get(root) ?? [];
      list.push(id);
      groups.set(root, list);
    }
    for (const list of groups.values()) list.sort();
    return groups;
  }
}

/**
 * Pure: fold validated reissue rows into recurring family and lane cells.
 * Callers pass only in-window rows; families merge across rows through
 * their from→to edges, never through look-alike ids.
 */
export function foldJobReissueCells(rows: readonly JobReissueRow[]): JobReissueCells {
  const families = new Families();
  for (const row of rows) {
    families.member(row.from);
    if (row.to !== null) families.union(row.from, row.to);
  }
  const groups = families.members();
  const byRoot = new Map<string, JobReissueRow[]>();
  for (const row of rows) {
    const root = families.find(row.from);
    const list = byRoot.get(root) ?? [];
    list.push(row);
    byRoot.set(root, list);
  }

  const chains: JobReissueFamilyCell[] = [];
  for (const [root, members] of groups) {
    const familyRows = byRoot.get(root) ?? [];
    if (familyRows.length === 0) continue;
    const froms = new Map<string, number>();
    const tos = new Map<string, number>();
    const lanes = new Map<string, number>();
    const tiers = new Map<string, number>();
    let firstMs: number | null = null;
    let lastMs: number | null = null;
    for (const row of familyRows) {
      bump(froms, row.from);
      if (row.to !== null) bump(tos, row.to);
      bump(lanes, row.lane === null ? 'unknown' : fieldText(row.lane, MAX_LANE_CHARS) || 'unknown');
      if (row.tier !== null) bump(tiers, fieldText(row.tier, MAX_TIER_CHARS));
      firstMs = firstMs === null ? row.atMs : Math.min(firstMs, row.atMs);
      lastMs = lastMs === null ? row.atMs : Math.max(lastMs, row.atMs);
    }
    // The family representative is its original source prompt — a member
    // no row ever names as a `to`. New reissues only ever add `to` members,
    // so the representative (and therefore the item id) is stable as the
    // family grows; a member that is both would fall back to the smallest.
    const toKeys = new Set(tos.keys());
    const sources = members.filter((m) => !toKeys.has(m));
    chains.push({
      kind: 'chain',
      label: (sources.length > 0 ? sources : members)[0]!,
      members,
      rows: familyRows.length,
      fromCount: froms.size,
      toCount: tos.size,
      froms: [...froms.keys()].sort().slice(0, MAX_EXAMPLES),
      tos: [...tos.keys()].sort().slice(0, MAX_EXAMPLES),
      lanes: tallyOf(lanes, MAX_PROMPT_TALLIES),
      tiers: tallyOf(tiers, MAX_PROMPT_TALLIES),
      firstSeen: firstMs === null ? null : new Date(firstMs).toISOString(),
      lastSeen: lastMs === null ? null : new Date(lastMs).toISOString(),
    });
  }
  chains.sort((a, b) =>
    b.rows - a.rows
    || (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')
    || a.label.localeCompare(b.label));

  // Lane cells count distinct families, not rows: one family reissued all
  // week is the chain cell's evidence, not a lane pattern.
  const laneFamilies = new Map<string, { families: Set<string>; rows: number; tiers: Map<string, number>; firstMs: number | null; lastMs: number | null }>();
  for (const row of rows) {
    const lane = row.lane === null ? 'unknown' : fieldText(row.lane, MAX_LANE_CHARS) || 'unknown';
    const root = families.find(row.from);
    let cell = laneFamilies.get(lane);
    if (cell === undefined) {
      cell = { families: new Set(), rows: 0, tiers: new Map(), firstMs: null, lastMs: null };
      laneFamilies.set(lane, cell);
    }
    cell.families.add(root);
    cell.rows += 1;
    if (row.tier !== null) bump(cell.tiers, fieldText(row.tier, MAX_TIER_CHARS));
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  const lanes: JobReissueLaneCell[] = [...laneFamilies.entries()].map(([lane, cell]) => ({
    kind: 'lane',
    lane,
    families: cell.families.size,
    rows: cell.rows,
    tiers: tallyOf(cell.tiers, MAX_PROMPT_TALLIES),
    firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
    lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
  }));
  lanes.sort((a, b) =>
    b.families - a.families
    || b.rows - a.rows
    || (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')
    || a.lane.localeCompare(b.lane));

  return { chains, lanes };
}

const NO_CHANGE = 'If the window has rolled forward, the reissues were a one-off recovery burst, or the cause is owner-only or pinned ops machinery (credentials, billing, host capacity, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the writer path is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/job-reissues.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), appended by reissueJob (src/core/fleet/job-reissue.ts) for every resurrection written through the verse outcomes fleet-reissue endpoint — each row records {at, from, to, lane, tier, file}: the dead job\'s prompt id, the fresh drop id it was re-queued under, and the resolved lane/tier.';

function tallyText(tallies: readonly JobReissueTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(firstSeen: string | null, lastSeen: string | null): string {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` Recorded ${firstSeen}.`
    : ` Recorded ${firstSeen} through ${lastSeen}.`;
}

function quoteIds(ids: readonly string[]): string {
  return ids.filter((id) => SAFE_QUOTE_ID.test(id)).slice(0, MAX_EXAMPLES).join(', ');
}

function chainPrompt(cell: JobReissueFamilyCell): string {
  const examples = quoteIds([...cell.froms.map((f) => `RQ-PHX-${f}`), ...cell.tos.map((t) => `RQ-PHX-${t}`)]);
  return [
    `Phantom's fleet keeps resurrecting the same job family by hand — ${cell.rows} recorded reissue(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Every row in the reissue audit is a job that died or stalled and was manually re-queued under a fresh id. This family — member ids ${cell.members.slice(0, MAX_EXAMPLES).map((m) => `RQ-PHX-${m}`).join(', ')} — has been resurrected ${cell.rows} time(s) across ${cell.fromCount} source prompt(s) and ${cell.toCount} drop id(s)${examples !== '' ? ` (${examples})` : ''}. Recorded lanes: ${tallyText(cell.lanes)}.${cell.tiers.length > 0 ? ` Recorded tiers: ${tallyText(cell.tiers)}.` : ''}${seenText(cell.firstSeen, cell.lastSeen)}`,
    '',
    EVIDENCE,
    '',
    `A job that keeps needing reissue is work the factory is paying for twice: the original run produced nothing usable and a human or agent had to notice and resurrect it. What this repository owns is the queue/job lifecycle and fleet code around the reissue path (src/core/fleet/job-reissue.ts, src/core/verse/outcomes-api.ts, src/web-ui/routes/verse/fleet-outcomes, src/core/queue) and every detector that reads this evidence — outcome learning sees the dead attempts, but nothing tied them to the repeated manual recoveries.`,
    '',
    `Find why this family keeps dying: whether the job spec or prompt template produces work that cannot finish, whether the lane it lands on lacks the capacity or auth the job needs, or whether a terminal failure should have been recorded (and auto-retried or escalated) instead of going silent until someone reissued it. Fix what lives here; if the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function lanePrompt(cell: JobReissueLaneCell): string {
  return [
    `Phantom's fleet keeps needing job reissues on lane '${cell.lane}' — ${cell.families} distinct job families re-issued inside the window, the self-improvement work this backlog exists for.`,
    '',
    `${cell.rows} recorded reissue row(s) across ${cell.families} distinct job families — different dead jobs, not one job resurrected repeatedly. Recorded tiers: ${tallyText(cell.tiers)}.${seenText(cell.firstSeen, cell.lastSeen)}`,
    '',
    EVIDENCE,
    '',
    `Many different jobs dying on one lane points at the lane, not the jobs: capacity or slot starvation, auth or quota exhaustion, a dispatch path that drops work, or jobs whose specs demand more than the lane can deliver. What this repository owns is the queue/job lifecycle and fleet code the reissue path feeds (src/core/queue, src/core/fleet, src/core/verse) — lane admission, capacity accounting, and the outcome→reissue loop an operator uses to recover.`,
    '',
    `Find whether the lane's recorded reissues cluster on a cause this repository can fix — admission that launches jobs the lane cannot finish, a capacity read that over- or under-counts, or a failure mode that should requeue automatically instead of waiting for a manual fleet-reissue call. Fix what lives here; if the cause is pinned ops machinery, host state, provider quota or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function chainItem(cell: JobReissueFamilyCell, repo: string): CloudBacklogItem {
  const id = `job-reissue-chain-${createHash('sha256').update(`chain:${cell.label}`).digest('hex').slice(0, 16)}`;
  const label = fieldText(`RQ-PHX-${cell.label}`, MAX_LANE_CHARS);
  return {
    id,
    title: `Fleet job family ${label} keeps being reissued (${cell.rows}×)`.slice(0, MAX_TITLE_CHARS),
    prompt: chainPrompt(cell),
    area: 'job-reissues',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function laneItem(cell: JobReissueLaneCell, repo: string): CloudBacklogItem {
  const id = `job-reissue-lane-${createHash('sha256').update(`lane:${cell.lane}`).digest('hex').slice(0, 16)}`;
  const lane = fieldText(cell.lane, MAX_LANE_CHARS);
  return {
    id,
    title: `Fleet lane '${lane}' keeps needing job reissues (${cell.families} families)`.slice(0, MAX_TITLE_CHARS),
    prompt: lanePrompt(cell),
    area: 'job-reissues',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the job-reissue audit journal's recurring family and
 * lane cells. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function jobReissueBacklogItems(opts: JobReissueItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer applies: explicit dir, then a non-empty
    // ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is no dir at
    // all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const read = await readLedgerTail(join(runsDir, 'queue', 'job-reissues.jsonl'), JOB_REISSUE_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = (opts.sinceHours ?? JOB_REISSUE_WINDOW_HOURS) * 3_600_000;
    const rows: JobReissueRow[] = [];
    for (const line of read.text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const row = parseJobReissueRow(value);
      if (row === null) continue;
      if (nowMs - row.atMs > windowMs) continue;
      rows.push(row);
    }
    const cells = foldJobReissueCells(rows);
    const candidates: CloudBacklogItem[] = [
      ...cells.chains.filter((cell) => cell.rows >= JOB_REISSUE_MIN_ROWS).map((cell) => chainItem(cell, repo)),
      ...cells.lanes.filter((cell) => cell.families >= JOB_REISSUE_MIN_FAMILIES).map((cell) => laneItem(cell, repo)),
    ];
    const limit = Math.max(1, Math.min(opts.limit ?? JOB_REISSUE_MAX_ITEMS, JOB_REISSUE_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
