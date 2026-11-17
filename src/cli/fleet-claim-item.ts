/**
 * `ashlr fleet claim-item <board-item-id> --agent <id> --repo <owner/name>
 * [--ttl-minutes N] [--json]` — the producer side of the claim-board-ref
 * contract. Takes an advisory coordination claim whose task carries exactly
 * one `[board:<id>]` token, so `ashlr fleet recheck` can bind the board item's
 * owner to a durable ledger claim. Refuses unless the item is on the work
 * board, RUNNING or ASSIGNED, and owned by --agent. The claim coordinates only:
 * it grants no execution or dispatch authority and sends nothing. The lease is
 * printed exactly once on success (it fences release/handoff) and nowhere else.
 */
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard, WORK_BOARD_MAX_LIMIT, type WorkBoardResult } from '../core/comms/work-board.js';
import { formatBoardRef, withBoardRef } from '../core/fleet/claim-board-ref.js';
import { claimFleetWork, type FleetClaim, type FleetCoordinationResult } from '../core/fleet/coordination.js';

const USAGE = 'Usage: ashlr fleet claim-item <board-item-id> --agent <id> --repo <owner/name> [--ttl-minutes N] [--json]';
export const FLEET_CLAIM_ITEM_HELP = [
  USAGE,
  '  Claim a RUNNING or ASSIGNED work-board item owned by --agent in the coordination ledger.',
  '  The claim task carries [board:<id>] so `ashlr fleet recheck` can verify the task section.',
  '  Prints the lease once; keep it private, it fences release and handoff.',
  '  Exit 0 claimed, 1 refused/unavailable/duplicate, 2 bad arguments.',
].join('\n');

/** Ledger cap (coordination.ts MAX_TTL_MS = 7 days). */
const TTL_MINUTES_MAX = 7 * 24 * 60;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

type ClaimFn = (input: { repo: string; task: string; agent: string; ttlMs?: number }) =>
  FleetCoordinationResult<{ claim: FleetClaim; lease: string }>;

export interface FleetClaimItemDeps {
  now?: () => number;
  listWorkBoard?: (now: number) => WorkBoardResult;
  claimFleetWork?: ClaimFn;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface Parsed { itemId: string; agent: string; repo: string; ttlMs: number | undefined; json: boolean }

function parse(args: string[]): Parsed | string {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { if (json) return 'duplicate --json'; json = true; continue; }
    if (arg === '--agent' || arg === '--repo' || arg === '--ttl-minutes') {
      const value = args[++i];
      if (values[arg] !== undefined) return `duplicate ${arg}`;
      if (value === undefined || value.startsWith('-')) return `${arg} needs a value`;
      values[arg] = value;
    } else if (arg.startsWith('-')) return `unknown flag ${arg}`;
    else positional.push(arg);
  }
  if (positional.length !== 1) return 'exactly one <board-item-id> is required';
  const itemId = positional[0]!;
  if (formatBoardRef(itemId) === null) return `invalid board item id ${JSON.stringify(itemId)}`;
  const agent = values['--agent'];
  if (agent === undefined || !AGENT.test(agent)) return '--agent <id> is required and must be a coordination id';
  const repo = values['--repo'];
  if (repo === undefined || !REPO.test(repo)) return '--repo <owner/name> is required';
  const ttl = values['--ttl-minutes'];
  let ttlMs: number | undefined;
  if (ttl !== undefined) {
    if (!/^[1-9]\d{0,4}$/.test(ttl) || Number(ttl) > TTL_MINUTES_MAX) return `--ttl-minutes must be 1..${TTL_MINUTES_MAX}`;
    ttlMs = Number(ttl) * 60_000;
  }
  return { itemId, agent, repo, ttlMs, json };
}

export async function cmdFleetClaimItem(args: string[], deps: FleetClaimItemDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  if (args.includes('--help') || args.includes('-h')) { out(FLEET_CLAIM_ITEM_HELP); return 0; }
  const parsed = parse(args);
  if (typeof parsed === 'string') { err(`fleet claim-item: ${parsed}\n${FLEET_CLAIM_ITEM_HELP}`); return 2; }
  const { itemId, agent, repo, ttlMs, json } = parsed;
  const refuse = (reason: string): number => {
    if (json) out(JSON.stringify({ ok: false, boardItem: itemId, reason }));
    else err(`fleet claim-item: ${reason}`);
    return 1;
  };

  const now = (deps.now ?? Date.now)();
  // Same root as defaultFleetRecheckDeps, read at the maximum page size so an
  // item recheck can see is not refused merely for sitting past the default page.
  const readBoard = deps.listWorkBoard
    ?? ((at: number) => listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: at, limit: WORK_BOARD_MAX_LIMIT }));
  let board: WorkBoardResult;
  try { board = readBoard(now); } catch { return refuse('work board unreadable'); }
  if (board.inbox !== 'ok') return refuse(`work board inbox ${board.inbox}`);
  const item = board.items.find(candidate => candidate.id === itemId);
  if (item === undefined) {
    return refuse(`board item ${itemId} not found${board.truncated ? ' (work board truncated)' : ''}`);
  }
  if (item.state !== 'RUNNING' && item.state !== 'ASSIGNED') {
    return refuse(`board item ${itemId} is ${item.state}, not RUNNING or ASSIGNED`);
  }
  if (item.owner !== agent) {
    return refuse(item.owner === null
      ? `board item ${itemId} has no named owner; --agent ${agent} is not its owner`
      : `board item ${itemId} is owned by ${item.owner}, not ${agent}`);
  }

  // Short, body-free summary: the item's channel label and id, never message text.
  const task = withBoardRef(`work-board ${item.channel} item ${itemId}`, itemId);
  if (task === null) return refuse(`cannot form a [board:${itemId}] task`);
  const claim = deps.claimFleetWork ?? ((input: Parameters<ClaimFn>[0]) => claimFleetWork(input));
  let result: ReturnType<ClaimFn>;
  try { result = claim({ repo, task, agent, ttlMs }); } catch { return refuse('coordination ledger unavailable'); }
  if (!result.ok) {
    if (result.error === 'invalid-input') { err(`fleet claim-item: ledger rejected the claim as invalid input`); return 2; }
    return refuse(result.error === 'duplicate'
      ? `a claim for [board:${itemId}] in ${repo} already exists`
      : `coordination ledger ${result.error}`);
  }
  const { claim: claimed, lease } = result.value;
  if (json) {
    out(JSON.stringify({
      ok: true, boardItem: itemId,
      claim: { ...claimed, claimedAt: new Date(claimed.claimedAt).toISOString(), expiresAt: new Date(claimed.expiresAt).toISOString() },
      lease,
    }));
  } else {
    out(`claimed ${claimed.id} for board item ${itemId} lease=${lease}`);
  }
  return 0;
}
