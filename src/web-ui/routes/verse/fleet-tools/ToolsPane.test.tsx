import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaneParityMatrix, ParityCell, ToolMatrix } from '../../../../core/fleet/tool-parity.js';
import { getPane } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import './fleet-tools.pane.js';
import { PARITY_PATH, TOOLS_PATH, ToolsPane } from './ToolsPane.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown }, parity: { status: 'loading', data: undefined as unknown }, key: '', refetch: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (query: { key: string }) => { if (query.key === 'fleet-tools-parity') return state.parity; state.key = query.key; return state.read; },
  useRefetch: () => state.refetch,
}));

const cell = (value: 'yes' | 'no' | 'unknown', source: string | null = value === 'unknown' ? null : 'lane-tools.json') => ({ value, source });
/** The local lane lacks a browser and nobody declares the skill for codex-local. */
const MATRIX: ToolMatrix = {
  schema: 'tools.matrix.v1', parity: 'gaps', lanes: ['claude', 'codex-local'],
  rows: [
    { need: 'browser', kind: 'capability', label: 'Browser', cells: { claude: cell('yes'), 'codex-local': cell('no') } },
    { need: 'mcp:context7', kind: 'mcp', label: 'MCP server context7', cells: { claude: cell('yes'), 'codex-local': cell('yes', 'connectors') } },
    { need: 'skill:review', kind: 'skill', label: 'Skill review', cells: { claude: cell('yes'), 'codex-local': cell('unknown') } },
  ],
  scores: [{ lane: 'claude', score: 100, yes: 3, no: 0, unknown: 0 }, { lane: 'codex-local', score: 33, yes: 1, no: 1, unknown: 1 }],
  topGaps: [
    { need: 'browser', label: 'Browser', state: 'missing', lanes: ['codex-local'], fix: 'Add Browser to the launch config of codex-local, then set "browser": true in <runs>/queue/lane-tools.json.' },
    { need: 'skill:review', label: 'Skill review', state: 'unknown', lanes: ['codex-local'], fix: 'Check Skill review on codex-local and record yes or no in <runs>/queue/lane-tools.json.' },
  ],
  sources: [{ name: 'router', state: 'declared' }, { name: 'connectors', state: 'degraded' }],
};

let viewport: ViewportMock | null = null;
function show(data: unknown, width: number, status = 'success') {
  viewport = mockViewport(width);
  state.read = { status, data };
  return render(<ToolsPane {...({ visible: true } as Parameters<typeof ToolsPane>[0])} />);
}
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; state.refetch.mockClear(); state.parity = { status: 'loading', data: undefined }; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Tools pane at %s', (_name, width) => {
  it('lists the top gaps with a plain fix, highlighting a declared gap', () => {
    show(MATRIX, width);
    const gaps = within(screen.getByRole('list', { name: 'Top gaps' })).getAllByRole('listitem');
    expect(gaps.map(g => g.querySelector('strong')!.textContent)).toEqual(['Browser missing on codex-local', 'Skill review unknown on codex-local']);
    expect(gaps[0]!.textContent).toContain('Add Browser to the launch config of codex-local');
    expect(gaps[0]!.querySelector('strong')!.className).toMatch(/no/);
    expect(screen.getByText('Could not read: connectors.')).toBeTruthy();
    expect(state.key).toBe('fleet-tools-matrix');
  });

  it('says unknown for an error or a payload that is not tools.matrix.v1, and reading while loading', () => {
    for (const [data, status] of [[undefined, 'error'], [{ schema: 'fleet.runs.v1' }, 'success'], [{}, 'success']] as const) {
      show(data, width, status);
      expect(screen.getByRole('alert').textContent).toBe('Tools: unknown (could not load). Refresh to try again.');
      cleanup();
    }
    show(undefined, width, 'loading');
    expect(screen.getByRole('status').textContent).toBe('Reading tools…');
  });
});

