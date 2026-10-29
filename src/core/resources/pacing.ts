/**
 * Receding-horizon pace for one pool's own reset window.
 *
 * The plan spends the remaining quota by the reset. A tick may spend only
 * the first period, and only up to the safety hold that is still in force
 * now. Unused allowance stays in the remainder and is replanned next cycle.
 * Advisory only: quota eligibility, freshness and dispatch remain caller gates.
 * The hold shrinks to zero over the last buffer window, which is also when
 * the Grok Ultra orchestration reserve is released.
 */

/** Optional LP adapter. The caller owns solver loading; no provider is invoked here. */
export interface PaceSolverOutcome {
  status: 'optimal' | 'infeasible' | 'failed' | 'timeout';
  values: Readonly<Record<string, number>>;
}
export type PaceSolver = (lp: string, budgetMs: number) => Promise<PaceSolverOutcome>;

export interface HorizonKnobs {
  bufferFraction: number;
  bufferWindowMs: number;
  reserveFraction: number;
  flex: number;
  deviationWeight: number;
  flexPenalty: number;
  landingWeight: number;
  periodMs: number;
  maxPeriods: number;
}

export interface PacePoint {
  atMs: number;
  /** Observed burn. Null after now: later points are not readings. */
  actualCumulative: number | null;
  /** Straight line from 0 at the window start to 1 at reset. */
  idealPace: number;
  /** Planned cumulative from the latest derived used fraction. */
  projectedCumulative: number | null;
}

export interface PoolPaceSeries {
  poolId: string;
  projection: 'derived';
  isReading: false;
  actualCumulative: number | null;
  idealPaceNow: number | null;
  projectedLanding: number | null;
  uncertainty: number;
  stale: boolean;
  readingAgeMs: number | null;
  readingSource: 'manual' | 'config' | null;
  points: PacePoint[];
}

export interface ReadingStamp {
  source: 'manual' | 'config';
  atMs: number;
  ageMs: number;
  stale: boolean;
  uncertainty: number;
}

interface Period {
  startMs: number;
  endMs: number;
  natural: number;
  ceiling: number;
}

export interface PacePlan {
  periods: Period[];
  spends: number[];
  /** What this tick may spend. The safety hold still in force is applied. */
  allowance: number;
  projectedLanding: number;
  series: PoolPaceSeries;
}

export interface HorizonPlan extends PacePlan {
  solver: 'lp' | 'even';
}

/** Fraction held back. Full until the window, then linear to 0 at reset. */
export function safetyBuffer(timeLeftMs: number, fraction: number, windowMs: number): number {
  if (!Number.isFinite(timeLeftMs) || !Number.isFinite(fraction) || fraction < 0 || fraction > 1
      || !Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('Invalid safety buffer');
  if (fraction <= 0 || timeLeftMs <= 0) return 0;
  const ramp = Math.max(0, Math.min(1, timeLeftMs / windowMs));
  return fraction * ramp;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function idealAt(windowStartMs: number, resetAtMs: number, atMs: number): number {
  const window = resetAtMs - windowStartMs;
  if (window <= 0) return atMs >= resetAtMs ? 1 : 0;
  return clamp01((atMs - windowStartMs) / window);
}

function holdAt(timeLeftMs: number, knobs: Pick<HorizonKnobs, 'bufferFraction' | 'bufferWindowMs' | 'reserveFraction'>): number {
  return safetyBuffer(timeLeftMs, knobs.bufferFraction, knobs.bufferWindowMs)
    + safetyBuffer(timeLeftMs, knobs.reserveFraction, knobs.bufferWindowMs);
}

function buildPeriods(nowMs: number, resetAtMs: number, windowStartMs: number, knobs: HorizonKnobs, used: number): Period[] {
  const timeLeft = resetAtMs - nowMs;
  if (timeLeft <= 0) return [];
  const window = Math.max(1, resetAtMs - windowStartMs);
  const count = Math.min(knobs.maxPeriods, Math.ceil(timeLeft / knobs.periodMs));
  const step = Math.ceil(timeLeft / knobs.periodMs) > knobs.maxPeriods
    ? timeLeft / knobs.maxPeriods : knobs.periodMs;
  const periods: Period[] = [];
  let cursor = nowMs;
  let prevCeiling = used;
  const flexSlack = Math.max(0, knobs.flex - 1) * (knobs.periodMs / window);
  for (let index = 0; index < count; index += 1) {
    const endMs = index === count - 1 ? resetAtMs : Math.min(resetAtMs, cursor + step);
    const cap = Math.min(1 - holdAt(resetAtMs - endMs, knobs),
      idealAt(windowStartMs, resetAtMs, endMs) + flexSlack);
    const ceiling = Math.max(prevCeiling, clamp01(cap));
    periods.push({ startMs: cursor, endMs, natural: (endMs - cursor) / window, ceiling });
    prevCeiling = ceiling;
    cursor = endMs;
  }
  return periods;
}

function evenSpends(used: number, periods: readonly Period[]): number[] {
  const planned = new Array<number>(periods.length).fill(0);
  let cursor = used;
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index]!;
    const room = Math.max(0, period.ceiling - cursor);
    const spend = Math.min(period.natural, room);
    planned[index] = spend;
    cursor += spend;
  }
  let short = Math.max(0, 1 - used - planned.reduce((sum, spend) => sum + spend, 0));
  for (let index = planned.length - 1; index >= 0 && short > 1e-9; index -= 1) {
    const room = roomForAdd(used, periods, planned, index);
    const add = Math.min(short, room);
    planned[index] = (planned[index] ?? 0) + add;
    short -= add;
  }
  return planned.map((spend) => Math.max(0, spend));
}

