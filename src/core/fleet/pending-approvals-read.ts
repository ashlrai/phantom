/**
 * Read-only inventory of consent requests that wait on a human decision.
 *
 * Aggregates three durable stores through their existing readers:
 *   - 'proposal'      pending inbox proposals      (listProposalsDetailed)
 *   - 'draft'         pending outbound email drafts (listDrafts)
 *   - 'team-approval' pending team approvals        (teams events.jsonl, folded by foldTeam)
 *
 * Inventory only. Every row is a REQUEST, never a grant: nothing here approves,
 * denies, sends, dispatches or writes. Rows carry an id, kind, state and
 * creation time; titles, summaries, recipients, subjects, bodies, action
 * arguments, digests and paths are deliberately never read into the output.
 *
 * Source quality is explicit. A missing store is 'missing' (a real, complete
 * absence); a store that cannot be read, or that held lines we had to skip, is
 * 'degraded' with complete=false. Its valid rows from other sources still show.
 * A degraded source is never reported as a healthy empty slice.
 *
 * Caps are conservative and deterministic (oldest-first). Hitting one sets
 * `truncated` and `complete: false`; the list never claims completeness it lacks.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { draftsDir, listDrafts } from '../cos/drafts.js';
import { readEvents, teamDir } from '../teams/store.js';
import { foldTeam } from '../teams/state.js';
import { validId, type TeamEvent } from '../teams/protocol.js';
import { scrubSecrets } from '../util/scrub.js';

export const PENDING_APPROVAL_SOURCES = ['proposal', 'draft', 'team-approval'] as const;
export type PendingApprovalSource = (typeof PENDING_APPROVAL_SOURCES)[number];

export type PendingApprovalSourceState = 'healthy' | 'degraded' | 'missing';

export interface PendingApprovalRow {
  /** `<source>:<native id>`, unique across sources. */
  id: string;
  source: PendingApprovalSource;
  /** Proposal kind, 'email-draft', 'team:<consequential action>' or 'team:access-request'. */
  kind: string;
  state: 'pending';
  /** ISO creation time of the request, or null when the store holds no trustworthy timestamp. */
  createdAt: string | null;
}

export interface PendingApprovalSourceReport {
  sourceState: PendingApprovalSourceState;
  complete: boolean;
  count: number;
  truncated: boolean;
  /** Fixed, bounded diagnostics. Never raw error text or record content. */
  reasons: string[];
}

export interface PendingApprovalsCaps {
  /** Total rows across all sources. */
  maxItems: number;
  /** Rows per source. */
  maxPerSource: number;
  /** Team directories examined (sorted by id). */
  maxTeams: number;
}

export interface PendingApprovalsReport {
  schema: 'fleet.pending-approvals.v1';
  generatedAt: string;
  readOnly: true;
  /** True only when every source is complete and no cap cut rows off. */
  complete: boolean;
  truncated: boolean;
  caps: PendingApprovalsCaps;
  sources: Record<PendingApprovalSource, PendingApprovalSourceReport>;
  count: number;
  /** Oldest request first; unknown timestamps sort last; id breaks ties. */
  items: PendingApprovalRow[];
}

export interface PendingApprovalsReadOptions {
  now?: number;
  maxItems?: number;
  maxPerSource?: number;
  maxTeams?: number;
}

export const DEFAULT_PENDING_APPROVALS_CAPS: PendingApprovalsCaps = { maxItems: 200, maxPerSource: 100, maxTeams: 32 };
const HARD_CAPS: PendingApprovalsCaps = { maxItems: 1000, maxPerSource: 500, maxTeams: 256 };
const ID_MAX = 160;
const KIND_MAX = 64;
const EVENTS_FILE = 'events.jsonl';

interface SourceRead {
  rows: PendingApprovalRow[];
  sourceState: PendingApprovalSourceState;
  complete: boolean;
  truncated: boolean;
  reasons: string[];
}

