/**
 * Pending model-radar inbox review notes past the review grace →
 * self-improvement backlog items.
 *
 * The daily official-source model radar — `phm models radar --fetch
 * --propose`, installed by modelRadarSchedule in
 * src/core/fleet/model-radar-schedule.ts as the ai.ashlr.phm.model-radar
 * launchd agent / phm-model-radar systemd user timer — scans the saved
 * provider release-note pages, diffs them against the shipped verified
 * registry (docs/model-registry.json through loadVerifiedRegistry in
 * src/core/fleet/model-verify.ts), and files one pending 'note' proposal
 * per fresh high-confidence addition into the approval inbox
 * (~/.ashlr/inbox/<id>.json — origin 'manual', kind 'note', repo null,
 * title '[model radar] Review <provider>:<id>') via
 * fileModelRadarProposals in src/core/fleet/model-radar-proposals.ts.
 * The note carries the candidate's source URL, retrieval date, matched
 * doc line and an unapplied models.registry-patch.v1 patch. The radar
 * never edits the registry and never launches work: each note sits until
 * a person reads it in `phm inbox`, confirms the exact id on the
 * provider's official doc page, records this machine's verification
 * (`phm models verify <id> --source <url>` → $ASHLR_HOME/
 * model-registry.json), and lands the shipped-registry row in
 * docs/model-registry.json by PR — the step docs/ROUTER-GATEWAY.md calls
 * shipping the evidence to every install.
 *
 * Until now the pending notes' only surface was that same inbox listing a
 * human had to open, so a candidate the radar detected and nobody
 * reviewed kept the router refusing a model the provider's own docs
 * already name — and no feed read the inbox at all. The sibling
 * catalog-refresh feed watches the weekly router catalog probes
 * (src/core/routing/catalog-refresh.ts), a different machinery path from
 * this daily release-notes radar.
 *
 * modelRadarBacklogItems carries the pending-note set into
 * discoverBacklog: one item per candidate whose pending note is older
 * than MODEL_RADAR_REVIEW_GRACE_MS, so `phm improve discover` and the
 * scheduler's autoDiscover queue the verification work exactly like the
 * sibling evidence feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The inbox is enumerated through listProposalsDetailed's
 *    bounded, link-rejecting, replacement-detecting read; nothing is
 *    written and no network is touched. A missing inbox dir or a
 *    degraded/partial read yields no items — an incomplete proposal set
 *    can never prove the pending-review backlog it claims to measure.
 *  - State, not events. A pending note carries one createdAt, so the
 *    sibling feeds' min-rows/min-distinct-days recurrence bars do not
 *    apply; the adverse bar is the review grace itself — a note still
 *    pending a week after the daily radar filed it means the review
 *    pipeline did not absorb it. A note decided (approved, rejected,
 *    applied, failed) or removed simply stops being pending and its
 *    cell stops re-adding. The writer dedupes by title across every
 *    status, so one candidate files at most one note ever; defensive
 *    grouping still folds any same-candidate stragglers into one cell.
 *  - Writer contract only. The candidate key comes from the note title's
 *    '[model radar] Review <provider>:<id>' shape and the summary must
 *    carry the writer's models.registry-patch.v1 marker — a manual note
 *    that merely imitates the prefix is not radar evidence. Off-contract
 *    titles, unparseable or future-dated createdAt stamps (past the
 *    sibling feeds' one-minute skew) and undecided-age notes never
 *    count.
 *  - Untrusted text. Titles, summaries, source URLs and doc lines are
 *    provider- and owner-controlled strings: every quoted field is
 *    scrubbed, flattened and capped, and the prompt points at
 *    `phm inbox show <id>` for the authoritative detail instead of
 *    pasting the whole note.
 *  - Fleet machinery only. The radar, the shipped registry and the
 *    inbox are this install's machinery and the notes carry no
 *    repository column, so items emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the
 *    sibling feeds apply.
 *  - Dedup is downstream. The item id hashes the candidate key
 *    (provider:id), never counts or timestamps, so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    decided note stops re-adding, and the doneWhen acceptance
 *    (docs/model-registry.json naming the id on the default branch)
 *    retires the item once the evidence ships by any path.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { listProposalsDetailed } from '../inbox/store.js';
import type { Proposal } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; pending radar notes are rare, so the cap bounds a pathological inbox. */
export const MODEL_RADAR_BACKLOG_MAX_ITEMS = 8;
const MODEL_RADAR_ITEM_HARD_MAX = 25;
/**
 * Review grace: a note pending this long is stalled evidence. The radar
 * files only fresh high-confidence additions — rare by construction —
 * so one week gives a weekly owner review cadence first claim on the
 * note before the fleet drains it.
 */
export const MODEL_RADAR_REVIEW_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on note timestamps, same convention the sibling folds tolerate. */
const MODEL_RADAR_FUTURE_SKEW_MS = 60_000;
/** The title prefix fileModelRadarProposals stamps on every radar note. */
export const MODEL_RADAR_TITLE_PREFIX = '[model radar] Review ';
/**
 * The writer's candidate shape: '<provider>:<id>' — provider is a
 * lowercase registry name, id may itself contain colons (e.g. qwen's
 * qwen3:32b) but never whitespace.
 */
