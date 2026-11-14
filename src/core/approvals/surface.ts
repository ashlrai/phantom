/**
 * The human "needs you" projection shared by `phm approvals --json`,
 * `GET /api/approvals` and the desktop Approvals panel (RQ-DESK-APPROVALS-1).
 *
 * Five independent sections, each reporting its own honest state so a broken
 * source never reads as "nothing pending":
 *   - teamApprovals: pending approvals folded from the team event log
 *   - proposals:     pending inbox proposals; `revision` names the exact
 *                    `approval-v1:` revision POST /api/inbox/:id/decision
 *                    accepts (records consent, NEVER applies), null when the
 *                    proposal has no reviewable request → review-only
 *   - drafts:        pending outbound email drafts; terminal-only decisions
 *                    (`phm drafts approve|reject <id>`) — the draft BODY is
 *                    never read into this projection, metadata only
 *   - pins:          packages staged under ~/.ashlr-runs/staged awaiting Security
 *                    (read-only; pins stay Security's, nothing here decides them)
 *   - holds:         explicit human holds from `$ASHLR_HOME/holds.json`
 *
 * Deciding a team approval goes through `decideApproval` with the identity
 * derived from the local OS user (`localHumanActor`), exactly like
 * `phm team approve|deny`. The caller never supplies an identity.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { approvalRequestForProposal, isApprovalRequestRevision } from '../inbox/pending-authority.js';
import { listDrafts } from '../cos/drafts.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  DEFAULT_TEAM, decideApproval, describeAccessAction, localHumanActor, teamState,
} from '../teams/index.js';

export type SectionState = 'ok' | 'unavailable';

export interface TeamApprovalItem {
  id: string;
  kind: 'access' | 'handoff';
  /** One-line, human-readable description of what is being asked. */
  summary: string;
  requestedBy: string;
  note: string | null;
  /** The CLI command that makes the same decision. */
  command: string;
}

export interface StagedPinItem {
  name: string;
  filesTouched: number;
  /** True when the file walk hit its bound, so `filesTouched` is a floor. */
  truncated: boolean;
  stagedAt: string;
  ageMs: number;
}

export interface HoldItem {
  id: string;
  title: string;
  detail: string | null;
  since: string | null;
}

export interface ProposalApprovalItem {
  /** Proposal id; also the inbox filename stem (~/.ashlr/inbox/<id>.json). */
  id: string;
  kind: string;
  /** One bounded, scrubbed line naming the request. */
  title: string;
  /** Optional second metadata line (scrubbed, capped). */
  detail: string | null;
  createdAt: string;
  /** Partial captures can be denied through consent but never approved. */
  partial: boolean;
  /**
   * The exact `approval-v1:` revision POST /api/inbox/:id/decision accepts —
   * the same consent-only path the approval card uses (records consent, NEVER
   * applies). Null when the proposal no longer produces a reviewable
   * ApprovalRequest; the row is then review-only via `reviewPath`.
   */
  revision: string | null;
  /** Deep link to the full review surface that owns the decision. */
  reviewPath: string;
}

export interface DraftApprovalItem {
  id: string;
  subject: string;
  to: string;
  /** 12-char prefix of the approval-binding digest — WHICH text is approved, never the text. */
  digestPrefix: string;
  createdAt: string;
  /** No web mutation exists for drafts; the CLI owns the decision. */
  approveCommand: string;
  rejectCommand: string;
  showCommand: string;
}

export interface Section<T> { state: SectionState; reason?: string; items: T[] }

export interface ApprovalsProjection {
  generatedAt: string;
  team: string;
  teamApprovals: Section<TeamApprovalItem>;
  proposals: Section<ProposalApprovalItem> & { truncated: boolean };
  drafts: Section<DraftApprovalItem> & { truncated: boolean };
  pins: Section<StagedPinItem> & { root: string };
  holds: Section<HoldItem> & { path: string; configured: boolean };
}

