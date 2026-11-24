/**
 * `phm today` (schema today.v1): the one phone screen that answers "is it working?".
 *
 * Four blocks, top to bottom: one plain sentence, what is running now (jobs per lane), the pools that are empty and
 * when they come back, and the open asks only Mason can answer. Built only from reports other commands already serve
 * (`phm home`, `phm pools`, `phm asks list`); the phone draws exactly this and the asks keep their existing verified
 * reply route. Pure and browser-safe (type-only imports plus two pure helpers). A source that could not be read is
 * `null` with a plain reason, never zero. Pool names are labels (never account ids) and ask text is passed through as
 * the ask ledger holds it.
 */
import { poolLabel } from '../usage/runway.js';
import type { AskBatch } from './asks-batch.js';
import type { HomeSummary } from './home.js';
import type { PoolsViewV1 } from './pools-view.js';

export const TODAY_SCHEMA = 'today.v1';

export interface TodayInput {
  home: HomeSummary | null;
  pools: PoolsViewV1 | null;
  asks: AskBatch | null;
}
export interface TodayLane { lane: string; running: number; target: number | null }
export interface TodayPool { id: string; label: string; usedPct: number | null; returnsAt: string | null; returns: string }
export interface TodayAsk { id: string; number: number; question: string; choices: string[]; expires: string | null; whatHappens: string }
export interface TodayV1 {
  schema: typeof TODAY_SCHEMA;
  asOf: string;
  sentence: string;
  merged: { lastHour: number | null; last24h: number | null };
  running: { total: number | null; lanes: TodayLane[] };
  /** Pools at 100% used. `null`: the pools could not be read. */
  emptyPools: TodayPool[] | null;
  /** Open asks, oldest first. `null`: the ask ledger could not be read. */
  asks: TodayAsk[] | null;
  /** What could not be read, in plain words. */
  unknown: string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3:30 PM" today, "Sat 3:30 PM" on another day, in `timeZone` (the reader's own by default). */
export function clockWords(iso: string, nowMs: number, timeZone?: string): string {
  const at = new Date(iso);
  const opts = timeZone === undefined ? {} : { timeZone };
  const time = at.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', ...opts }).replace(/\s/g, ' ');
  const day = (d: Date): string => d.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', ...opts });
  return day(at) === day(new Date(nowMs)) ? time : `${at.toLocaleString('en-US', { weekday: 'short', ...opts })} ${time}`;
}

const isEmpty = (row: PoolsViewV1['pools'][number]): boolean =>
  row.kind !== 'unmetered' && row.state === 'measured' && row.usedPct !== null && row.usedPct >= 100;

export function buildToday(input: TodayInput, nowMs: number, timeZone?: string): TodayV1 {
  const unknown: string[] = [];
  const { home, pools, asks } = input;
  const field = (f: HomeSummary['mergedLastHour'] | undefined, what: string): number | null => {
    if (f?.state === 'ok') return f.value;
    unknown.push(f?.state === 'unknown' ? f.reason : `${what} could not be read.`);
    return null;
  };
  const lastHour = field(home?.mergedLastHour, 'Merged PRs');
  const last24h = home?.merged24h.state === 'ok' ? home.merged24h.value : null;
  const lanes: TodayLane[] = home?.running.state === 'ok' ? home.running.value.map(({ lane, running, target }) => ({ lane, running, target })) : [];
  if (home && home.running.state === 'unknown') unknown.push(home.running.reason);
  const total = home?.running.state === 'ok' ? lanes.reduce((sum, lane) => sum + lane.running, 0) : null;

  let emptyPools: TodayPool[] | null = null;
  if (pools) {
    emptyPools = pools.pools.filter(isEmpty).map((row) => ({
      id: row.id, label: poolLabel(row.id), usedPct: row.usedPct, returnsAt: row.resetAt,
      returns: row.resetAt !== null && Number.isFinite(Date.parse(row.resetAt)) ? `back ${clockWords(row.resetAt, nowMs, timeZone)}` : 'return time unknown',
    })).sort((a, b) => Date.parse(a.returnsAt ?? '') - Date.parse(b.returnsAt ?? '') || 0);
  } else unknown.push('The pools could not be read.');

  let asksOut: TodayAsk[] | null = null;
  if (asks && asks.ledger !== 'unavailable') {
    asksOut = asks.asks.map((ask) => ({ id: ask.id, number: ask.number, question: ask.question, choices: ask.choices, expires: ask.expires, whatHappens: ask.whatHappens }));
  } else unknown.push('The needs-you list could not be read.');

  const parts = [
    lastHour === null ? 'PRs merged: unknown' : `${plural(lastHour, 'PR', 'PRs')} merged in the last hour`,
    total === null ? 'jobs running: unknown' : `${plural(total, 'job', 'jobs')} running`,
  ];
  if (emptyPools !== null) {
    const first = emptyPools[0];
    parts.push(first === undefined ? 'every pool has room'
      : emptyPools.length === 1 ? `${first.label} is ${first.returns}`
      : `${emptyPools.length} pools are empty, ${first.label} is ${first.returns}`);
  }
  if (asksOut !== null && asksOut.length > 0) parts.push(`${plural(asksOut.length, 'question needs', 'questions need')} you`);
  const sentence = `${parts.join('; ')}.`;

  return { schema: TODAY_SCHEMA, asOf: new Date(nowMs).toISOString(), sentence, merged: { lastHour, last24h }, running: { total, lanes }, emptyPools, asks: asksOut, unknown };
}

/** Plain lines for a terminal: the same four blocks the phone draws. */
export function todayText(today: TodayV1): string[] {
  const lines = [today.sentence, '', 'Running now'];
  lines.push(...(today.running.lanes.length ? today.running.lanes.map((l) => `  ${l.lane}: ${l.running}`) : [`  ${today.running.total === null ? 'unknown' : 'nothing'}`]));
  lines.push('', 'Empty pools');
  lines.push(...(today.emptyPools === null ? ['  unknown'] : today.emptyPools.length ? today.emptyPools.map((p) => `  ${p.label}: ${p.returns}`) : ['  none']));
  lines.push('', 'Needs you');
  lines.push(...(today.asks === null ? ['  unknown'] : today.asks.length ? today.asks.map((a) => `  ${a.number}. ${a.question} [${a.choices.join(' / ')}]`) : ['  nothing']));
  return lines;
}
