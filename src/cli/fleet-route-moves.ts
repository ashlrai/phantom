import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';

const usage = 'Usage: phm fleet route-moves [--hours N] [--json]\nShow dispatcher route moves and refusals in the last N hours (default 6).';
export interface RouteMove { at: string; id: string; from: string; to: string; tier: string; refused: boolean }
export interface RouteMovesReport {
  schema: 'fleet.route-moves.v1'; hours: number; windowStart: string; windowEnd: string;
  moves: number; refused: number;
  pairs: Array<{ from: string; to: string; moves: number; refused: number }>;
  tiers: Array<{ tier: string; moves: number; refused: number }>;
  latest: RouteMove[];
}

/** Parse only dispatcher route records with valid local timestamps in the requested window. */
export function routeMoves(text: string, hours = 6, now = Date.now()): RouteMovesReport {
  const since = now - hours * 3_600_000;
  const events: RouteMove[] = [];
  const pairs = new Map<string, RouteMovesReport['pairs'][number]>();
  const tiers = new Map<string, RouteMovesReport['tiers'][number]>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (ROUTE|ROUTE_REFUSED) ([\w.-]+) ([\w.-]+) -> ([\w.-]+) \(tier ([\w.-]+)(?: (not accepted))?\)$/.exec(line);
    if (!m || (m[2] === 'ROUTE' && m[7]) || (m[2] === 'ROUTE_REFUSED' && !m[7])) continue;
    const ms = localTimestamp(m[1]!).ms;
    if (!Number.isFinite(ms) || ms < since || ms > now) continue;
    const event: RouteMove = { at: new Date(ms).toISOString(), id: m[3]!, from: m[4]!, to: m[5]!, tier: m[6]!, refused: m[2] === 'ROUTE_REFUSED' };
    events.push(event);
    const key = `${event.from}\0${event.to}`;
    const pair = pairs.get(key) ?? { from: event.from, to: event.to, moves: 0, refused: 0 };
    const tier = tiers.get(event.tier) ?? { tier: event.tier, moves: 0, refused: 0 };
    if (event.refused) { pair.refused++; tier.refused++; } else { pair.moves++; tier.moves++; }
    pairs.set(key, pair); tiers.set(event.tier, tier);
  }
  const moves = events.filter(event => !event.refused);
  return { schema: 'fleet.route-moves.v1', hours, windowStart: new Date(since).toISOString(), windowEnd: new Date(now).toISOString(),
    moves: moves.length, refused: events.length - moves.length,
    pairs: [...pairs.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    tiers: [...tiers.values()].sort((a, b) => a.tier.localeCompare(b.tier)),
    latest: moves.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10) };
}

export async function cmdFleetRouteMoves(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 6, seenHours = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours && args[i + 1]) {
      seenHours = true; const value = args[++i]!;
      if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 87600) { console.error(usage); return 2; }
      hours = Number(value);
    } else { console.error(usage); return 2; }
  }
  let text: string;
  try { text = await readFile(join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'dispatch-events.log'), 'utf8'); }
  catch { console.error('Unable to read dispatch-events.log'); return 1; }
  const report = routeMoves(text, hours);
  console.log(json ? JSON.stringify(report) : [
    `Last ${hours} hours: ${report.moves} moves, ${report.refused} refused`,
    'By route (moves, refused):', ...report.pairs.map(p => `  ${p.from} -> ${p.to}: ${p.moves}, ${p.refused}`),
    'By tier (moves, refused):', ...report.tiers.map(t => `  ${t.tier}: ${t.moves}, ${t.refused}`),
    'Latest moves:', ...report.latest.map(e => `  ${e.at} ${e.id} ${e.from} -> ${e.to} (tier ${e.tier})`),
  ].join('\n'));
  return 0;
}