function roomForAdd(used: number, periods: readonly Period[], spends: readonly number[], index: number): number {
  let room = Number.POSITIVE_INFINITY;
  let cursor = used;
  for (let step = 0; step < periods.length; step += 1) {
    cursor += spends[step] ?? 0;
    if (step >= index) room = Math.min(room, periods[step]!.ceiling - cursor);
  }
  return Math.max(0, room);
}

function committed(plannedFirst: number, used: number, timeLeftMs: number, knobs: HorizonKnobs): number {
  if (timeLeftMs <= 0) return 0;
  const room = Math.max(0, 1 - holdAt(timeLeftMs, knobs) - used);
  return Math.max(0, Math.min(plannedFirst, room));
}

function seriesFor(input: {
  poolId: string;
  used: number;
  nowMs: number;
  resetAtMs: number;
  windowStartMs: number;
  periods: readonly Period[];
  spends: readonly number[];
  stamp: ReadingStamp | null;
}): PoolPaceSeries {
  const points: PacePoint[] = [{
    atMs: input.nowMs,
    actualCumulative: input.stamp?.atMs === input.nowMs ? input.used : null,
    idealPace: idealAt(input.windowStartMs, input.resetAtMs, input.nowMs),
    projectedCumulative: input.used,
  }];
  if (input.stamp && input.stamp.atMs < input.nowMs) {
    points.unshift({ atMs: input.stamp.atMs, actualCumulative: input.used,
      idealPace: idealAt(input.windowStartMs, input.resetAtMs, input.stamp.atMs), projectedCumulative: null });
  }
  let cursor = input.used;
  input.periods.forEach((period, index) => {
    cursor += input.spends[index] ?? 0;
    points.push({
      atMs: period.endMs,
      actualCumulative: null,
      idealPace: idealAt(input.windowStartMs, input.resetAtMs, period.endMs),
      projectedCumulative: cursor,
    });
  });
  return {
    poolId: input.poolId,
    projection: 'derived',
    isReading: false,
    actualCumulative: input.stamp ? input.used : null,
    idealPaceNow: idealAt(input.windowStartMs, input.resetAtMs, input.nowMs),
    projectedLanding: cursor,
    uncertainty: input.stamp?.uncertainty ?? 1,
    stale: input.stamp?.stale ?? true,
    readingAgeMs: input.stamp?.ageMs ?? null,
    readingSource: input.stamp?.source ?? null,
    points,
  };
}

