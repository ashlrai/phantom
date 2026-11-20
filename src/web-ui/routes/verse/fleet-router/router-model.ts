/**
 * routes/verse/fleet-router/router-model.ts: the reads and the pure folds behind the Router
 * pane. Nothing is decided here: the route table is the router's own answer for every task and
 * difficulty, one unlogged preview per cell (GET /api/verse/budget/preview), the usage beside
 * each seat is the headroom the Budget panel shows (GET /api/verse/budget), and the history is
 * the recorded decision log (GET /api/verse/budget/decisions). A reading the server does not
 * hold stays null, and a cell whose preview failed stays out of the table.
 */
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import type { RoutingDifficulty, RoutingTask, SeatDecision, SeatExclusion } from '../../../../core/routing/types.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const ROUTER_TASKS = [
  { value: 'code', label: 'Code' }, { value: 'review', label: 'Review' }, { value: 'plan', label: 'Plan' },
  { value: 'bulk', label: 'Bulk' }, { value: 'leader', label: 'Leader' },
] as const satisfies ReadonlyArray<{ value: RoutingTask; label: string }>;
export const ROUTER_DIFFICULTIES = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
] as const satisfies ReadonlyArray<{ value: RoutingDifficulty; label: string }>;
export const ROUTER_DECISIONS_LIMIT = 200;
export const ROUTER_DECISIONS_PATH = `/api/verse/budget/decisions?limit=${ROUTER_DECISIONS_LIMIT}`;
export const routerPreviewPath = (task: RoutingTask, difficulty: RoutingDifficulty, autonomous: boolean): string =>
  `/api/verse/budget/preview?task=${task}&difficulty=${difficulty}&autonomous=${autonomous}`;

/** The router's answer for one kind of work. */
export interface BudgetRoute { task: RoutingTask; difficulty: RoutingDifficulty; decision: SeatDecision }
/** The cells the router answered. A kind of work whose preview failed is left out, so the table can call it unknown. */
export interface RouteTable { routes: BudgetRoute[] }

/** Any other body (an older server, an error page) is not a decision. */
const isDecision = (body: unknown): body is SeatDecision => {
  const decision = body as Partial<SeatDecision> | null;
  return !!decision && (decision.seatId === null || typeof decision.seatId === 'string') && Array.isArray(decision.candidates) && Array.isArray(decision.exclusions);
};

const tableQuery = (autonomous: boolean): QueryDef<RouteTable> => ({
  key: `verse-router-routes-${autonomous ? 'fleet' : 'owner'}`,
  fetch: async signal => {
    const kinds = ROUTER_TASKS.flatMap(task => ROUTER_DIFFICULTIES.map(difficulty => ({ task: task.value, difficulty: difficulty.value })));
    const answers = await Promise.allSettled(kinds.map(kind => apiGet<unknown>(routerPreviewPath(kind.task, kind.difficulty, autonomous), signal)));
    const routes = kinds.flatMap((kind, index): BudgetRoute[] => {
      const answer = answers[index]!;
      return answer.status === 'fulfilled' && isDecision(answer.value) ? [{ ...kind, decision: answer.value }] : [];
    });
    if (routes.length === 0) throw new Error('the router did not answer');
    return { routes };
  },
});
const FLEET_ROUTES = tableQuery(true), OWNER_ROUTES = tableQuery(false);
/** One stable definition per audience, so switching back reuses the last table while it refreshes. */
export const routerRoutesQuery = (autonomous: boolean): QueryDef<RouteTable> => autonomous ? FLEET_ROUTES : OWNER_ROUTES;

export const routerDecisionsQuery: QueryDef<ShadowDecisionRecord[]> = {
  key: 'verse-router-decisions',
  fetch: async signal => {
    const body = await apiGet<{ decisions?: unknown }>(ROUTER_DECISIONS_PATH, signal);
    if (!body || !Array.isArray(body.decisions)) throw new Error('unexpected decision log');
    return body.decisions as ShadowDecisionRecord[];
  },
};

/** The router's answer for one kind of work; null when the table does not hold that cell. */
export const routeAt = (routes: readonly BudgetRoute[], task: RoutingTask, difficulty: RoutingDifficulty): SeatDecision | null =>
  routes.find(route => route.task === task && route.difficulty === difficulty)?.decision ?? null;

export interface TableShare {
  /** null = the kinds of work no seat can take. */
  seatId: string | null;
  count: number;
}

