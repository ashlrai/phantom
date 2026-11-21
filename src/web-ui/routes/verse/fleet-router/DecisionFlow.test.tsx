/** Router pane: the recorded decisions as a flow from what was asked to the seat chosen. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ShadowDecisionRecord, ShadowDecisionSource } from '../../../../core/routing/budget-store.js';
import type { RoutingDifficulty, RoutingTask } from '../../../../core/routing/types.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetRouterPane } from './FleetRouterPane.js';
import { FLOW_GAP, FLOW_MAX_SCALE, FLOW_ROW, askedKey, decisionFlow, flowWords, nodeWords, pinMatches, ribbonPath, stepNode } from './decision-flow-model.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 3_600_000;
const record = (hours: number, task: RoutingTask, difficulty: RoutingDifficulty, source: ShadowDecisionSource, seatId: string | null, actual: ShadowDecisionRecord['actual'] = null): ShadowDecisionRecord => ({
  v: 1, at: new Date(NOW + hours * HOUR).toISOString(), source, request: { task, difficulty, autonomous: true },
  decision: { seatId, candidates: seatId === null ? [] : [seatId], mode: 'balanced', why: 'Because.', exclusions: [] }, actual });
// Seven decisions over 24 hours: three in the newest hour, the plan nobody could take at the far end.
const LOG = [
  record(-0.2, 'code', 'medium', 'daemon', 'claude', { engine: 'codex', seatId: 'codex-cmp' }),
  record(-0.4, 'code', 'medium', 'daemon', 'claude'),
  record(-0.6, 'review', 'low', 'leader', 'codex-cmp'),
  record(-3.5, 'code', 'medium', 'daemon', 'claude'),
  record(-5.5, 'code', 'high', 'daemon', 'codex-cmp'),
  record(-7.5, 'review', 'low', 'leader', 'codex-cmp'),
  record(-24, 'plan', 'medium', 'verse', null),
];
const VIEW = { sampledAt: new Date(NOW).toISOString(), headroom: [],
  seatInfo: [{ seatId: 'claude', label: 'Claude Max', engine: 'claude', free: false }, { seatId: 'codex-cmp', label: 'Codex', engine: 'codex', free: false }] };
const name = (seatId: string | null) => seatId === null ? 'No seat' : seatId === 'claude' ? 'Claude Max' : 'Codex';

const serve = (decisions: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes('/budget/preview')) return Response.json(LOG[0]!.decision);
    if (url.includes('/budget/decisions')) return Response.json({ decisions });
    if (url.includes('/api/verse/budget')) return Response.json(VIEW);
    return Response.json({}, { status: 404 });
  }));
};
const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('decision-flow-model', () => {
  it('counts every record once on each side and lays both sides out on one scale', () => {
    const flow = decisionFlow(LOG, 'task', name)!;
    expect([flow.total, flow.scale]).toEqual([7, FLOW_MAX_SCALE]);
    expect(flow.from.map(node => [node.label, node.count, node.moved])).toEqual([['Code', 4, 1], ['Review', 2, 0], ['Plan', 1, 0]]);
    expect(flow.to.map(node => [node.label, node.key, node.count, node.moved])).toEqual([['Claude Max', 'claude', 3, 1], ['Codex', 'codex-cmp', 3, 0], ['No seat', null, 1, 0]]);
    // A bar is its count on the scale; a row is never shorter than its label.
    expect(flow.from.map(node => [node.y, node.height, node.row])).toEqual([[0, 48, 48], [48 + FLOW_GAP, 24, FLOW_ROW], [80 + FLOW_GAP, 12, FLOW_ROW]]);
    expect(flow.to.map(node => [node.y, node.height])).toEqual([[0, 36], [42, 36], [84, 12]]);
    expect(flow.height).toBe(112);
    // A band is as thick at the seat as at the request, and bands stack inside a node in the order of the nodes they reach.
    expect(flow.links.map(link => [link.from, link.to, link.count, link.moved, link.fromY, link.toY, link.thickness])).toEqual([
      [0, 0, 3, 1, 0, 0, 36], [0, 1, 1, 0, 36, 42, 12], [1, 1, 2, 0, 54, 54, 24], [2, 2, 1, 0, 86, 84, 12]]);
    expect(flow.links.reduce((sum, link) => sum + link.count, 0)).toBe(flow.total);
    expect(ribbonPath(flow.links[0]!)).toBe('M0,0 C50,0 50,0 100,0 L100,36 C50,36 50,36 0,36 Z');
  });

  it('groups by difficulty in its own order and by who asked, and thins the scale for a long log', () => {
    expect(decisionFlow(LOG, 'difficulty', name)!.from.map(node => [node.label, node.count])).toEqual([['Low', 2], ['Medium', 4], ['High', 1]]);
    expect(decisionFlow(LOG, 'source', name)!.from.map(node => [node.label, node.count])).toEqual([['Daemon', 4], ['Leader', 2], ['Console', 1]]);
    const long = decisionFlow(Array.from({ length: 200 }, (_, index) => record(-index / 10, index % 4 ? 'code' : 'bulk', 'low', 'daemon', 'claude')), 'task', name)!;
    expect(long.scale).toBeCloseTo(0.84);
    expect(long.from.map(node => [node.label, node.count, Math.round(node.height)])).toEqual([['Code', 150, 126], ['Bulk', 50, 42]]);
    expect(Math.round(long.to[0]!.height)).toBe(168);
  });

  it('keeps a record that does not say what was asked under its own name, and draws nothing for no records', () => {
    const bare = { ...record(0, 'code', 'low', 'daemon', 'claude'), request: {} } as unknown as ShadowDecisionRecord;
    const odd = { ...record(0, 'code', 'low', 'daemon', 'claude'), request: { task: 'triage', difficulty: 'low', autonomous: true } } as unknown as ShadowDecisionRecord;
    expect([askedKey(bare, 'task'), askedKey(bare, 'source'), askedKey(odd, 'task')]).toEqual([null, 'daemon', 'triage']);
    expect(decisionFlow([bare, odd], 'task', name)!.from.map(node => [node.key, node.label, node.count])).toEqual([[null, 'Not recorded', 1], ['triage', 'triage', 1]]);
    expect(decisionFlow([], 'task', name)).toBeNull();
  });

  it('says the diagram and a name in words, steps names from the keyboard and matches a kept name to its records', () => {
    const flow = decisionFlow(LOG, 'task', name)!;
    expect(flowWords(flow, 'task')).toBe('7 decisions by kind of work, each band as thick as its count.');
    expect(flowWords(decisionFlow(LOG.slice(0, 1), 'source', name)!, 'source')).toBe('1 decision by who asked, each band as thick as its count.');
    expect(nodeWords(flow, { side: 'from', index: 0 })).toBe('Code: 4 of 7 decisions. Went to Claude Max 3, Codex 1. 1 ran on another seat.');
    expect(nodeWords(flow, { side: 'to', index: 1 })).toBe('Codex: 3 of 7 decisions. From Review 2, Code 1.');
    expect(nodeWords(flow, { side: 'to', index: 2 })).toBe('No seat: 1 of 7 decisions. From Plan 1.');
    expect(nodeWords(flow, { side: 'to', index: 9 })).toBe('');
    // Right and Left cross a node's thickest band; Up, Down, Home and End stay on a side and stop at its ends.
    expect(stepNode(flow, { side: 'from', index: 0 }, 'ArrowRight')).toEqual({ side: 'to', index: 0 });
    expect(stepNode(flow, { side: 'to', index: 1 }, 'ArrowLeft')).toEqual({ side: 'from', index: 1 });
    expect([stepNode(flow, { side: 'to', index: 1 }, 'ArrowRight'), stepNode(flow, { side: 'from', index: 0 }, 'ArrowLeft'), stepNode(flow, { side: 'from', index: 0 }, 'a')]).toEqual([null, null, null]);
    expect([stepNode(flow, { side: 'from', index: 2 }, 'ArrowDown'), stepNode(flow, { side: 'from', index: 0 }, 'ArrowUp'), stepNode(flow, { side: 'to', index: 1 }, 'Home'), stepNode(flow, { side: 'to', index: 0 }, 'End')])
      .toEqual([{ side: 'from', index: 2 }, { side: 'from', index: 0 }, { side: 'to', index: 0 }, { side: 'to', index: 2 }]);
    expect(LOG.filter(item => pinMatches({ by: 'task', side: 'from', key: 'review', label: 'Review' }, item))).toHaveLength(2);
    expect(LOG.filter(item => pinMatches({ by: 'source', side: 'from', key: 'daemon', label: 'Daemon' }, item))).toHaveLength(4);
    expect(LOG.filter(item => pinMatches({ by: 'task', side: 'to', key: null, label: 'No seat' }, item))).toHaveLength(1);
  });
});

describe('FleetRouterPane decision flow', () => {
  const draw = async (decisions: unknown = LOG) => {
    serve(decisions);
    render(<FleetRouterPane {...props} />);
    const diagram = await screen.findByRole('group', { name: 'Recorded decisions from kind of work to the seat chosen' });
    const node = (label: RegExp) => within(diagram).getByRole('button', { name: label });
    const lit = () => [...diagram.querySelectorAll('path[data-lit]')].map(path => path.getAttribute('data-band'));
    return { diagram, node, lit, words: () => document.querySelector('[data-flow-words]')!.textContent };
  };

  it('draws a name per kind of work and per seat with a band for each pair, and says the diagram in words', async () => {
    const { diagram, words } = await draw();
    const names = (list: string) => within(within(diagram).getByRole('list', { name: list })).getAllByRole('button').map(button => button.getAttribute('aria-label'));
    expect(names('Kind of work')).toEqual(['Code: 4 of 7 decisions. Went to Claude Max 3, Codex 1. 1 ran on another seat.', 'Review: 2 of 7 decisions. Went to Codex 2.', 'Plan: 1 of 7 decisions. Went to No seat 1.']);
    expect(names('Seat chosen')).toEqual(['Claude Max: 3 of 7 decisions. From Code 3. 1 ran on another seat.', 'Codex: 3 of 7 decisions. From Review 2, Code 1.', 'No seat: 1 of 7 decisions. From Plan 1.']);
    expect([...diagram.querySelectorAll('path[data-band]')].map(path => path.getAttribute('data-band'))).toEqual(['0-0', '0-1', '1-1', '2-2']);
    expect(diagram.querySelector('path[data-band="2-2"]')).toHaveAttribute('data-none');
    expect(diagram.querySelector('path[data-band="0-0"]')).not.toHaveAttribute('data-none');
    expect(diagram.querySelector('svg[preserveAspectRatio="none"]')).toHaveAttribute('viewBox', '0 0 100 112');
    expect(within(diagram).getByRole('button', { name: /^No seat:/ })).toHaveAttribute('data-none');
    // One tab stop for the whole diagram, and nothing lit until a name is read.
    expect(within(diagram).getAllByRole('button').filter(button => button.tabIndex === 0).map(button => button.textContent)).toEqual(['Code4']);
    expect(diagram).not.toHaveAttribute('data-reading');
    expect(words()).toBe('7 decisions by kind of work, each band as thick as its count. Point at a name, or use the arrow keys, to read it; Enter keeps it and lists its decisions.');
    expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument();
  });

  it('lights the bands of the name under the pointer and lets go on leaving', async () => {
    const { diagram, node, lit, words } = await draw();
    fireEvent.mouseEnter(node(/^Code:/));
    expect(diagram).toHaveAttribute('data-reading');
    expect(lit()).toEqual(['0-0', '0-1']);
    expect(node(/^Code:/)).toHaveAttribute('data-lit');
    expect(words()).toBe('Code: 4 of 7 decisions. Went to Claude Max 3, Codex 1. 1 ran on another seat.');
    fireEvent.mouseEnter(node(/^Codex:/));
    expect(lit()).toEqual(['0-1', '1-1']);
    fireEvent.mouseLeave(diagram);
    expect(lit()).toEqual([]);
    expect(diagram).not.toHaveAttribute('data-reading');
  });

  it('walks the names with the arrow keys, keeps one with a click and holds the list to its decisions until Esc', async () => {
    const { diagram, node, lit } = await draw();
    act(() => node(/^Code:/).focus());
    expect(lit()).toEqual(['0-0', '0-1']);
    fireEvent.keyDown(node(/^Code:/), { key: 'ArrowRight' });
    expect(node(/^Claude Max:/)).toHaveFocus();
    fireEvent.keyDown(node(/^Claude Max:/), { key: 'ArrowDown' });
    expect(node(/^Codex:/)).toHaveFocus();
    fireEvent.keyDown(node(/^Codex:/), { key: 'ArrowLeft' });
    expect(node(/^Review:/)).toHaveFocus();
    expect(lit()).toEqual(['1-1']);
    // A modified arrow and the board's own [ and ] are left alone.
    expect(fireEvent.keyDown(node(/^Review:/), { key: 'ArrowDown', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(node(/^Review:/), { key: ']' })).toBe(true);
    fireEvent.click(node(/^Review:/));
    expect(node(/^Review:/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Latest: Review' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Latest decisions' })).getAllByRole('listitem').map(item => item.textContent)).toEqual([expect.stringMatching(/low review · leader/), expect.stringMatching(/low review · leader/)]);
    // The kept name stays lit after focus and the pointer have left.
    fireEvent.blur(node(/^Review:/));
    expect(lit()).toEqual(['1-1']);
    fireEvent.keyDown(diagram, { key: 'Escape' });
    expect(node(/^Review:/)).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('list', { name: 'Latest decisions' })).getAllByRole('listitem')).toHaveLength(6);
    // With nothing kept, Esc is left for the pane.
    expect(fireEvent.keyDown(diagram, { key: 'Escape' })).toBe(true);
  });

  it('counts what the list leaves out for a kept name, and Show all lets go of it', async () => {
    const { node } = await draw([...LOG, ...Array.from({ length: 5 }, (_, index) => record(-10 - index, 'code', 'medium', 'daemon', 'claude'))]);
    fireEvent.click(node(/^Claude Max: 8 of 12 decisions/));
    expect(screen.getByRole('heading', { name: 'Latest: Claude Max' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Latest decisions' })).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('and 2 more.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument();
    expect(screen.queryByText('and 2 more.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('regroups the requests by difficulty or by who asked, dropping a kept request and keeping a kept seat', async () => {
    const { node } = await draw();
    fireEvent.click(node(/^Plan:/));
    fireEvent.click(screen.getByRole('radio', { name: 'Difficulty' }));
    const diagram = screen.getByRole('group', { name: 'Recorded decisions from difficulty to the seat chosen' });
    expect(within(within(diagram).getByRole('list', { name: 'Difficulty' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Low2', 'Medium4', 'High1']);
    expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument();
    fireEvent.click(within(diagram).getByRole('button', { name: /^Codex:/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Asked by' }));
    const asked = screen.getByRole('group', { name: 'Recorded decisions from asked by to the seat chosen' });
    expect(within(within(asked).getByRole('list', { name: 'Asked by' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Daemon4', 'Leader2', 'Console1']);
    expect(within(asked).getByRole('button', { name: /^Codex:/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Latest: Codex' })).toBeInTheDocument();
    expect(document.querySelector('[data-flow-words]')!.textContent).toBe('Codex: 3 of 7 decisions. From Leader 2, Daemon 1.');
  });

  it('draws only the column being read on the time axis, and says so when a kept name has nothing in it', async () => {
    const { diagram, node, words } = await draw();
    fireEvent.click(node(/^Plan:/));
    const axis = screen.getByRole('slider', { name: 'Recorded decisions over time' });
    act(() => axis.focus());
    fireEvent.keyDown(axis, { key: 'ArrowLeft' });
    // The newest hour holds three decisions: two code to Claude Max, one review to Codex.
    expect(within(diagram).getAllByRole('button').map(button => button.textContent)).toEqual(['Code2', 'Review1', 'Claude Max2', 'Codex1']);
    expect(words()).toBe('3 decisions by kind of work, each band as thick as its count. Point at a name, or use the arrow keys, to read it; Enter keeps it and lists its decisions.');
    expect(screen.getByRole('heading', { name: 'In this column: Plan' })).toBeInTheDocument();
    expect(screen.getByText('No decisions for Plan in this column.')).toBeInTheDocument();
    // An empty column draws no diagram at all.
    fireEvent.keyDown(axis, { key: 'ArrowLeft' });
    expect(screen.queryByRole('group', { name: /^Recorded decisions from/ })).toBeNull();
    expect(screen.getByText('No decisions in this column.')).toBeInTheDocument();
    fireEvent.keyDown(axis, { key: 'Home' });
    expect(within(screen.getByRole('list', { name: 'Decisions in this column' })).getByRole('listitem').textContent).toMatch(/medium plan · verse/);
  });
});
