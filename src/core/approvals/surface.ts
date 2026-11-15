/**
 * The human "needs you" projection shared by `phm approvals --json`,
 * `GET /api/approvals` and the desktop Approvals panel (RQ-DESK-APPROVALS-1).
 *
 * Three independent sections, each reporting its own honest state so a broken
 * source never reads as "nothing pending":
 *   - teamApprovals: pending approvals folded from the team event log
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

export interface Section<T> { state: SectionState; reason?: string; items: T[] }

export interface ApprovalsProjection {
  generatedAt: string;
  team: string;
  teamApprovals: Section<TeamApprovalItem>;
  pins: Section<StagedPinItem> & { root: string };
  holds: Section<HoldItem> & { path: string; configured: boolean };
}

const WALK_FILE_CAP = 2000;
const WALK_DEPTH_CAP = 8;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

export function buildApprovalsProjection(team = DEFAULT_TEAM, now = Date.now()): ApprovalsProjection {
  return {
    generatedAt: new Date(now).toISOString(),
    team,
    teamApprovals: readTeamApprovals(team),
    pins: readStagedPins(undefined, now),
    holds: readHolds(),
  };
}

/** The human's click is the approval: identity comes from the local OS user, never the caller. */
export function decideTeamApproval(team: string, approvalId: string, decision: 'approve' | 'deny') {
  return decideApproval(team, localHumanActor(), approvalId, decision);
}
