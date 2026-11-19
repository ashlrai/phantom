import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRouteMoves, type RouteMovesReport } from '../core/fleet/route-moves.js';

const usage = 'Usage: phm fleet route-moves [--hours N] [--json]\nShow dispatcher route moves and refusals in the last N hours (default 6).';

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
  let report: RouteMovesReport;
  try { report = await readRouteMoves(join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'dispatch-events.log'), hours); }
  catch { console.error('Unable to read dispatch-events.log'); return 1; }
  console.log(json ? JSON.stringify(report) : [
    `Last ${hours} hours: ${report.moves} moves, ${report.refused} refused`,
    'By route (moves, refused):', ...report.pairs.map(p => `  ${p.from} -> ${p.to}: ${p.moves}, ${p.refused}`),
    'By tier (moves, refused):', ...report.tiers.map(t => `  ${t.tier}: ${t.moves}, ${t.refused}`),
    'Latest moves:', ...report.latest.map(e => `  ${e.at} ${e.id} ${e.from} -> ${e.to} (tier ${e.tier})`),
  ].join('\n'));
  return 0;
}