const WALK_FILE_CAP = 2000;
const WALK_DEPTH_CAP = 8;
/** Per-section row cap for the pending-store readers; `truncated` reports a cut. */
const PENDING_SOURCE_CAP = 100;
const PENDING_TITLE_MAX = 200;
const PENDING_DETAIL_MAX = 300;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Scrub-then-cap every free-text field that can reach the wire. */
const clean = (text: string, max: number): string => {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
};

/** Oldest waiting first; unparseable timestamps sort last; id breaks ties. */
const byCreatedAtAsc = (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }): number => {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const na = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const nb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  if (na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function holdsConfigPath(): string { return join(ashlrHome(), 'holds.json'); }
export function stagedPinsRoot(): string { return join(homedir(), '.ashlr-runs', 'staged'); }

export function readTeamApprovals(team: string): Section<TeamApprovalItem> {
  try {
    const s = teamState(team);
    const items = s.approvals.filter((a) => a.state === 'pending').map((a): TeamApprovalItem => ({
      id: a.id,
      kind: a.access ? 'access' : 'handoff',
      summary: a.access
        ? `Access request: ${describeAccessAction(a.access)}`
        : `${a.action ?? 'Consequential action'}${s.handoffs.find((h) => h.id === a.handoffId)?.title ? `: ${s.handoffs.find((h) => h.id === a.handoffId)!.title}` : ''}`,
      requestedBy: a.requestedBy,
      note: a.note,
      command: `phm team approve ${a.id} --team ${team}`,
    }));
    return { state: 'ok', items };
  } catch (e) {
    return { state: 'unavailable', reason: message(e), items: [] };
  }
}

/** Count regular files under `path` without following symlinks; bounded in count and depth. */
function countFiles(path: string): { count: number; truncated: boolean } {
  let count = 0;
  let truncated = false;
  const walk = (p: string, depth: number): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) { count += 1; return; }
    if (depth >= WALK_DEPTH_CAP) { truncated = true; return; }
    for (const name of readdirSync(p)) {
      if (count >= WALK_FILE_CAP) { truncated = true; return; }
      walk(join(p, name), depth + 1);
    }
  };
  walk(path, 0);
  return { count, truncated };
}

export function readStagedPins(root = stagedPinsRoot(), now = Date.now()): Section<StagedPinItem> & { root: string } {
  if (!existsSync(root)) return { state: 'ok', root, items: [] };
  try {
    const items = readdirSync(root).filter((n) => !n.startsWith('.')).map((name): StagedPinItem => {
      const path = join(root, name);
      const st = lstatSync(path);
      const { count, truncated } = countFiles(path);
      return { name, filesTouched: count, truncated, stagedAt: new Date(st.mtimeMs).toISOString(), ageMs: Math.max(0, now - st.mtimeMs) };
    }).sort((a, b) => b.ageMs - a.ageMs);
    return { state: 'ok', root, items };
  } catch (e) {
    return { state: 'unavailable', reason: message(e), root, items: [] };
  }
}

/**
 * `$ASHLR_HOME/holds.json`: `{ "holds": [{ "id", "title", "detail?", "since?", "resolvedAt?" }] }`.
 * A hold stays listed until it carries `resolvedAt` or is removed. A missing
 * file is an honest empty list; an unreadable one is reported, never hidden.
 */
export function readHolds(path = holdsConfigPath()): Section<HoldItem> & { path: string; configured: boolean } {
  if (!existsSync(path)) return { state: 'ok', path, configured: false, items: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { holds?: unknown };
    if (!raw || !Array.isArray(raw.holds)) throw new Error('expected {"holds": [...]}');
    const items: HoldItem[] = [];
    for (const h of raw.holds as Record<string, unknown>[]) {
      const id = str(h?.['id']);
      const title = str(h?.['title']);
      if (!id || !title) throw new Error('every hold needs a string id and title');
      if (str(h['resolvedAt'])) continue;
      items.push({ id, title, detail: str(h['detail']), since: str(h['since']) });
    }
    return { state: 'ok', path, configured: true, items };
  } catch (e) {
    return { state: 'unavailable', reason: `${path}: ${message(e)}`, path, configured: true, items: [] };
  }
}

