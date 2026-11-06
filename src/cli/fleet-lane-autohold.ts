/**
 * `ashlr fleet lane-autohold` — the action half of `fleet lane-streaks`.
 * Reads the dispatch-events tail, plans holds with planLaneAutoHold and,
 * with --apply, places each one through placeLaneHold under 'lane-autohold'
 * attribution (held_by 'phantom lane-autohold …'). Without --apply it only
 * prints the decisions. The verb runs once and starts no loop: whether an
 * unattended caller should re-run it is a Leader decision, not this
 * command's. A hold a person placed is reported skipped (manual-hold),
 * never overwritten.
 */
import { isAbsolute } from 'node:path';
import {
  laneEmptyStreaks,
  LANE_STREAKS_DEFAULT_MINUTES,
  LANE_STREAKS_MAX_MINUTES,
  LANE_STREAKS_MIN_MINUTES,
} from '../core/fleet/lane-empty-streak.js';
import {
  LANE_AUTOHOLD_MIN_EMPTIES,
  planLaneAutoHold,
  type LaneAutoHoldDecision,
} from '../core/fleet/lane-auto-hold.js';
import { LaneHoldError } from '../core/fleet/runs-lane-hold.js';
import { placeLaneHold } from '../core/fleet/runs-lane-hold-place.js';
import { readLaneTargets } from '../core/fleet/runs-lane-targets.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readDispatchEventsLog } from './fleet-lane-streaks.js';

const HOLD_MINUTES_DEFAULT = 60;
const HOLD_MINUTES_MIN = 5;
const HOLD_MINUTES_MAX = 240;

const usage = `Usage: ashlr fleet lane-autohold [--minutes <15..1440, default 90>] [--hold-minutes <5..240, default 60>] [--min-empties <n>] [--runs-dir <abs>] [--apply] [--json]
Plans bounded holds for lanes whose launches all end empty. Without --apply
it prints decisions and changes nothing; with --apply each 'hold' decision
goes through placeLaneHold (changedBy 'lane-autohold'). A person's hold is
skipped, never overwritten. Runs once — no loop. Exit 0 on success, 1 on
unavailable events/targets or a failed placement, 2 on usage.`;

interface Dependencies {
  now?: () => Date;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

interface DecisionRow {
  lane: string;
  action: LaneAutoHoldDecision['action'];
  result: 'would-hold' | 'held' | 'skipped' | 'error';
  /** Skip code for refusals; the 'burning: …' detail for holds. */
  reason: string | null;
  launches: number;
  empties: number;
  heldUntil: string | null;
}

interface AutoHoldReport {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  applied: boolean;
  windowMinutes: number;
  holdMinutes: number;
  minEmpties: number;
  decisions: DecisionRow[];
}

function line(row: DecisionRow): string {
  const detail = row.reason === null ? '' : `  ${safe(row.reason)}`;
  if (row.result === 'held') return `${safe(row.lane)}  held  until ${safe(row.heldUntil)}${detail}`;
  if (row.result === 'would-hold') return `${safe(row.lane)}  would-hold${detail}`;
  return `${safe(row.lane)}  ${row.result}${detail}`;
}

export async function cmdFleetLaneAutohold(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, apply = false;
  let minutesArg: string | undefined, holdArg: string | undefined, minArg: string | undefined, runsDir: string | undefined;
  const intFlag = (value: string | undefined, min: number, max: number): string | null =>
    typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max ? value : null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--minutes' && minutesArg === undefined) {
      minutesArg = intFlag(args[++i], LANE_STREAKS_MIN_MINUTES, LANE_STREAKS_MAX_MINUTES) ?? undefined;
      if (minutesArg === undefined) return invalid();
    } else if (arg === '--hold-minutes' && holdArg === undefined) {
      holdArg = intFlag(args[++i], HOLD_MINUTES_MIN, HOLD_MINUTES_MAX) ?? undefined;
      if (holdArg === undefined) return invalid();
    } else if (arg === '--min-empties' && minArg === undefined) {
      minArg = intFlag(args[++i], 1, 1000) ?? undefined;
      if (minArg === undefined) return invalid();
    } else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  const windowMinutes = Number(minutesArg ?? LANE_STREAKS_DEFAULT_MINUTES);
  const holdMinutes = Number(holdArg ?? HOLD_MINUTES_DEFAULT);
  const minEmpties = Number(minArg ?? LANE_AUTOHOLD_MIN_EMPTIES);
  // Keep the events tail and slots.json on one root: ASHLR_RUNS_DIR is the
  // same fallback readLaneTargets/placeLaneHold apply inside core.
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? undefined;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const report: AutoHoldReport = {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    source: 'ok',
    applied: apply,
    windowMinutes,
    holdMinutes,
    minEmpties,
    decisions: [],
  };
  let text: string | null = null;
  try { text = await readDispatchEventsLog(root); } catch { text = null; }
  if (text === null) {
    report.source = 'unavailable';
    if (json) output(JSON.stringify(sanitizePublicJson(report)));
    else output('lane-autohold: dispatch events unavailable');
    return 1;
  }
  const streaks = laneEmptyStreaks(text, nowMs, windowMinutes);
  const targets = await readLaneTargets({ runsDir });
  if (targets.sourceState !== 'healthy') {
    report.source = 'unavailable';
    if (json) output(JSON.stringify(sanitizePublicJson(report)));
    else output(`lane-autohold: lane targets unavailable (${targets.sourceState})`);
    return 1;
  }
  const detail = (decision: LaneAutoHoldDecision): string =>
    `burning: ${decision.empties} of ${decision.launches} empty in ${windowMinutes} min`;
  const rows: DecisionRow[] = planLaneAutoHold(streaks, targets, { minEmpties }).map((decision) => ({
    lane: decision.lane,
    action: decision.action,
    result: decision.action === 'hold' ? 'would-hold' : 'skipped',
    reason: decision.action === 'hold' ? detail(decision) : decision.reason,
    launches: decision.launches,
    empties: decision.empties,
    heldUntil: null,
  }));
  let failed = false;
  if (apply) {
    for (const row of rows) {
      if (row.action !== 'hold') continue;
      try {
        const state = await placeLaneHold(row.lane, {
          runsDir, minutes: holdMinutes, reason: row.reason!, changedBy: 'lane-autohold', now: deps.now,
        });
        row.result = 'held';
        row.heldUntil = state.lanes.find((entry) => entry.lane === row.lane)?.heldUntil ?? null;
      } catch (err) {
        if (err instanceof LaneHoldError && err.code === 'manual-hold') {
          row.result = 'skipped';
          row.reason = 'manual-hold';
        } else {
          row.result = 'error';
          row.reason = err instanceof LaneHoldError ? err.code : 'unavailable';
          failed = true;
        }
      }
    }
  }
  report.decisions = rows;
  if (json) {
    output(JSON.stringify(sanitizePublicJson(report)));
  } else if (!rows.length) {
    output(`lane-autohold: no lanes meet the hold bar in the last ${windowMinutes} min`);
  } else {
    for (const row of rows) output(line(row));
  }
  return failed ? 1 : 0;
}
