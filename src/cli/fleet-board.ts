/**
 * `phm fleet board` — read the Leader-as-CEO board the last Leader tick wrote
 * to <runs>/coordination/leader-board.json (core/fleet/leader-board.ts).
 * Read-only; a missing board means no tick has recorded one yet.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LEADER_BOARD_SCHEMA, readLeaderBoard, type LeaderBoardRead, type LeaderBoardV1 } from '../core/fleet/leader-board.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm fleet board [--json] [--runs-dir DIR]
  --runs-dir DIR  Read DIR/coordination/leader-board.json (default: ASHLR_RUNS_DIR or ~/.ashlr-runs).
Prints the last Leader tick's board: lanes, queue depth by tier, merges in the
last hour, the conflicting-PR trend and items needing Mason. Read-only.`;

export interface FleetBoardDeps {
  /** Board reader; injectable so tests never touch a real runs dir. */
  readBoard?: (opts: { runsDir?: string }) => Promise<LeaderBoardRead>;
  now?: () => number;
}

const cell = (n: number | null | undefined): string => (n === null || n === undefined ? 'unknown' : String(n));

function plainLines(board: LeaderBoardV1): string[] {
  const lines = [
    `Leader board — ${board.generatedAt}`,
    `merges last hour: ${cell(board.mergesLastHour)}`,
    `conflicting PRs: ${cell(board.conflictingPrs.count)} (${board.conflictingPrs.trend}${board.conflictingPrs.delta === null ? '' : `, ${board.conflictingPrs.delta >= 0 ? '+' : ''}${board.conflictingPrs.delta}`})`,
  ];
  const tiers = board.queueDepthByTier;
  lines.push(tiers === null
    ? 'queue depth by tier: unknown'
    : `queue depth by tier: ${Object.entries(tiers).sort(([a], [b]) => a.localeCompare(b)).map(([tier, n]) => `${tier} ${n}`).join(', ') || 'none'}`);
  if (board.lanes.length === 0) lines.push('lanes: none observed');
  for (const lane of board.lanes) {
    lines.push(`lane ${lane.lane}  ready ${cell(lane.ready)}  parked ${cell(lane.parked)}  running ${cell(lane.running)}  merges/h ${cell(lane.mergesLastHour)}`);
  }
  lines.push(`needs Mason: ${board.needsMason.count} item(s)${board.needsMason.status === 'available' ? '' : ` (${board.needsMason.status})`}`);
  for (const item of board.needsMason.items) lines.push(`  ${item.id}  ${item.text}`);
  return lines;
}

export async function cmdFleetBoard(args: string[], deps: FleetBoardDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  let json = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const inline = arg.startsWith('--runs-dir=') ? arg.slice('--runs-dir='.length) : undefined;
    const next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next !== undefined && !next.startsWith('-')) { runsDir = next; i++; }
    else if (inline !== undefined && inline !== '' && runsDir === undefined) runsDir = inline;
    else {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }
  const read = deps.readBoard ?? readLeaderBoard;
  const result = await read({ runsDir: runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs') });
  const nowMs = (deps.now ?? Date.now)();
  const board = result.board;
  const ageMs = board === null ? null : Math.max(0, nowMs - Date.parse(board.generatedAt));
  const ageSeconds = ageMs === null || !Number.isFinite(ageMs) ? null : Math.floor(ageMs / 1000);
  if (json) {
    console.log(JSON.stringify(sanitizePublicJson({
      schema: LEADER_BOARD_SCHEMA, status: result.status, ageSeconds, board,
    })));
  } else if (board === null) {
    console.log(result.status === 'missing'
      ? 'No Leader board yet — no Leader tick has recorded one.'
      : 'Leader board is unreadable.');
  } else {
    for (const line of plainLines(board)) console.log(line);
  }
  return result.status === 'unavailable' ? 1 : 0;
}
