/** Router pane: the recorded decisions drawn over time, a lane per seat, and each column read on its own. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import type { SeatDecision } from '../../../../core/routing/types.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetRouterPane } from './FleetRouterPane.js';
import { TIMELINE_COLUMNS, columnWords, decisionTimeline, spanWords, stepColumn, timelineWords } from './decision-timeline-model.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const decision = (seatId: string | null): SeatDecision => ({ seatId, candidates: seatId === null ? [] : [seatId], mode: 'balanced', why: 'Because.', exclusions: [] });
const record = (hours: number, seatId: string | null, actual: ShadowDecisionRecord['actual'] = null): ShadowDecisionRecord => ({ v: 1, at: at(hours), source: 'daemon',
  request: { task: 'code', difficulty: 'medium', autonomous: true }, decision: decision(seatId), actual });
const VIEW = { sampledAt: at(-0.05), headroom: [],
  seatInfo: [{ seatId: 'claude', label: 'Claude Max', engine: 'claude', free: false }, { seatId: 'codex-cmp', label: 'Codex', engine: 'codex', free: false }] };
// A 24 hour span, so each of the 24 columns is one hour: column 1 starts at -24 h, column 24 ends now.
const DAY = [record(-0.5, 'claude', { engine: 'codex', seatId: 'codex-cmp' }), record(-0.6, 'claude'), record(-0.7, 'codex-cmp'), record(-5.5, 'codex-cmp'), record(-24, null)];
const name = (seatId: string | null) => seatId === null ? 'No seat' : seatId === 'claude' ? 'Claude Max' : 'Codex';
const hour = (ms: number) => `${(ms - NOW) / HOUR}h`;

const serve = (decisions: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes('/budget/preview')) return Response.json(decision('claude'));
    if (url.includes('/budget/decisions')) return Response.json({ decisions });
    if (url.includes('/api/verse/budget')) return Response.json(VIEW);
    return Response.json({}, { status: 404 });
  }));
};
const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('decision-timeline-model', () => {
  it('places each dated decision in its column and lane, from the oldest decision read to now', () => {
    const timeline = decisionTimeline(DAY, NOW)!;
    expect([timeline.startMs, timeline.endMs, timeline.columnMs]).toEqual([NOW - 24 * HOUR, NOW, HOUR]);
    expect(timeline.columns).toHaveLength(TIMELINE_COLUMNS);
    expect(timeline.columns.map(column => column.total).join('')).toBe('100000000000000000100003');
    expect(timeline.columns[23]).toMatchObject({ total: 3, moved: 1, records: [0, 1, 2], startMs: NOW - HOUR, endMs: NOW });
    const lanes = Object.fromEntries(timeline.lanes.map(lane => [String(lane.seatId), lane]));
    expect(lanes['claude']!.counts[23]).toBe(2);
    expect(lanes['claude']!.moved[23]).toBe(1);
    expect([lanes['codex-cmp']!.counts[18], lanes['codex-cmp']!.counts[23], lanes['null']!.counts[0]]).toEqual([1, 1, 1]);
    expect(timeline).toMatchObject({ peak: 2, busiest: 3, drawn: 5, undated: 0 });
  });

  it('never places a decision whose time cannot be read, and draws nothing when none can', () => {
    const undated = { ...record(0, 'claude'), at: 'not a time' };
    expect(decisionTimeline([undated], NOW)).toBeNull();
    expect(decisionTimeline([], NOW)).toBeNull();
    const timeline = decisionTimeline([undated, record(-2, 'claude')], NOW)!;
    expect(timeline).toMatchObject({ drawn: 1, undated: 1, peak: 1 });
    expect(timeline.columns.reduce((sum, column) => sum + column.total, 0)).toBe(1);
    expect(timelineWords(timeline)).toBe('1 decision over 2 h, 5 min a column; the busiest column holds 1. 1 with no readable time is not drawn.');
  });

  it('keeps columns at least a minute wide for a young log and reaches past now for a decision stamped ahead', () => {
    const young = decisionTimeline([record(-0.01, 'claude')], NOW)!;
    expect([young.columnMs, young.endMs - young.startMs]).toEqual([60_000, 24 * 60_000]);
    expect(young.columns[23]!.total).toBe(1);
    const ahead = decisionTimeline([record(1, 'claude'), record(-23, 'claude')], NOW)!;
    expect(ahead.endMs).toBe(NOW + HOUR);
    expect([ahead.columns[0]!.total, ahead.columns[23]!.total]).toEqual([1, 1]);
  });

  it('says the chart and a column in words, and steps columns from the keyboard', () => {
    const timeline = decisionTimeline(DAY, NOW)!;
    expect(timelineWords(timeline)).toBe('5 decisions over 24 h, 60 min a column; the busiest column holds 3.');
    expect(columnWords(timeline, 23, name, hour)).toBe('-1h to 0h: 3 decisions. Claude Max 2, Codex 1. 1 ran on another seat.');
    expect(columnWords(timeline, 18, name, hour)).toBe('-6h to -5h: 1 decision. Codex 1.');
    expect(columnWords(timeline, 5, name, hour)).toBe('-19h to -18h: no decisions.');
    expect(columnWords(timeline, 99, name, hour)).toBe('');
    expect([spanWords(45_000), spanWords(12 * 60_000), spanWords(2.5 * HOUR), spanWords(72 * HOUR)]).toEqual(['45 s', '12 min', '2.5 h', '3 days']);
    expect([stepColumn('ArrowLeft', null, 24), stepColumn('ArrowRight', null, 24), stepColumn('ArrowLeft', 0, 24), stepColumn('ArrowRight', 23, 24)]).toEqual([23, 0, 0, 23]);
    expect([stepColumn('Home', 9, 24), stepColumn('End', 9, 24), stepColumn('ArrowLeft', 9, 24), stepColumn('a', 9, 24), stepColumn('End', 0, 0)]).toEqual([0, 23, 8, null, null]);
  });
});

describe('FleetRouterPane decisions over time', () => {
  const chart = async () => {
    render(<FleetRouterPane {...props} />);
    const rows = within(await screen.findByRole('list', { name: 'Decisions by chosen seat' })).getAllByRole('listitem');
    return { rows, axis: screen.getByRole('slider', { name: 'Recorded decisions over time' }) };
  };
  const stems = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('[data-bin]')].map(bin => (bin.firstElementChild as HTMLElement | null)?.style.height ?? '');

  it('draws a lane per seat against one scale, caps a column whose work ran elsewhere and says the chart in words', async () => {
    serve(DAY);
    const { rows, axis } = await chart();
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Claude Max: 2 of 5 decisions', 'Codex: 2 of 5 decisions', 'No seat: 1 of 5 decisions']);
    expect(rows.map(row => row.querySelectorAll('[data-bin]').length)).toEqual([24, 24, 24]);
    // Every lane is drawn against the tallest cell on the board (2), and an empty column draws nothing.
    expect(stems(rows[0]!).slice(22)).toEqual(['', '100%']);
    expect([stems(rows[1]!)[18], stems(rows[1]!)[23], stems(rows[2]!)[0]]).toEqual(['50%', '50%', '50%']);
    expect(stems(rows[1]!).filter(height => height !== '')).toHaveLength(2);
    expect(rows[0]!.querySelector('[data-bin="23"]')).toHaveAttribute('data-moved');
    expect(rows[1]!.querySelector('[data-bin="23"]')).not.toHaveAttribute('data-moved');
    expect(rows[2]!.querySelector('[data-bin="0"] [data-none]')).not.toBeNull();
    expect(axis).toHaveAttribute('aria-valuetext', '5 decisions over 24 h, 60 min a column; the busiest column holds 3.');
    expect(axis).toHaveAttribute('aria-valuemax', '24');
    expect([...axis.querySelectorAll('[data-tick]')].filter(tick => !tick.hasAttribute('data-empty')).map(tick => tick.getAttribute('data-tick'))).toEqual(['0', '18', '23']);
    expect(axis.querySelector('[data-tick="23"]')).toHaveAttribute('data-moved');
    expect(screen.getByText(/^5 decisions over 24 h, 60 min a column; the busiest column holds 3\. An amber cap marks work that ran on another seat\. Point at a column/)).toBeInTheDocument();
    expect(axis.parentElement!.textContent).toMatch(/now$/);
  });

  it('reads one column from the keyboard: its words, its mark in every lane and its own decisions in the list', async () => {
    serve(DAY);
    const { rows, axis } = await chart();
    axis.focus();
    fireEvent.keyDown(axis, { key: 'ArrowLeft' });
    expect(axis).toHaveAttribute('aria-valuenow', '24');
    expect(axis.getAttribute('aria-valuetext')).toMatch(/: 3 decisions\. Claude Max 2, Codex 1\. 1 ran on another seat\.$/);
    expect(rows.map(row => row.querySelector('[data-picked]')?.getAttribute('data-bin'))).toEqual(['23', '23', '23']);
    expect(screen.getByRole('heading', { name: 'In this column' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Decisions in this column' })).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.keyDown(axis, { key: 'ArrowLeft' });
    expect(axis.getAttribute('aria-valuetext')).toMatch(/: no decisions\.$/);
    expect(screen.getByText('No decisions in this column.')).toBeInTheDocument();
    fireEvent.keyDown(axis, { key: 'Home' });
    expect(axis).toHaveAttribute('aria-valuenow', '1');
    expect(within(screen.getByRole('list', { name: 'Decisions in this column' })).getByRole('listitem').textContent).toMatch(/No seat/);
    // A modified key and the board's own [ and ] are left alone; Esc lets go and the newest decisions return.
    expect(fireEvent.keyDown(axis, { key: 'ArrowRight', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(axis, { key: ']' })).toBe(true);
    expect(axis).toHaveAttribute('aria-valuenow', '1');
    fireEvent.keyDown(axis, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Latest decisions' })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('reads the column under the pointer, lets go on leaving, and keeps a clicked column until focus leaves', async () => {
    // Eight decisions in the newest hour: the list under the chart shows six and counts the rest.
    serve([...Array.from({ length: 8 }, (_, index) => record(-0.1 - index * 0.05, 'claude')), record(-24, 'codex-cmp')]);
    const { rows, axis } = await chart();
    const newest = rows[0]!.querySelector<HTMLElement>('[data-bin="23"]')!;
    fireEvent.mouseEnter(newest);
    expect(document.querySelector('[data-column="24"]')!.textContent).toMatch(/: 8 decisions\. Claude Max 8\.$/);
    expect(within(screen.getByRole('list', { name: 'Decisions in this column' })).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('and 2 more in this column.')).toBeInTheDocument();
    fireEvent.mouseLeave(newest.closest('ul')!.parentElement!);
    expect(document.querySelector('[data-column]')).toBeNull();
    fireEvent.click(newest);
    expect(axis).toHaveFocus();
    fireEvent.mouseLeave(newest.closest('ul')!.parentElement!);
    expect(document.querySelector('[data-column="24"]')).not.toBeNull();
    fireEvent.mouseEnter(axis.querySelector('[data-tick="0"]')!);
    expect(document.querySelector('[data-column="1"]')!.textContent).toMatch(/: 1 decision\. Codex 1\.$/);
    fireEvent.blur(axis);
    expect(document.querySelector('[data-column]')).toBeNull();
  });

  it('keeps the plain share bars and says why when no decision carries a readable time', async () => {
    serve([{ ...record(0, 'claude'), at: 'not a time' }]);
    render(<FleetRouterPane {...props} />);
    const row = within(await screen.findByRole('list', { name: 'Decisions by chosen seat' })).getByRole('listitem');
    expect(row.querySelector('[data-bin]')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('None of these decisions carries a readable time, so they are not drawn over time.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Latest decisions' })).getByRole('listitem').textContent).toMatch(/time unknown/);
  });
});