function bounded(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

/** Scrub then cap any string that reaches the output; ids and kinds are display-only. */
function token(text: string, max: number): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Oldest first; unknown timestamps last; id breaks ties. Deterministic. */
function byAge(a: PendingApprovalRow, b: PendingApprovalRow): number {
  const ta = a.createdAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.createdAt);
  const tb = b.createdAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.createdAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function nonEmptyLines(raw: string): string[] {
  return raw.split('\n').filter(line => line.trim() !== '');
}

function countUnparseableLines(file: string): number {
  let bad = 0;
  for (const line of nonEmptyLines(readFileSync(file, 'utf8'))) {
    try { JSON.parse(line); } catch { bad += 1; }
  }
  return bad;
}

function degraded(reason: string): SourceRead {
  return { rows: [], sourceState: 'degraded', complete: false, truncated: false, reasons: [reason] };
}

/**
 * `readComplete` says whether the store itself was read without skips or
 * stops. A cap is not a read fault: it sets `truncated`, not `degraded`.
 */
function finish(rows: PendingApprovalRow[], maxPerSource: number, reasons: string[], readComplete: boolean, extraTruncated = false): SourceRead {
  rows.sort(byAge);
  const truncated = extraTruncated || rows.length > maxPerSource;
  const kept = rows.slice(0, maxPerSource);
  const allReasons = [...reasons];
  if (truncated) allReasons.push(`per-source cap of ${maxPerSource} reached`);
  return {
    rows: kept,
    sourceState: readComplete && reasons.length === 0 ? 'healthy' : 'degraded',
    complete: readComplete && !truncated,
    truncated,
    reasons: allReasons,
  };
}

function readProposals(maxPerSource: number): SourceRead {
  let read;
  try {
    read = listProposalsDetailed({ status: 'pending' });
  } catch {
    return degraded('proposal store unreadable');
  }
  if (read.sourceState === 'missing') {
    return { rows: [], sourceState: 'missing', complete: true, truncated: false, reasons: [] };
  }
  const reasons: string[] = [];
  if (read.stopReasons.length > 0) reasons.push(`proposal read stopped: ${read.stopReasons.join(', ')}`);
  const skipped = read.invalidFiles + read.unreadableFiles;
  if (skipped > 0) reasons.push(`${skipped} proposal file(s) skipped`);
  const rows = read.proposals
    .filter(p => p.status === 'pending')
    .map((p): PendingApprovalRow => ({
      id: token(`proposal:${p.id}`, ID_MAX),
      source: 'proposal',
      kind: token(String(p.kind), KIND_MAX),
      state: 'pending',
      createdAt: isoOrNull(p.createdAt),
    }));
  const complete = read.complete && skipped === 0 && read.stopReasons.length === 0;
  return finish(rows, maxPerSource, reasons, complete);
}

async function readDrafts(maxPerSource: number): Promise<SourceRead> {
  const file = join(draftsDir(), 'drafts.jsonl');
  if (!existsSync(file)) return { rows: [], sourceState: 'missing', complete: true, truncated: false, reasons: [] };
  let pending;
  let skipped: number;
  try {
    pending = await listDrafts({ status: 'pending' });
    skipped = countUnparseableLines(file);
  } catch {
    return degraded('draft store unreadable');
  }
  const reasons = skipped > 0 ? [`${skipped} draft line(s) unreadable`] : [];
  const rows = pending.map((d): PendingApprovalRow => ({
    id: token(`draft:${d.id}`, ID_MAX),
    source: 'draft',
    kind: 'email-draft',
    state: 'pending',
    createdAt: isoOrNull(d.createdAt),
  }));
  return finish(rows, maxPerSource, reasons, skipped === 0);
}

function readTeams(maxTeams: number, maxPerSource: number): SourceRead {
  const dir = join(ashlrHome(), 'teams');
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rows: [], sourceState: 'missing', complete: true, truncated: false, reasons: [] };
    }
    return degraded('team log directory unreadable');
  }
  const teamIds = entries
    .filter(entry => entry.isDirectory() && validId(entry.name))
    .map(entry => entry.name)
    .sort();
  const teams = teamIds.slice(0, maxTeams);
  const teamsTruncated = teamIds.length > teams.length;

  const rows: PendingApprovalRow[] = [];
  const reasons: string[] = [];
  let unreadableTeams = 0;
  let skippedLines = 0;
  for (const team of teams) {
    try {
      const events: TeamEvent[] = readEvents(team);
      const file = join(teamDir(team), EVENTS_FILE);
      // readEvents drops torn or foreign lines silently; count them so a damaged log is not a clean empty.
      if (existsSync(file)) skippedLines += nonEmptyLines(readFileSync(file, 'utf8')).length - events.length;
      const requestedAt = new Map<string, string | null>();
      for (const ev of events) {
        if (ev.type === 'approval.requested' || ev.type === 'access.requested') requestedAt.set(ev.id, isoOrNull(ev.ts));
      }
      const state = foldTeam(team, events);
      for (const approval of state.approvals) {
        if (approval.state !== 'pending') continue;
        rows.push({
          id: token(`team-approval:${team}:${approval.id}`, ID_MAX),
          source: 'team-approval',
          kind: approval.action ? token(`team:${approval.action}`, KIND_MAX) : 'team:access-request',
          state: 'pending',
          createdAt: requestedAt.get(approval.id) ?? null,
        });
      }
    } catch {
      unreadableTeams += 1;
    }
  }
  if (unreadableTeams > 0) reasons.push(`${unreadableTeams} team log(s) unreadable`);
  if (skippedLines > 0) reasons.push(`${skippedLines} team log line(s) skipped`);
  // A team cap is truncation, not a read fault: extra teams are unread, so the source is incomplete.
  return finish(rows, maxPerSource, reasons, unreadableTeams === 0 && skippedLines === 0, teamsTruncated);
}

