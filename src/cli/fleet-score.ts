/** `phm fleet score`: one scoreboard of what the fleet optimizes, with a trend for each number. */
import { join, resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { readScoreboard, scoreboardDays, scoreboardText, SCOREBOARD_MAX_DAYS } from '../core/fleet/scoreboard.js';
import { trendWindow, type TrendWindow } from '../core/fleet/scoreboard-trend.js';
import { usageHistoryPath } from '../core/fleet/usage-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet score [--days <n>] [--trend 24h|7d] [--json] [--runs-dir <directory>]
One scoreboard: merged PRs, median time to merge, starts, empty finishes, merged per start and the
share of merged PRs that improve phantom itself. The first line says what improved most and what
worsened most. Shown per hour for the last 24 hours and per day,
each with a trend against the window before (up, down, flat or unknown). Read-only; a number with
no data prints as unknown, never zero.
  --days <n>         days in the daily view, 1 to ${SCOREBOARD_MAX_DAYS}, default 7
  --trend 24h|7d     how each number moved: 24 hourly or 7 days in 6-hour buckets, plus each plan's used percent;
                     no data is a gap, a reset is marked. Default 24h in the text; JSON has it only when asked
  --json             print JSON (schema fleet.scoreboard.v1), the same read as GET /api/verse/fleet/runs/scoreboard
  --runs-dir <dir>   fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
Reads <runs-dir>/metrics/jobs.jsonl; exit 1 when it cannot be read, 2 on a bad option.`;

export interface FleetScoreDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export async function cmdFleetScore(args: string[], deps: FleetScoreDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false, trendArg: string | undefined, daysArg: string | undefined, runsArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--trend' && trendArg === undefined && next && !next.startsWith('-')) trendArg = args[++i];
    else if (arg === '--days' && daysArg === undefined && next && !next.startsWith('-')) daysArg = args[++i];
    else if (arg === '--runs-dir' && runsArg === undefined && next && !next.startsWith('-')) runsArg = args[++i];
    else { err(`phm fleet score: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const days = scoreboardDays(daysArg);
  if (days === null) { err(`phm fleet score: --days takes a whole number from 1 to ${SCOREBOARD_MAX_DAYS}\n${usage}`); return 2; }
  const trend: TrendWindow | null | undefined = trendArg === undefined ? (json ? undefined : '24h') : trendWindow(trendArg);
  if (trend === null) { err(`phm fleet score: --trend takes 24h or 7d\n${usage}`); return 2; }
  const runsDir = runsArg ? resolve(runsArg) : defaultRunsDir();
  const board = await readScoreboard({ metricsPath: join(runsDir, 'metrics', 'jobs.jsonl'), days, now: (deps.now ?? Date.now)(),
    ...(trend === undefined ? {} : { trend, usagePath: usageHistoryPath(runsDir) }) });
  out(json ? JSON.stringify(sanitizePublicJson(board)) : scoreboardText(board).join('\n'));
  return board.metrics === 'ok' ? 0 : 1;
}
