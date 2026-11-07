/**
 * pending-approvals.ts — GET /api/approvals read model.
 *
 * One bounded, value-blind list of every consent request waiting on the
 * operator, aggregated from the three durable approval stores the CLI
 * already owns:
 *
 *   - 'proposal'      — pending inbox proposals (src/core/inbox/store.ts).
 *                       When the proposal still produces a reviewable
 *                       ApprovalRequest, `decide.mode === 'consent'` names
 *                       the exact revision POST /api/inbox/:id/decision
 *                       accepts — the same consent-only path the approval
 *                       card uses; it records consent and NEVER applies.
 *                       Proposals without a reviewable request fall back to
 *                       'review-only' + the /inbox/:id deep link.
 *   - 'draft'         — pending outbound email drafts
 *                       (src/core/cos/drafts.ts). Terminal-only: approval is
 *                       `phm drafts approve|reject <id>`; the draft BODY is
 *                       never read into this response — only id, recipient,
 *                       subject, source and the approval-binding digest
 *                       prefix are metadata.
 *   - 'team-approval' — pending consequential-action approvals folded from
 *                       $ASHLR_HOME/teams/<team>/events.jsonl
 *                       (src/core/teams/state.ts). Terminal-only by design:
 *                       only a human owner/admin actor may decide, via
 *                       `phm team approve|deny <id> --team <team>`.
 *
 * Value-blind contract: every string that reaches the response passes
 * scrubSecrets() and a length cap; parameters are scalar metadata only —
 * no diffs, bodies, arguments, tokens, HMACs or secret-shaped values.
 * Per-source reads are independently guarded (control.ts convention): a
 * broken store degrades ONLY its own slice and is reported in `sources`
 * so the UI can say "this list may be incomplete" instead of silently
 * showing less. Never throws.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { approvalRequestForProposal, isApprovalRequestRevision } from '../inbox/pending-authority.js';
import type { Proposal } from '../types.js';
import { draftsDir, listDrafts } from '../cos/drafts.js';
import { teamState } from '../teams/state.js';
import { validId } from '../teams/protocol.js';
import { scrubSecrets } from '../util/scrub.js';

export type PendingApprovalSource = 'proposal' | 'draft' | 'team-approval';

/**
 * How a row may be decided. The UI renders exactly this — it never guesses:
 *  - 'consent'      → POST /api/inbox/:id/decision { revision, decision }
 *                     (records consent only; gated by --allow-dispatch +
 *                     mutation token server-side).
 *  - 'terminal'     → no web mutation exists; show the phm commands.
 *  - 'review-only'  → no safe decision path at all; reviewPath leads to the
 *                     full surface that owns the decision.
 */
export type PendingApprovalDecide =
  | {
      mode: 'consent';
      proposalId: string;
      revision: string;
      /** Partial captures can be denied but the decision route refuses approve. */
      partial?: boolean;
    }
  | { mode: 'terminal'; approveCommand: string; denyCommand: string; showCommand?: string }
  | { mode: 'review-only'; reason: string };

export interface PendingApprovalItem {
  /** Globally unique across sources: `<source>:<native id>`. */
  id: string;
  source: PendingApprovalSource;
  /** Proposal kind, 'email-draft', or 'team:<consequential action>'. */
  kind: string;
  /** One bounded, scrubbed line naming the request. */
  title: string;
  /** Optional second metadata line (scrubbed, capped). */
  detail: string | null;
  /** Scalar metadata only — the "parameters as metadata" of the request. */
  parameters: Record<string, string | number | boolean | null>;
  /** ISO timestamp the request was created (team approvals: requestedAt). */
  createdAt: string;
  status: 'pending';
  /** Deep link to the full review surface when one exists. */
  reviewPath?: string;
  decide: PendingApprovalDecide;
}

/** Same vocabulary as the rest of the read API (Epistemic-compatible). */
export interface PendingApprovalSourceQuality {
  sourceState: 'healthy' | 'degraded' | 'missing';
  complete: boolean;
  reason?: string;
}

export interface PendingApprovalsResponse {
  generatedAt: string;
  /** Mirrors ctx.allowDispatch so the UI can label decide affordances honestly. */
  dispatchEnabled: boolean;
  sources: Record<PendingApprovalSource, PendingApprovalSourceQuality>;
  /** Oldest-first: the consent request that has waited longest surfaces first. */
  approvals: PendingApprovalItem[];
  /** True when a per-source or total cap cut rows off the response. */
  truncated: boolean;
}

