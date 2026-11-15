/** Show how fast allowlisted teammate (Dot) iMessages get answered, and the oldest unanswered one. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTeammateLatency, type TeammateLatencySummary } from '../core/comms/teammate-reply-latency.js';

const usage = 'Usage: ashlr fleet teammate-latency [--window-hours <1-168>] [--target-minutes <1-120>] [--runs-dir <path>] [--json]';

export interface FleetTeammateLatencyDeps {
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Overrides --runs-dir / ASHLR_RUNS_DIR / ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
}

const mins = (m: number | null): string => (m === null ? '-' : `${m}m`);

export function formatLatencyLine(s: TeammateLatencySummary): string {
  const oldest = s.oldestUnanswered
    ? `row ${s.oldestUnanswered.rowid}, ${s.oldestUnanswered.ageMinutes}m, ${s.oldestUnanswered.intent}`
    : 'none';
  return `Dot texts ${s.windowHours}h: ${s.texts}, answered ${s.answered} (median ${mins(s.medianMinutes)}, p90 ${mins(s.p90Minutes)}, max ${mins(s.maxMinutes)}), ${s.withinTarget} within ${s.targetMinutes}m; oldest unanswered: ${oldest}`;
}

export async function cmdFleetTeammateLatency(args: string[], deps: FleetTeammateLatencyDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output(`${usage}\nSummarize answer latency for teammate texts (median, p90, max, within target) and the oldest unanswered text.\nExit 2 on invalid arguments, 1 when the source is unreadable.`);
    return 0;
  }
  let runsFlag: string | undefined;
  let windowHours = 24;
  let targetMinutes = 5;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' || arg === '--window-hours' || arg === '--target-minutes') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return invalid();
      if (arg === '--runs-dir') { runsFlag = value; continue; }
      if (!/^\d{1,3}$/.test(value)) return invalid();
      const n = Number(value);
      if (arg === '--window-hours') {
        if (n < 1 || n > 168) return invalid();
        windowHours = n;
      } else {
        if (n < 1 || n > 120) return invalid();
        targetMinutes = n;
      }
    } else return invalid();
  }
  const runsDir = runsFlag ?? deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const summary = readTeammateLatency({ runsDir, now: deps.now, windowMs: windowHours * 3_600_000, targetMinutes });
  output(json ? JSON.stringify(summary) : formatLatencyLine(summary));
  // A degraded source that yielded no texts at all is unreadable, not merely quiet.
  if (summary.sourceState === 'degraded' && summary.texts === 0) {
    error('error: teammates.jsonl is unreadable');
    return 1;
  }
  return 0;

  function invalid(): number {
    error(`error: invalid arguments. ${usage}`);
    return 2;
  }
}