const CANDIDATE_PATTERN = /^([^\s:]{1,40}):([^\s]{1,120})$/;
/** The writer's summary always embeds the unapplied patch's schema stamp. */
const PATCH_MARKER = 'models.registry-patch.v1';
/** `Source: <url> (retrieved <date>, line <n>)` — the writer's second summary line. */
const SOURCE_PATTERN = /Source: (https?:\/\/[^\s)]+) \(retrieved ([^,]+), line (\d+)\)/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct note ids quoted inside one prompt before the rest is summarized. */
const PROMPT_NOTES_MAX = 4;
/** The fleet's own repository label: radar evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface ModelRadarItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Most items one call emits (default MODEL_RADAR_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Review grace in ms (default MODEL_RADAR_REVIEW_GRACE_MS). */
  graceMs?: number;
  /** Clock anchoring note ages (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string | null | undefined, max = FIELD_MAX): string {
  if (value === null || value === undefined) return '';
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

interface RadarNoteEvidence {
  proposalId: string;
  createdAtMs: number;
  createdAtIso: string;
  sourceUrl: string;
  retrievedOn: string;
  lineNumber: string;
}

interface RadarCell {
  candidate: string;
  provider: string;
  id: string;
  notes: RadarNoteEvidence[];
  oldestMs: number;
}

/**
 * The writer-contract check for one pending proposal: radar-filed
 * manual note, title carrying a '<provider>:<id>' candidate, summary
 * carrying the patch marker. Returns the parsed candidate or null.
 */
function radarCandidate(proposal: Proposal): { provider: string; id: string } | null {
  if (proposal.origin !== 'manual' || proposal.kind !== 'note' || proposal.repo !== null) return null;
  if (!proposal.title.startsWith(MODEL_RADAR_TITLE_PREFIX)) return null;
  if (!proposal.summary.includes(PATCH_MARKER)) return null;
  const match = CANDIDATE_PATTERN.exec(proposal.title.slice(MODEL_RADAR_TITLE_PREFIX.length));
  if (!match) return null;
  return { provider: match[1]!, id: match[2]! };
}

/** Best-effort parse of the writer's `Source:` line; absent fields stay empty, never guessed. */
function noteEvidence(proposal: Proposal, createdAtMs: number): RadarNoteEvidence {
  const createdAtIso = new Date(createdAtMs).toISOString();
  const source = SOURCE_PATTERN.exec(proposal.summary);
  return {
    proposalId: proposal.id,
    createdAtMs,
    createdAtIso,
    sourceUrl: fieldText(source?.[1] ?? '', 300),
    retrievedOn: fieldText(source?.[2] ?? '', 40),
    lineNumber: source?.[3] ?? '',
  };
}

