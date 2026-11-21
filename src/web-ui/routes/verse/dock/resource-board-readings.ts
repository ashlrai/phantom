/**
 * routes/verse/dock/resource-board-readings.ts — the few words the switcher shows beside a board's name, so the
 * row says where to look before a board is opened. Each comes from the read its own board draws from and is
 * counted by that board's model, so the row and the board cannot disagree. A board whose read has not answered,
 * or has nothing worth a word, gets no reading: the name stands alone, never a zero.
 *
 * Pure; no React.
 */
import type { PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { RunsHistory } from '../../../../core/fleet/runs-history.js';
import type { ThroughputReport } from '../../../../core/fleet/throughput.js';
import { standingCounts, usageHeadline } from '../../../../core/usage/account-limits.js';
import { boardHeadline as capacityHeadline, fillText, fleetTotals } from '../fleet-capacity/capacity-board-model.js';
import { laneSeries } from '../fleet-capacity/capacity-model.js';
import { boardHeadline } from '../fleet-lanes/lanes-board-model.js';
import { poolCounts, poolsHeadline } from '../fleet-pools/pools-board-model.js';
import { ROUTER_KINDS, type RouteTable } from '../fleet-router/router-model.js';
import { boardHeadline as supplyHeadline, supplyCard } from '../fleet-supply/supply-board-model.js';
import { laneSupply, totalShortfall } from '../fleet-supply/supply-model.js';
import type { UsageRow } from '../fleet-usage/usage-pane-model.js';
import { boardModels, modelsHeadline, type BoardInputs } from '../models/models-board-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';

export interface BoardReading {
  /** Two or three words drawn after the name. */
  readonly text: string;
  /** `attention` asks to be looked at; `quiet` is a plain figure. */
  readonly tone: 'attention' | 'quiet';
  /** The board's own headline sentence, for the tooltip. */
  readonly detail: string;
}

/**
 * Pools that run empty before their reset, else pools behind their window, else pools with no current reading;
 * nothing while every pool is on pace.
 */
export function poolsReading(view: PoolsViewV1): BoardReading | null {
  const { all, fast, behind, unknown } = poolCounts(view.pools);
  if (all === 0 || (fast === 0 && behind === 0 && unknown === 0)) return null;
  const detail = poolsHeadline(view.pools);
  if (fast > 0) return { text: `${fast} too fast`, tone: 'attention', detail };
  return behind > 0 ? { text: `${behind} behind`, tone: 'attention', detail } : { text: `${unknown} unknown`, tone: 'quiet', detail };
}

/**
 * Accounts their provider flags at a limit, else accounts that could not be read; nothing while every account
 * answered and none is flagged. The flag is the provider's own, never inferred from a 100% reading.
 */
export function usageReading(rows: readonly UsageRow[]): BoardReading | null {
  const detail = usageHeadline(rows);
  if (detail === null) return null;
  const { limit, unread } = standingCounts(rows);
  if (limit > 0) return { text: `${limit} at limit`, tone: 'attention', detail };
  return unread > 0 ? { text: `${unread} unread`, tone: 'quiet', detail } : null;
}

/** Lanes held, else slots running against slots asked for. */
export function lanesReading(runs: FleetRuns): BoardReading | null {
  if (runs.lanes.length === 0) return null;
  const detail = boardHeadline(runs);
  const held = runs.lanes.filter(lane => lane.held).length;
  if (held > 0) return { text: `${held} held`, tone: 'attention', detail };
  const whole = (value: number): number => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const running = runs.lanes.reduce((sum, lane) => sum + whole(lane.running), 0);
  const target = runs.lanes.reduce((sum, lane) => sum + whole(lane.target), 0);
  return { text: `${running}/${target}`, tone: 'quiet', detail };
}

/**
 * Kinds of fleet work no seat can take right now, else kinds the router gave no answer for; nothing while every
 * kind has a seat. Counted from the Router board's own route table (one preview per task and difficulty).
 */
export function routerReading(table: RouteTable): BoardReading | null {
  const answered = table.routes.length;
  const none = table.routes.filter(route => route.decision.seatId === null).length;
  if (none > 0) return { text: `${none} no seat`, tone: 'attention', detail: `${none} of ${answered} kinds of fleet work have no seat that can take them right now.` };
  const unanswered = ROUTER_KINDS - answered;
  return unanswered > 0 ? { text: `${unanswered} unknown`, tone: 'quiet', detail: `${unanswered} of ${ROUTER_KINDS} kinds of work got no answer from the router.` } : null;
}

/**
 * Models the router refuses, else models that are stale or deprecated in their provider's docs; nothing while
 * every model is in order, or while neither the registry nor the check has answered. A retired model is not counted.
 */
export function modelsReading(inputs: Pick<BoardInputs, 'registry' | 'check'>): BoardReading | null {
  if (inputs.registry === null && inputs.check === null) return null;
  const models = boardModels({ ...inputs, lanes: null });
  const flagged = models.filter(model => model.attention);
  if (flagged.length === 0) return null;
  const detail = modelsHeadline(models.length, inputs.check);
  const refused = flagged.filter(model => model.routable === false).length;
  return refused > 0 ? { text: `${refused} not routable`, tone: 'attention', detail } : { text: `${flagged.length} to review`, tone: 'quiet', detail };
}

/**
 * The share of target slots the lanes kept filled over the window read, in the Capacity board's own figure.
 * Nothing when no lane was sampled or none had a target: an unwatched window is not 0% filled.
 */
export function capacityReading(history: RunsHistory, now: number): BoardReading | null {
  const series = laneSeries(history, now);
  const totals = fleetTotals(series);
  if (series.length === 0 || totals.fillPct === null) return null;
  return { text: `${fillText(totals)} filled`, tone: 'quiet', detail: `${capacityHeadline(totals, series.length)}.` };
}

/**
 * Slots opening in the next 15 minutes with no job waiting for them. An unread drop folder leaves the pending
 * files uncounted, so the figure is then an upper bound and says so. Nothing while every opening slot is covered.
 */
export function supplyReading(runs: FleetRuns): BoardReading | null {
  const pendingKnown = runs.sources.runsDir === 'healthy' && runs.drop !== null;
  const cards = laneSupply(runs).map(row => supplyCard(row, pendingKnown));
  const short = totalShortfall(cards);
  if (short === 0) return null;
  return { text: `${pendingKnown ? '' : 'up to '}${short} short`, tone: 'attention', detail: `${supplyHeadline(cards, pendingKnown)}.` };
}

/**
 * Default branches the main guardian reports red, else PRs merged over the window read (the Throughput board's
 * own 24 hours), from the `phm throughput` report. A measured zero is a figure and is shown; a job metrics file
 * that could not be read leaves the count unknown, so the name then stands alone unless main is red.
 */
export function throughputReading(report: ThroughputReport): BoardReading | null {
  const detail = `${report.headline}.`;
  if (report.main === 'red') return { text: 'main red', tone: 'attention', detail: `Main is red. ${detail}` };
  const merged = report.metrics === 'ok' ? report.totals.merged : null;
  return merged === null ? null : { text: `${merged} merged`, tone: 'quiet', detail };
}