function validateInput(input: {
  used: number; nowMs: number; resetAtMs: number; windowStartMs: number;
  knobs: HorizonKnobs; stamp?: ReadingStamp | null;
}): void {
  const { knobs, stamp } = input;
  if (![input.nowMs, input.resetAtMs, input.windowStartMs].every(Number.isSafeInteger)
      || input.windowStartMs >= input.resetAtMs || input.nowMs < input.windowStartMs
      || !Number.isFinite(input.used) || input.used < 0 || input.used > 1
      || ![knobs.bufferFraction, knobs.reserveFraction].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
      || knobs.bufferFraction + knobs.reserveFraction > 1
      || !Number.isFinite(knobs.bufferWindowMs) || knobs.bufferWindowMs <= 0
      || !Number.isFinite(knobs.periodMs) || knobs.periodMs < 1
      || !Number.isInteger(knobs.maxPeriods) || knobs.maxPeriods < 1 || knobs.maxPeriods > 256
      || !Number.isFinite(knobs.flex) || knobs.flex < 1 || knobs.flex > 100
      || ![knobs.deviationWeight, knobs.flexPenalty, knobs.landingWeight]
        .every((v) => Number.isFinite(v) && v >= 0 && v <= 1e6)) {
    throw new RangeError('Invalid pacing window or knobs');
  }
  if (stamp && (!['manual', 'config'].includes(stamp.source)
      || !Number.isSafeInteger(stamp.atMs) || stamp.atMs > input.nowMs
      || stamp.atMs < input.windowStartMs
      || !Number.isFinite(stamp.ageMs) || stamp.ageMs !== input.nowMs - stamp.atMs
      || typeof stamp.stale !== 'boolean'
      || !Number.isFinite(stamp.uncertainty) || stamp.uncertainty < 0 || stamp.uncertainty > 1)) {
    throw new RangeError('Invalid pacing reading stamp');
  }
}

export function paceWindow(input: {
  poolId: string;
  used: number;
  nowMs: number;
  resetAtMs: number;
  windowStartMs: number;
  knobs: HorizonKnobs;
  stamp?: ReadingStamp | null;
}): PacePlan {
  validateInput(input);
  const used = input.used;
  const periods = buildPeriods(input.nowMs, input.resetAtMs, input.windowStartMs, input.knobs, used);
  const spends = evenSpends(used, periods);
  const allowance = committed(spends[0] ?? Math.max(0, 1 - used), used, input.resetAtMs - input.nowMs, input.knobs);
  const series = seriesFor({
    poolId: input.poolId,
    used,
    nowMs: input.nowMs,
    resetAtMs: input.resetAtMs,
    windowStartMs: input.windowStartMs,
    periods,
    spends,
    stamp: input.stamp ?? null,
  });
  return { periods, spends, allowance, projectedLanding: series.projectedLanding ?? used, series };
}

function valuesVary(values: readonly number[]): boolean {
  if (values.length <= 1) return false;
  const first = values[0] ?? 0;
  return values.some((value) => value !== first);
}

function objectiveTerm(coef: number, name: string): string {
  const abs = Math.abs(coef).toFixed(12);
  return coef < 0 ? `- ${abs} ${name}` : `${abs} ${name}`;
}

function buildPaceLp(used: number, periods: readonly Period[], spends: readonly number[], values: readonly number[], knobs: HorizonKnobs): string {
  const target = Math.max(0, 1 - used);
  const lines = ['Maximize'];
  const terms: string[] = [];
  periods.forEach((_, index) => {
    const value = values[index] ?? values[values.length - 1] ?? 1;
    terms.push(objectiveTerm(value, `s${index}`));
    terms.push(objectiveTerm(-knobs.deviationWeight, `d${index}`));
    terms.push(objectiveTerm(-knobs.flexPenalty, `o${index}`));
  });
  terms.push(objectiveTerm(-knobs.landingWeight, 'short'));
  const body = terms.map((term, index) => (index === 0 || term.startsWith('-') ? term : `+ ${term}`)).join(' ');
  lines.push(` obj: ${body}`);
  lines.push('Subject To');
  let cumulative = '';
  periods.forEach((period, index) => {
    cumulative = cumulative === '' ? `s${index}` : `${cumulative} + s${index}`;
    lines.push(` cum${index}: ${cumulative} <= ${Math.max(0, period.ceiling - used).toFixed(12)}`);
    const ideal = spends[index] ?? period.natural;
    lines.push(` devhi${index}: s${index} - d${index} <= ${ideal.toFixed(12)}`);
    lines.push(` devlo${index}: - s${index} - d${index} <= ${(-ideal).toFixed(12)}`);
    lines.push(` flex${index}: s${index} - o${index} <= ${(knobs.flex * period.natural).toFixed(12)}`);
  });
  const names = periods.map((_, index) => `s${index}`).join(' + ');
  lines.push(names === '' ? ' land: short = 0' : ` land: ${names} + short = ${target.toFixed(12)}`);
  lines.push('Bounds');
  periods.forEach((_, index) => {
    lines.push(` 0 <= s${index} <= 1`);
    lines.push(` 0 <= d${index}`);
    lines.push(` 0 <= o${index}`);
  });
  lines.push(' 0 <= short');
  lines.push('End');
  return `${lines.join('\n')}\n`;
}