export interface PendingApprovalsOptions {
  /** Server mutation gate; only reported, never enforced here (reads are free). */
  allowDispatch?: boolean;
  /** Draft store override (tests); defaults to the standard ~/.ashlr-runs. */
  runsDir?: string;
  /** Clock override for generatedAt (tests). */
  now?: number;
  /** Total row cap across all sources. Default 200. */
  maxItems?: number;
  /** Per-source row cap. Default 100. */
  maxPerSource?: number;
  /** Team directories scanned. Default 32. */
  maxTeams?: number;
}

const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_MAX_PER_SOURCE = 100;
const DEFAULT_MAX_TEAMS = 32;
const TITLE_MAX = 200;
const DETAIL_MAX = 300;
const PARAM_VALUE_MAX = 300;
const PARAM_MAX_KEYS = 12;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Scrub-then-cap every free-text field that can reach the wire. */
function clean(text: string, max: number): string {
  return cap(scrubSecrets(text), max);
}

/** Scalar metadata only; strings are scrubbed and capped, everything else is null. */
function parametersOf(entries: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(entries).slice(0, PARAM_MAX_KEYS)) {
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string') out[key] = clean(value, PARAM_VALUE_MAX);
    else out[key] = null;
  }
  return out;
}

/** Oldest waiting first; unparseable timestamps sort last; id breaks ties. */
function byCreatedAtAsc(a: PendingApprovalItem, b: PendingApprovalItem): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const na = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const nb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  if (na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface SourceRead {
  items: PendingApprovalItem[];
  quality: PendingApprovalSourceQuality;
  truncated: boolean;
}

function proposalItems(proposals: Proposal[], maxPerSource: number): SourceRead {
  const sorted = [...proposals].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    const na = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
    const nb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    return na !== nb ? na - nb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const truncated = sorted.length > maxPerSource;
  const items = sorted.slice(0, maxPerSource).map((p): PendingApprovalItem => {
    // The consent revision binds the COMPLETE review (full diff hash). A
    // proposal whose review projection no longer validates gets review-only
    // treatment — never a guessed revision.
    const request = approvalRequestForProposal(p);
    const reviewPath = `/inbox/${encodeURIComponent(p.id)}`;
    return {
      id: `proposal:${p.id}`,
      source: 'proposal',
      kind: p.kind,
      title: clean(p.title, TITLE_MAX),
      detail: typeof p.summary === 'string' && p.summary.length > 0 ? clean(p.summary, DETAIL_MAX) : null,
      parameters: parametersOf({
        repo: p.repo,
        origin: p.origin,
        partial: p.isPartial === true,
        engine: p.engineModel ?? null,
      }),
      createdAt: p.createdAt,
      status: 'pending',
      reviewPath,
      decide: request && isApprovalRequestRevision(request.revision)
        ? { mode: 'consent', proposalId: p.id, revision: request.revision, partial: p.isPartial === true }
        : { mode: 'review-only', reason: 'This proposal has no reviewable approval request; open it to inspect the diff and decide.' },
    };
  });
  return { items, quality: { sourceState: 'healthy', complete: true }, truncated };
}

async function draftItems(runsDir: string | undefined, maxPerSource: number): Promise<SourceRead> {
  const storeFile = join(draftsDir(runsDir), 'drafts.jsonl');
  const present = existsSync(storeFile);
  let drafts;
  try {
    drafts = await listDrafts({ runsDir, status: 'pending' });
  } catch {
    return {
      items: [],
      quality: { sourceState: 'degraded', complete: false, reason: 'draft store read failed' },
      truncated: false,
    };
  }
  const items = drafts.map((d): PendingApprovalItem => ({
    id: `draft:${d.id}`,
    source: 'draft',
    kind: 'email-draft',
    title: clean(d.subject.trim().length > 0 ? d.subject : '(no subject)', TITLE_MAX),
    detail: clean(`to ${d.to}`, DETAIL_MAX),
    parameters: parametersOf({
      channel: d.channel,
      to: d.to,
      source: d.source,
      // The digest prefix is what `phm drafts approve --digest` binds to —
      // metadata about WHICH text is approved, never the text itself.
      digest: d.digest.slice(0, 12),
    }),
    createdAt: d.createdAt,
    status: 'pending',
    decide: {
      mode: 'terminal',
      approveCommand: `phm drafts approve ${d.id}`,
      denyCommand: `phm drafts reject ${d.id}`,
      showCommand: `phm drafts show ${d.id}`,
    },
  }));
  items.sort(byCreatedAtAsc);
  const truncated = items.length > maxPerSource;
  return {
    items: items.slice(0, maxPerSource),
    quality: present
      ? { sourceState: 'healthy', complete: true }
      : { sourceState: 'missing', complete: true },
    truncated,
  };
}

function teamApprovalItems(maxTeams: number, maxPerSource: number): SourceRead {
  const dir = join(ashlrHome(), 'teams');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { items: [], quality: { sourceState: 'missing', complete: true }, truncated: false };
    }
    return {
      items: [],
      quality: { sourceState: 'degraded', complete: false, reason: 'team log directory unreadable' },
      truncated: false,
    };
  }
  const teamIds = entries
    .filter((e) => e.isDirectory() && validId(e.name))
    .map((e) => e.name)
    .sort();
  const teamsTruncated = teamIds.length > maxTeams;
  const teams = teamIds.slice(0, maxTeams);

  const items: PendingApprovalItem[] = [];
  let degraded = false;
  for (const team of teams) {
    let state;
    try {
      state = teamState(team);
    } catch {
      degraded = true;
      continue;
    }
    const handoffs = new Map(state.handoffs.map((h) => [h.id, h]));
    for (const a of state.approvals) {
      if (a.state !== 'pending') continue;
      const handoff = handoffs.get(a.handoffId);
      items.push({
        id: `team-approval:${team}:${a.id}`,
        source: 'team-approval',
        kind: `team:${a.action}`,
        title: clean(handoff?.title.trim() ? handoff.title : `Approval requested: ${a.action}`, TITLE_MAX),
        detail: clean(`requested by ${a.requestedBy}`, DETAIL_MAX),
        parameters: parametersOf({
          team,
          action: a.action,
          requestedBy: a.requestedBy,
          handoff: a.handoffId,
        }),
        createdAt: a.requestedAt,
        status: 'pending',
        decide: {
          mode: 'terminal',
          approveCommand: `phm team approve ${a.id} --team ${team}`,
          denyCommand: `phm team deny ${a.id} --team ${team}`,
          showCommand: `phm team view --team ${team}`,
        },
      });
    }
  }

  items.sort(byCreatedAtAsc);
  const truncated = teamsTruncated || items.length > maxPerSource;
  return {
    items: items.slice(0, maxPerSource),
    quality: degraded
      ? { sourceState: 'degraded', complete: false, reason: 'one or more team logs unreadable' }
      : { sourceState: 'healthy', complete: true },
    truncated,
  };
}

