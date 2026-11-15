/**
 * Per-lane write budget: how many job files a planner pass may write right
 * now. Planner passes used to re-derive this from the `## LANES` lines by
 * hand and got it wrong in both directions; this module computes it once,
 * pure, so the brief and `ashlr fleet write-budget` give the same answer.
 */

export interface WriteBudgetLaneInput {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
}

export type WriteBudgetReason = 'held' | 'no-target' | 'claude-down' | 'at-target' | 'queued-covers' | 'open';

export interface WriteBudgetRow {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
  free: number;
  budget: number;
  reason: WriteBudgetReason;
}

export interface WriteBudgetPlan {
  v: 1;
  rows: WriteBudgetRow[];
  total: number;
}

/**
 * Lanes whose queued rows mostly wait on dependency gates, not on free
 * capacity, so queued must not shrink the budget.
 */
export const QUEUE_IGNORED_LANES: readonly string[] = ['devin', 'codex-local'];

/** claude-lane.state content that means the lane can accept work. */
const CLAUDE_OK = /^(ok|ready)\b/i;
// eslint-disable-next-line no-control-regex -- brief lines must stay a single printable line each.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Non-finite or negative counts become 0; everything else passes through. */
const count = (n: number): number => Number.isFinite(n) && n > 0 ? n : 0;

/**
 * Rules, in order: held → 0; no positive target → 0; the claude lane while
 * claude-lane.state is not ok/ready → 0; no free slots → 0; queue-ignored
 * lanes get every free slot; everyone else gets free minus queued. Input
 * order is kept.
 */
export function planWriteBudget(
  lanes: WriteBudgetLaneInput[],
  opts: { claudeLane: string; queueIgnored?: readonly string[] },
): WriteBudgetPlan {
  const ignored = new Set(opts.queueIgnored ?? QUEUE_IGNORED_LANES);
  const claudeOk = CLAUDE_OK.test(opts.claudeLane);
  const rows = lanes.map((input): WriteBudgetRow => {
    const running = count(input.running);
    const target = count(input.target);
    const queued = count(input.queued);
    const free = Math.max(0, target - running);
    const row = (budget: number, reason: WriteBudgetReason): WriteBudgetRow =>
      ({ lane: input.lane, running, target, queued, held: Boolean(input.held), free, budget, reason });
    if (input.held) return row(0, 'held');
    if (target <= 0) return row(0, 'no-target');
    if (input.lane === 'claude' && !claudeOk) return row(0, 'claude-down');
    if (free === 0) return row(0, 'at-target');
    if (ignored.has(input.lane)) return row(free, 'open');
    const budget = Math.max(0, free - queued);
    return row(budget, budget === 0 ? 'queued-covers' : 'open');
  });
  return { v: 1, rows, total: rows.reduce((sum, r) => sum + r.budget, 0) };
}

/**
 * One printable line per lane plus a `total N` trailer, e.g.
 * `devin 2 (free 2, queued ignored)` or `codex-personal 0 (free 4, queued 22
 * covers it)`. Pass the same queueIgnored list used for the plan when it
 * differs from the default.
 */
export function writeBudgetBriefLines(
  plan: WriteBudgetPlan,
  queueIgnored: readonly string[] = QUEUE_IGNORED_LANES,
): string[] {
  const ignored = new Set(queueIgnored);
  const out = plan.rows.map((row): string => {
    const lane = row.lane.replace(CONTROL, '');
    switch (row.reason) {
      case 'held': return `${lane} ${row.budget} (held)`;
      case 'no-target': return `${lane} ${row.budget} (no target)`;
      case 'claude-down': return `${lane} ${row.budget} (claude lane down)`;
      case 'at-target': return `${lane} ${row.budget} (at target)`;
      case 'queued-covers': return `${lane} ${row.budget} (free ${row.free}, queued ${row.queued} covers it)`;
      case 'open': return ignored.has(row.lane)
        ? `${lane} ${row.budget} (free ${row.free}, queued ignored)`
        : `${lane} ${row.budget} (free ${row.free}, queued ${row.queued})`;
    }
  });
  out.push(`total ${plan.total}`);
  return out;
}

/**
 * queue/status.json `lanes` object → planner inputs. Throws on any shape a
 * human or a stale dispatcher did not write: non-record root, missing or
 * non-record `lanes`, or a non-record lane row. Numeric fields that are
 * absent or non-finite read as 0.
 */
export function writeBudgetLanesFromStatus(parsed: unknown): WriteBudgetLaneInput[] {
  if (!record(parsed) || !record(parsed.lanes)) throw new Error('invalid lanes');
  return Object.entries(parsed.lanes).map(([lane, row]): WriteBudgetLaneInput => {
    if (!record(row)) throw new Error('invalid lane');
    const field = (key: string): number => typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : 0;
    return { lane, running: field('running'), target: field('target'), queued: field('queued'), held: Boolean(row.held) };
  });
}