async function flexSpends(used: number, periods: readonly Period[], even: readonly number[], values: readonly number[], knobs: HorizonKnobs, solver: PaceSolver, budgetMs: number): Promise<number[] | null> {
  if (periods.length === 0 || !valuesVary(values)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The deadline bounds async adapters. A synchronous solver must enforce its
    // own budget (or run in a worker); JavaScript cannot preempt a blocking call.
    const outcome = await Promise.race([
      Promise.resolve().then(() => solver(buildPaceLp(used, periods, even, values, knobs), budgetMs)),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); }),
    ]);
    if (!outcome || outcome.status !== 'optimal') return null;
    const spends = periods.map((_, index) => outcome.values[`s${index}`]);
    if (!spends.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
    const target = 1 - used;
    if (Math.abs(spends.reduce((sum, spend) => sum + spend, 0) - target) > 1e-8) return null;
    let cursor = used;
    for (let index = 0; index < periods.length; index += 1) {
      const cap = Math.min(1, periods[index]!.ceiling);
      if (cursor + spends[index]! > cap + 1e-8) return null;
      // Remove solver roundoff before exposing any spend, so accepted plans
      // never grant more than the actual cumulative ceiling or remaining quota.
      spends[index] = Math.min(spends[index]!, Math.max(0, cap - cursor));
      cursor += spends[index]!;
    }
    return spends;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function planHorizon(input: {
  poolId: string;
  used: number;
  nowMs: number;
  resetAtMs: number;
  windowStartMs: number;
  values?: readonly number[];
  knobs: HorizonKnobs;
  stamp?: ReadingStamp | null;
  solver?: PaceSolver;
  solverBudgetMs?: number;
}): Promise<HorizonPlan> {
  // Isolate the result from caller mutation while an asynchronous adapter runs.
  input = { ...input, knobs: { ...input.knobs }, values: Array.from(input.values ?? []),
    stamp: input.stamp ? { ...input.stamp } : null };
  const base = paceWindow(input);
  const values = input.values ?? [];
  const budgetMs = input.solverBudgetMs ?? 100;
  if (!values.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e6)
      || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000) {
    throw new RangeError('Invalid pacing values or solver budget');
  }
  if (!input.solver || !valuesVary(values)) {
    return { ...base, solver: 'even' };
  }
  const flexed = await flexSpends(
    clamp01(input.used),
    base.periods,
    base.spends,
    values,
    input.knobs,
    input.solver,
    budgetMs,
  );
  if (!flexed) return { ...base, solver: 'even' };
  const used = clamp01(input.used);
  const allowance = committed(flexed[0] ?? 0, used, input.resetAtMs - input.nowMs, input.knobs);
  const series = seriesFor({
    poolId: input.poolId,
    used,
    nowMs: input.nowMs,
    resetAtMs: input.resetAtMs,
    windowStartMs: input.windowStartMs,
    periods: base.periods,
    spends: flexed,
    stamp: input.stamp ?? null,
  });
  return {
    periods: base.periods,
    spends: flexed,
    allowance,
    projectedLanding: series.projectedLanding ?? used,
    series,
    solver: 'lp',
  };
}