/**
 * Assemble the pending-approvals read model. Each source is read inside its
 * own guard so one broken store can never blank the others; the response
 * still reports per-source quality so the UI never claims an all-clear it
 * cannot prove. Never throws.
 */
export async function readPendingApprovals(opts: PendingApprovalsOptions = {}): Promise<PendingApprovalsResponse> {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxPerSource = opts.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const sources: Record<PendingApprovalSource, PendingApprovalSourceQuality> = {
    proposal: { sourceState: 'degraded', complete: false, reason: 'not read' },
    draft: { sourceState: 'degraded', complete: false, reason: 'not read' },
    'team-approval': { sourceState: 'degraded', complete: false, reason: 'not read' },
  };
  const collected: PendingApprovalItem[] = [];
  let truncated = false;

  try {
    const read = listProposalsDetailed({ status: 'pending' });
    sources.proposal = {
      sourceState: read.sourceState,
      complete: read.complete,
      ...(read.stopReasons.length > 0 ? { reason: read.stopReasons.join(', ') } : {}),
    };
    const result = proposalItems(read.proposals, maxPerSource);
    truncated ||= result.truncated;
    collected.push(...result.items);
  } catch {
    sources.proposal = { sourceState: 'degraded', complete: false, reason: 'proposal store read failed' };
  }

  try {
    const result = await draftItems(opts.runsDir, maxPerSource);
    sources.draft = result.quality;
    truncated ||= result.truncated;
    collected.push(...result.items);
  } catch {
    sources.draft = { sourceState: 'degraded', complete: false, reason: 'draft store read failed' };
  }

  try {
    const result = teamApprovalItems(opts.maxTeams ?? DEFAULT_MAX_TEAMS, maxPerSource);
    sources['team-approval'] = result.quality;
    truncated ||= result.truncated;
    collected.push(...result.items);
  } catch {
    sources['team-approval'] = { sourceState: 'degraded', complete: false, reason: 'team log read failed' };
  }

  collected.sort(byCreatedAtAsc);
  const approvals = collected.slice(0, maxItems);
  if (collected.length > approvals.length) truncated = true;

  return {
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    dispatchEnabled: opts.allowDispatch === true,
    sources,
    approvals,
    truncated,
  };
}