function toReport(source: SourceRead): PendingApprovalSourceReport {
  return { sourceState: source.sourceState, complete: source.complete, count: source.rows.length, truncated: source.truncated, reasons: source.reasons };
}

/**
 * Build the inventory. Each source is read inside its own guard, so one broken
 * store degrades only its slice. Never throws. Performs reads only.
 */
export async function readPendingApprovalsInventory(opts: PendingApprovalsReadOptions = {}): Promise<PendingApprovalsReport> {
  const caps: PendingApprovalsCaps = {
    maxItems: bounded(opts.maxItems, DEFAULT_PENDING_APPROVALS_CAPS.maxItems, HARD_CAPS.maxItems),
    maxPerSource: bounded(opts.maxPerSource, DEFAULT_PENDING_APPROVALS_CAPS.maxPerSource, HARD_CAPS.maxPerSource),
    maxTeams: bounded(opts.maxTeams, DEFAULT_PENDING_APPROVALS_CAPS.maxTeams, HARD_CAPS.maxTeams),
  };
  const proposal = readProposals(caps.maxPerSource);
  const draft = await readDrafts(caps.maxPerSource);
  const team = readTeams(caps.maxTeams, caps.maxPerSource);

  const merged = [...proposal.rows, ...draft.rows, ...team.rows].sort(byAge);
  const items = merged.slice(0, caps.maxItems);
  const globalTruncated = merged.length > items.length;
  const sources = {
    proposal: toReport(proposal),
    draft: toReport(draft),
    'team-approval': toReport(team),
  };
  const sourcesComplete = [proposal, draft, team].every(s => s.complete);
  return {
    schema: 'fleet.pending-approvals.v1',
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    readOnly: true,
    complete: sourcesComplete && !globalTruncated,
    truncated: globalTruncated || [proposal, draft, team].some(s => s.truncated),
    caps,
    sources,
    count: items.length,
    items,
  };
}

/** Human text. States read-only and that rows are requests, not grants. */
export function formatPendingApprovals(report: PendingApprovalsReport): string {
  const lines = [
    `Pending approvals (read-only): ${report.count} request(s) shown.`,
    'Nothing was approved, denied, sent or dispatched. Each row is a request for a human decision, not a grant.',
    `Status: ${report.complete ? 'complete' : 'INCOMPLETE — this list may omit requests'}${report.truncated ? ' (truncated by a cap)' : ''}`,
  ];
  for (const source of PENDING_APPROVAL_SOURCES) {
    const s = report.sources[source];
    const detail = s.reasons.length > 0 ? ` — ${s.reasons.join('; ')}` : '';
    lines.push(`  ${source}: ${s.sourceState}${s.complete ? '' : ' (incomplete)'}, ${s.count} shown${detail}`);
  }
  for (const item of report.items) {
    lines.push(`  ${item.id}  ${item.kind}  ${item.createdAt ?? 'time unknown'}`);
  }
  return lines.join('\n');
}