/** The evidence pointers every prompt shares; the inbox, the writer and the registry are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the pending proposal files under the account inbox (~/.ashlr/inbox/<id>.json — inboxDir in src/core/inbox/store.ts): `phm inbox --json` lists pending proposals and `phm inbox show <id>` prints one note\'s full summary — the source URL, retrieval date, matched doc line and the unapplied models.registry-patch.v1 patch — exactly as fileModelRadarProposals in src/core/fleet/model-radar-proposals.ts wrote it. The daily producer is `phm models radar --fetch --propose` (src/cli/models.ts → runModelRadar in src/core/fleet/model-radar.ts → scanModelReleaseNotes).';

const NO_CHANGE = 'If the note was already decided or the candidate already sits verified in docs/model-registry.json on the default branch, the recorded source no longer names the exact id, the radar note duplicates shipped evidence, or the only missing piece is owner-side (a provider account, payment or a protected gate) — report no-change and name the evidence.';

function ageText(oldestMs: number, nowMs: number): string {
  const ms = nowMs - oldestMs;
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function notesText(cell: RadarCell): string {
  const shown = cell.notes.slice(0, PROMPT_NOTES_MAX);
  const ids = shown.map((note) => `\`${note.proposalId}\``).join(', ');
  const more = cell.notes.length > shown.length ? ` and ${cell.notes.length - shown.length} more` : '';
  return `Pending inbox note${cell.notes.length === 1 ? '' : 's'} ${ids}${more}, filed ${shown[0]!.createdAtIso}${cell.notes.length === 1 ? '' : ` through ${shown[shown.length - 1]!.createdAtIso}`}.`;
}

function sourceText(cell: RadarCell): string {
  const withSource = cell.notes.find((note) => note.sourceUrl !== '');
  if (!withSource) return 'The note records no parseable source line — `phm inbox show` has the summary verbatim.';
  const meta = [
    withSource.retrievedOn !== '' ? `retrieved ${withSource.retrievedOn}` : '',
    withSource.lineNumber !== '' ? `line ${withSource.lineNumber}` : '',
  ].filter((part) => part !== '').join(', ');
  return `The note's recorded source is ${withSource.sourceUrl}${meta !== '' ? ` (${meta})` : ''} — the provider's own doc page the radar matched.`;
}

function radarPrompt(cell: RadarCell, nowMs: number): string {
  const candidate = fieldText(cell.candidate, 165) || 'unknown';
  const pid = fieldText(cell.id, 120);
  const pprovider = fieldText(cell.provider, 40);
  return [
    `Phantom's model radar filed an official-source review note for '${candidate}' that has sat pending for ${ageText(cell.oldestMs, nowMs)} — the self-improvement work this backlog exists to queue.`,
    '',
    `The daily radar (modelRadarSchedule in src/core/fleet/model-radar-schedule.ts — the ai.ashlr.phm.model-radar launchd agent or phm-model-radar systemd user timer) runs \`phm models radar --fetch --propose\`: it scans the saved provider release-note pages, diffs them against the shipped verified registry (docs/model-registry.json through loadVerifiedRegistry in src/core/fleet/model-verify.ts), and files one pending inbox note per fresh high-confidence addition. The note is review-only evidence — the radar never edits the registry — and the router refuses the id as unverified until official docs confirm it. ${notesText(cell)} ${sourceText(cell)}`,
    '',
    `Verify the exact id is still named on the provider's official doc page — MODEL_SOURCE_HOSTS in src/core/fleet/model-verify.ts names each provider's allowed doc sites, and \`phm models verify <id> --source <url>\` performs the same fetch-and-check for this machine's local $ASHLR_HOME/model-registry.json record. If the page confirms the id, land the shipped-registry row in this repo: add {"id": "${pid}", "provider": "${pprovider}", "verified_source": "<source url>", "verified_at": "<UTC date>", "status": "verified"} to docs/model-registry.json in the existing one-row-per-line shape (an optional "lanes" list only when a lane is confirmed), open the PR, and once the row is on the default branch reject the inbox note as actioned (\`phm inbox reject <id>\`) so the review surface stays honest; if the PR is still open when the session ends, say so in the report and leave the note pending. If the official page does not name the id, the candidate was already registered by another path, or verification needs an account or payment only the owner holds — reject the note with the evidence (\`phm inbox reject <id>\`) or report no-change.`,
    '',
    EVIDENCE,
    '',
    NO_CHANGE,
  ].join('\n');
}

function radarItem(cell: RadarCell, nowMs: number, repo: string): CloudBacklogItem {
  const slug = createHash('sha256').update(cell.candidate).digest('hex').slice(0, 12);
  return {
    id: `modelradar-${slug}`,
    title: `Model radar candidate '${fieldText(cell.candidate, 120)}' pending inbox review`.slice(0, MAX_TITLE_CHARS),
    prompt: radarPrompt(cell, nowMs),
    area: 'router-catalog',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    doneWhen: { path: 'docs/model-registry.json', contains: `"id": "${cell.id}"` },
  };
}

/**
 * Backlog items for pending model-radar inbox notes past the review
 * grace. Total: a missing inbox, another repository, a degraded read or
 * any fold failure yields no items rather than throwing into discovery.
 */
export async function modelRadarBacklogItems(opts: ModelRadarItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const graceMs = opts.graceMs !== undefined && Number.isFinite(opts.graceMs) && opts.graceMs > 0
      ? opts.graceMs
      : MODEL_RADAR_REVIEW_GRACE_MS;
    const cutoffMs = nowMs - graceMs;

    // requireComplete: a degraded or partial inbox read returns no
    // proposals at all — an incomplete set can never prove the backlog.
    const read = listProposalsDetailed({ status: 'pending', requireComplete: true });
    if (read.sourceState === 'degraded' || read.proposals.length === 0) return [];

    const cells = new Map<string, RadarCell>();
    for (const proposal of read.proposals) {
      const candidate = radarCandidate(proposal);
      if (candidate === null) continue;
      const createdAtMs = Date.parse(proposal.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs + MODEL_RADAR_FUTURE_SKEW_MS) continue;
      if (createdAtMs > cutoffMs) continue;
      const key = `${candidate.provider}:${candidate.id}`;
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = { candidate: key, provider: candidate.provider, id: candidate.id, notes: [], oldestMs: Infinity };
        cells.set(key, cell);
      }
      cell.notes.push(noteEvidence(proposal, createdAtMs));
      cell.oldestMs = Math.min(cell.oldestMs, createdAtMs);
    }
    if (cells.size === 0) return [];

    const ordered = [...cells.values()].sort(
      (a, b) => a.oldestMs - b.oldestMs || a.candidate.localeCompare(b.candidate),
    );
    for (const cell of ordered) {
      cell.notes.sort((a, b) => a.createdAtMs - b.createdAtMs || a.proposalId.localeCompare(b.proposalId));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? MODEL_RADAR_BACKLOG_MAX_ITEMS, MODEL_RADAR_ITEM_HARD_MAX));
    return ordered.slice(0, limit).map((cell) => radarItem(cell, nowMs, repo));
  } catch {
    return [];
  }
}