/**
 * Pending inbox proposals (RQ-SWE-APPROVALS-1 recut). A proposal that still
 * produces a reviewable ApprovalRequest carries its `approval-v1:` revision so
 * the desktop can record consent through POST /api/inbox/:id/decision — the
 * exact revision binding, never a guessed one. Proposals whose review
 * projection no longer validates get `revision: null` → review-only.
 * A missing inbox is an honest empty list; a degraded read reports itself.
 */
export function readPendingProposals(maxItems = PENDING_SOURCE_CAP): Section<ProposalApprovalItem> & { truncated: boolean } {
  try {
    const read = listProposalsDetailed({ status: 'pending' });
    if (read.sourceState === 'missing') return { state: 'ok', items: [], truncated: false };
    const sorted = [...read.proposals].sort(byCreatedAtAsc);
    const items = sorted.slice(0, maxItems).map((p): ProposalApprovalItem => {
      const request = approvalRequestForProposal(p);
      return {
        id: p.id,
        kind: p.kind,
        title: clean(p.title, PENDING_TITLE_MAX),
        detail: typeof p.summary === 'string' && p.summary.length > 0 ? clean(p.summary, PENDING_DETAIL_MAX) : null,
        createdAt: p.createdAt,
        partial: p.isPartial === true,
        revision: request && isApprovalRequestRevision(request.revision) ? request.revision : null,
        reviewPath: `/inbox/${encodeURIComponent(p.id)}`,
      };
    });
    const truncated = sorted.length > items.length;
    return read.complete
      ? { state: 'ok', items, truncated }
      : { state: 'unavailable', reason: read.stopReasons.join(', ') || 'incomplete proposal read', items, truncated };
  } catch (e) {
    return { state: 'unavailable', reason: message(e), items: [], truncated: false };
  }
}

/**
 * Pending outbound email drafts (RQ-SWE-APPROVALS-1 recut). Terminal-only by
 * design — `phm drafts approve|reject|show` owns the decision, and the draft
 * BODY is never read into this projection: only id, recipient, subject and the
 * 12-char approval-binding digest prefix. A missing store is an honest empty
 * list (`listDrafts` returns [] on ENOENT).
 */
export async function readPendingDrafts(runsDir?: string, maxItems = PENDING_SOURCE_CAP): Promise<Section<DraftApprovalItem> & { truncated: boolean }> {
  try {
    const drafts = await listDrafts({ runsDir, status: 'pending' });
    const sorted = [...drafts].sort(byCreatedAtAsc);
    const items = sorted.slice(0, maxItems).map((d): DraftApprovalItem => ({
      id: d.id,
      subject: clean(d.subject.trim().length > 0 ? d.subject : '(no subject)', PENDING_TITLE_MAX),
      to: clean(d.to, PENDING_DETAIL_MAX),
      digestPrefix: d.digest.slice(0, 12),
      createdAt: d.createdAt,
      approveCommand: `phm drafts approve ${d.id}`,
      rejectCommand: `phm drafts reject ${d.id}`,
      showCommand: `phm drafts show ${d.id}`,
    }));
    return { state: 'ok', items, truncated: sorted.length > items.length };
  } catch (e) {
    return { state: 'unavailable', reason: message(e), items: [], truncated: false };
  }
}

export async function buildApprovalsProjection(team = DEFAULT_TEAM, now = Date.now(), runsDir?: string): Promise<ApprovalsProjection> {
  return {
    generatedAt: new Date(now).toISOString(),
    team,
    teamApprovals: readTeamApprovals(team),
    proposals: readPendingProposals(),
    drafts: await readPendingDrafts(runsDir),
    pins: readStagedPins(undefined, now),
    holds: readHolds(),
  };
}

/** The human's click is the approval: identity comes from the local OS user, never the caller. */
export function decideTeamApproval(team: string, approvalId: string, decision: 'approve' | 'deny') {
  return decideApproval(team, localHumanActor(), approvalId, decision);
}