it('at desktop width shows the full matrix with scores, gaps highlighted and each cell naming its source', () => {
  show(MATRIX, 1440);
  const table = screen.getByRole('table', { name: 'Tools by lane' });
  expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Tool', 'claude100%', 'codex-local33%']);
  const browser = within(table).getByRole('rowheader', { name: 'Browser' }).closest('tr')!;
  const cells = within(browser).getAllByRole('cell');
  expect(cells.map(c => c.textContent)).toEqual(['yes', 'no']);
  expect(cells[1]!.className).toMatch(/no/);
  expect(cells[1]!.getAttribute('title')).toBe('no, from lane-tools.json');
  const skill = within(table).getByRole('rowheader', { name: 'Skill review' }).closest('tr')!;
  expect(within(skill).getAllByRole('cell')[1]!.getAttribute('title')).toBe('not declared by any source');
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('at 390 px shows one lane as a list and switches lane without a table', () => {
  show(MATRIX, 390);
  expect(screen.queryByRole('table')).toBeNull();
  const picker = screen.getByRole('combobox', { name: /Lane/ });
  expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['claude · 100%', 'codex-local · 33%']);
  expect(within(screen.getByRole('list', { name: 'claude tools' })).getAllByRole('listitem').map(li => li.textContent))
    .toEqual(['Browser · lane-tools.jsonyes', 'MCP server context7 · lane-tools.jsonyes', 'Skill review · lane-tools.jsonyes']);
  fireEvent.change(picker, { target: { value: 'codex-local' } });
  const items = within(screen.getByRole('list', { name: 'codex-local tools' })).getAllByRole('listitem');
  expect(items.map(li => li.textContent)).toEqual(['Browser · lane-tools.jsonno', 'MCP server context7 · connectorsyes', 'Skill review?']);
  expect(items[0]!.querySelector('strong')!.className).toMatch(/no/);
});

it('shows no lanes plainly, and Refresh refetches', () => {
  show({ ...MATRIX, lanes: [], rows: [], scores: [], topGaps: [] }, 1440);
  expect(screen.getByText('No lanes found.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tools' }));
  expect(state.refetch).toHaveBeenCalledTimes(2);
});

it('registers a session-independent Tools pane backed by the tools API', () => {
  expect(getPane('fleet-tools')).toMatchObject({ id: 'fleet-tools', title: 'Tools', needsSession: false });
  expect(TOOLS_PATH).toBe('/api/verse/fleet/runs/tools');
});

describe('Tool parity card', () => {
  const FAMILIES: LaneParityMatrix['families'] = [
    { id: 'mcp', label: 'MCP servers' }, { id: 'cli', label: 'CLI on PATH' }, { id: 'skills', label: 'Skills' }, { id: 'plugins', label: 'Plugins' },
    { id: 'web-search', label: 'Web search' }, { id: 'browser', label: 'Browser' }, { id: 'computer-use', label: 'Computer use' }, { id: 'gh', label: 'gh' },
  ];
  const row = (lane: string, over: Partial<Record<string, ParityCell>> = {}) => ({
    lane, cells: Object.fromEntries(FAMILIES.map(f => [f.id, over[f.id] ?? { state: 'unknown', source: null }])) as LaneParityMatrix['lanes'][number]['cells'],
  });
  const FIX = 'Give codex-local MCP server fetch, then add "mcp": ["context7","fetch"] under "codex-local" in <runs>/queue/lane-tools.json.';
  const PARITY: LaneParityMatrix = {
    schema: 'tools.parity.v2', version: 2, parity: 'gaps', families: FAMILIES, counts: { present: 1, missing: 1, unknown: 14 }, sources: [],
    lanes: [row('claude', { mcp: { state: 'present', source: 'lane-tools.json', has: ['context7', 'fetch'] } }), row('codex-local', { mcp: { state: 'missing', source: 'lane-tools.json', has: ['context7'], lacks: ['fetch'], fix: FIX } })],
  };

  it('shows lanes by tool family with present, missing and unknown, each cell naming its source, and one fix per missing cell', () => {
    state.parity = { status: 'success', data: PARITY };
    show(MATRIX, 1440);
    const card = within(screen.getByRole('region', { name: 'Tool parity' }));
    expect(card.getByText(/1 present, 1 missing, 14 unknown\./)).toBeTruthy();
    const table = card.getByRole('table', { name: 'Tool parity by lane' });
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Lane', ...FAMILIES.map(f => f.label)]);
    const cells = within(within(table).getByRole('rowheader', { name: 'codex-local' }).closest('tr')!).getAllByRole('cell');
    expect(cells.map(c => c.textContent)).toEqual(['missing', ...Array<string>(7).fill('unknown')]);
    expect(cells[0]!.className).toMatch(/no/);
    expect(cells[0]!.getAttribute('title')).toBe('missing, from lane-tools.json');
    expect(cells[1]!.getAttribute('title')).toBe('not declared by any source');
    expect(within(card.getByRole('list', { name: 'Parity fixes' })).getAllByRole('listitem').map(li => li.textContent)).toEqual([`codex-local: MCP servers${FIX}`]);
    expect(PARITY_PATH).toBe('/api/verse/fleet/runs/tools/parity');
  });

  it('says unknown, never an empty table, for an error or a payload that is not tools.parity.v2', () => {
    for (const parity of [{ status: 'error', data: undefined }, { status: 'success', data: { schema: 'tools.matrix.v1' } }]) {
      state.parity = parity;
      show(MATRIX, 390);
      const card = within(screen.getByRole('region', { name: 'Tool parity' }));
      expect(card.getByText('Tool parity: unknown (could not load).')).toBeTruthy();
      expect(card.queryByRole('table')).toBeNull();
      cleanup();
    }
    state.parity = { status: 'loading', data: undefined };
    show(MATRIX, 390);
    expect(screen.getByText('Reading tool parity…')).toBeTruthy();
  });
});