/** How many kinds of work go first to each seat, most first, "no seat" last. Counts cells; infers nothing. */
export function tableShares(routes: readonly BudgetRoute[]): TableShare[] {
  const counts = new Map<string | null, number>();
  for (const { decision } of routes) counts.set(decision.seatId, (counts.get(decision.seatId) ?? 0) + 1);
  return [...counts].map(([seatId, count]) => ({ seatId, count }))
    .sort((a, b) => Number(a.seatId === null) - Number(b.seatId === null) || b.count - a.count || String(a.seatId).localeCompare(String(b.seatId)));
}

/** The name the provider mark is looked up by: the seat's engine when the server names it (a local seat id is its model tag), else the seat id. */
export const seatBrand = (view: BudgetView | null, seatId: string): string => view?.seatInfo.find(seat => seat.seatId === seatId)?.engine ?? seatId;

export interface RouteSeat {
  seatId: string;
  label: string;
  brand: string;
  /** 1-based place in the order the router would try seats; null for a seat it holds back. */
  rank: number | null;
  /** Local seats have no provider window, so no usage to show. */
  free: boolean;
  /** Which window the percent is of; null when the server names none. */
  window: 'session' | 'weekly' | null;
  /** Percent of that window used; null = no reading (never zero). */
  usedPercent: number | null;
  resetAt: string | null;
  held: SeatExclusion | null;
}

/** The router's answer as rows: seats in try order, then the ones held back, each with the usage the server reports. */
export function routeSeats(decision: SeatDecision, view: BudgetView | null): RouteSeat[] {
  const row = (seatId: string, rank: number | null, held: SeatExclusion | null): RouteSeat => {
    const info = view?.seatInfo.find(seat => seat.seatId === seatId);
    const headroom = view?.headroom.find(seat => seat.seatId === seatId);
    // The binding window is the one autonomy is measured against; without one, show whichever the server read.
    const window = headroom?.bindingWindow ?? (headroom?.weeklyUsedPercent != null ? 'weekly' : headroom?.sessionUsedPercent != null ? 'session' : null);
    return {
      seatId, rank, held, label: info?.label ?? seatId, brand: seatBrand(view, seatId), free: info?.free ?? false, window,
      usedPercent: window === 'weekly' ? headroom?.weeklyUsedPercent ?? null : window === 'session' ? headroom?.sessionUsedPercent ?? null : null,
      resetAt: headroom?.resetAt ?? null,
    };
  };
  const tried = decision.candidates.map((seatId, index) => row(seatId, index + 1, null));
  return [...tried, ...decision.exclusions.filter(x => !decision.candidates.includes(x.seatId)).map(x => row(x.seatId, null, x))];
}

export interface SeatShare {
  /** null = the router found no eligible seat for those requests. */
  seatId: string | null;
  count: number;
  /** 0 to 1 of the decisions read. */
  share: number;
}

export interface DecisionLogSummary {
  total: number;
  /** Oldest and newest decision read; null when there are none or the times are unreadable. */
  from: string | null;
  to: string | null;
  seats: SeatShare[];
  /** Decisions that record what actually ran, and how many of those ran on another seat than the one chosen. */
  ranKnown: number;
  ranElsewhere: number;
}

/** Counts the recorded decisions by chosen seat, most chosen first. Counts only; nothing is inferred. */
export function summarizeDecisions(records: readonly ShadowDecisionRecord[]): DecisionLogSummary {
  const counts = new Map<string | null, number>();
  let ranKnown = 0, ranElsewhere = 0, from = Infinity, to = -Infinity;
  for (const record of records) {
    const seatId = record.decision?.seatId ?? null;
    counts.set(seatId, (counts.get(seatId) ?? 0) + 1);
    if (record.actual && record.actual.seatId !== null) {
      ranKnown += 1;
      if (record.actual.seatId !== seatId) ranElsewhere += 1;
    }
    const at = Date.parse(record.at);
    if (Number.isFinite(at)) { from = Math.min(from, at); to = Math.max(to, at); }
  }
  const total = records.length;
  return {
    total, ranKnown, ranElsewhere,
    from: Number.isFinite(from) ? new Date(from).toISOString() : null,
    to: Number.isFinite(to) ? new Date(to).toISOString() : null,
    seats: [...counts].map(([seatId, count]) => ({ seatId, count, share: count / total }))
      .sort((a, b) => b.count - a.count || String(a.seatId).localeCompare(String(b.seatId))),
  };
}
