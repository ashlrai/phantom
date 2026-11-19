import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INVENTORY_KINDS, INVENTORY_KIND_LABELS, INVENTORY_PATH,
  type Inventory, type InventoryCounts, type InventoryItem, type InventoryKind,
} from '../../../../core/fleet/inventory-schema.js';
import { apiGet } from '../../../data/client.js';
import { getPane } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import './inventory.pane.js';
import { InventoryPane, MAX_SHOWN } from './InventoryPane.js';

type Query = { key: string; fetch: (signal: AbortSignal) => Promise<unknown> };
const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown }, query: null as unknown, refetch: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (query: unknown) => { state.query = query; return state.read; },
  useRefetch: () => state.refetch,
}));
vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn(async () => ({})) }));

const item = (kind: InventoryKind, name: string, itemState: InventoryItem['state'], detail: string, over: Partial<InventoryItem> = {}): InventoryItem =>
  ({ kind, id: `${kind}:${name}`, name, state: itemState, detail, lastChecked: '2026-01-01T00:00:00Z', usedByLanes: 'all', next: null, ...over });
const ITEMS: InventoryItem[] = [
  item('channel', 'slack', 'needs setup', 'Not linked yet.', { next: { text: 'Link the workspace.', command: 'phm channels add slack' } }),
  item('connector', 'github', 'ready', 'Signed in.', { usedByLanes: ['claude', 'codex-local'] }),
  item('connector', 'linear', 'error', 'Last read failed.', { usedByLanes: [], next: { text: 'Open settings and sign in again.', command: null } }),
  item('plugin', 'notes', 'off', 'Turned off.'),
  item('skill', 'review', 'unknown', 'No source says.', { usedByLanes: 'unknown', lastChecked: null }),
  item('tool', 'browser', 'ready', 'Opens web pages.', { usedByLanes: ['claude'] }),
];
function countOf(items: InventoryItem[]): InventoryCounts {
  const counts: InventoryCounts = { ready: 0, 'needs setup': 0, off: 0, error: 0, unknown: 0 };
  for (const i of items) counts[i.state] += 1;
  return counts;
}
function inventory(items: InventoryItem[] = ITEMS, parity: Inventory['parity'] = PARITY): Inventory {
  return {
    schema: 'phantom.inventory.v1', version: 1, at: '2026-01-01T00:00:00Z', kind: null, counts: countOf(items), items, parity,
    kinds: INVENTORY_KINDS.map(kind => { const own = items.filter(i => i.kind === kind); return { kind, label: INVENTORY_KIND_LABELS[kind], total: own.length, counts: countOf(own) }; }),
  };
}
/** claude has everything declared; codex-local lacks the browser and one id no item names. */
const PARITY: Inventory['parity'] = {
  compared: 3, widestGap: 2,
  lanes: [
    { lane: 'claude', has: ['connector:github', 'tool:browser'], lacks: [], unknown: 1, gap: 0 },
    { lane: 'codex-local', has: ['connector:github'], lacks: ['tool:browser', 'tool:gone'], unknown: 0, gap: 2 },
  ],
};

let viewport: ViewportMock | null = null;
function show(data: unknown, width: number, status = 'success') {
  viewport = mockViewport(width);
  state.read = { status, data };
  return render(<InventoryPane {...({ visible: true } as Parameters<typeof InventoryPane>[0])} />);
}
const names = () => within(screen.getByRole('list', { name: 'Inventory items' })).getAllByRole('listitem').map(li => li.querySelector('strong')!.textContent);
const row = (name: string) => screen.getByText(name, { selector: 'strong' }).closest('li')!;
const counts = () => screen.getByLabelText('State counts').textContent;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; state.refetch.mockClear(); vi.unstubAllGlobals(); });

describe.each([['390 px', 390], ['desktop width', 1440]])('Inventory pane at %s', (_name, width) => {
  it('shows a chip per kind with its total, and a chip filters the list and the state counts', () => {
    show(inventory(), width);
    const chips = within(screen.getByRole('group', { name: 'Kind' })).getAllByRole('button');
    expect(chips.map(c => c.textContent)).toEqual(['All 6', 'Channels 1', 'Connectors 2', 'Plugins 1', 'Skills 1', 'Tools 1']);
    expect(chips.map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    expect(names()).toEqual(['slack', 'github', 'linear', 'notes', 'review', 'browser']);
    expect(counts()).toBe('2 ready · 1 needs setup · 1 off · 1 error · 1 unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Connectors 2' }));
    expect(screen.getByRole('button', { name: 'Connectors 2' }).getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual(['github', 'linear']);
    expect(counts()).toBe('1 ready · 0 needs setup · 0 off · 1 error · 0 unknown');
    fireEvent.click(screen.getByRole('button', { name: 'All 6' }));
    expect(names()).toHaveLength(6);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows each item with its state word, detail and lanes, and nothing else from it', () => {
    show(inventory(), width);
    expect(row('github').textContent).toBe('githubreadySigned in.Lanes: claude, codex-local');
    expect(row('linear').textContent).toBe('linearerrorLast read failed.Lanes: noneNext: Open settings and sign in again.');
    expect(within(row('linear')).queryByRole('button')).toBeNull();
    expect(row('notes').textContent).toBe('notesoffTurned off.Lanes: all lanes');
    expect(row('review').textContent).toBe('reviewunknownNo source says.Lanes: unknown');
    expect(row('linear').querySelector('[data-state]')!.getAttribute('data-state')).toBe('error');
    expect(row('slack').querySelector('[data-state]')!.getAttribute('data-state')).toBe('needs setup');
  });

  it('shows the next step of an item that needs setup, and Copy copies exactly its command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    show(inventory(), width);
    const slack = within(row('slack'));
    expect(slack.getByText('Next: Link the workspace.')).toBeTruthy();
    expect(row('slack').querySelector('code')!.textContent).toBe('phm channels add slack');
    fireEvent.click(slack.getByRole('button', { name: 'Copy command for slack' }));
    expect((await slack.findByRole('status')).textContent).toBe('Copied');
    expect(writeText.mock.calls).toEqual([['phm channels add slack']]);
  });

  it('searches name, detail and state, and says so when nothing matches', () => {
    show(inventory(), width);
    const search = screen.getByRole('searchbox', { name: 'Search inventory' });
    fireEvent.change(search, { target: { value: 'GIT' } });
    expect(names()).toEqual(['github']);
    fireEvent.change(search, { target: { value: 'web pages' } });
    expect(names()).toEqual(['browser']);
    fireEvent.change(search, { target: { value: 'needs' } });
    expect(names()).toEqual(['slack']);
    fireEvent.change(search, { target: { value: ' zebra ' } });
    expect(screen.getByText('Nothing matches “zebra”.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Inventory items' })).toBeNull();
  });

  it('shows the lane tool gap, one row per lane, and names what a lane lacks', () => {
    show(inventory(), width);
    const gap = within(screen.getByRole('region', { name: 'Lane tool gap' }));
    expect(gap.getByRole('heading').textContent).toBe('Tool gap between lanes: 2');
    expect(gap.getByText('Each lane against 3 tools and connectors. Unknown is never counted as lacking.')).toBeTruthy();
    const lanes = Array.from(gap.getByRole('list', { name: 'Lanes' }).children);
    expect(lanes.map(li => li.querySelector('div')!.textContent)).toEqual(['claudecan use 2lacks 0unknown 1', 'codex-localcan use 1lacks 2unknown 0']);
    expect(lanes[0]!.querySelector('details')).toBeNull();
    const lacking = lanes[1]!.querySelector('details')!;
    expect(Array.from(lacking.querySelectorAll('li')).map(li => li.textContent)).toEqual(['browser', 'tool:gone']);
  });

  it('says unknown for an error or a payload that is not the inventory schema, and reading while loading', () => {
    for (const [data, status] of [[undefined, 'error'], [{ schema: 'fleet.runs.v1' }, 'success'], [{}, 'success'], [{ ...inventory(), parity: undefined }, 'success']] as const) {
      show(data, width, status);
      expect(screen.getByRole('alert').textContent).toBe('Inventory: unknown (could not load). Refresh to try again.');
      cleanup();
    }
    show(undefined, width, 'loading');
    expect(screen.getByRole('status').textContent).toBe('Reading inventory…');
  });
});

it('says plainly when a kind is empty and when no lanes are known', () => {
  show(inventory(ITEMS.filter(i => i.kind !== 'plugin'), { compared: 0, widestGap: 0, lanes: [] }), 390);
  fireEvent.click(screen.getByRole('button', { name: 'Plugins 0' }));
  expect(screen.getByText('No plugins found.')).toBeTruthy();
  expect(screen.getByLabelText('State counts').textContent).toBe('0 ready · 0 needs setup · 0 off · 0 error · 0 unknown');
  expect(within(screen.getByRole('region', { name: 'Lane tool gap' })).getByText('No lanes known.')).toBeTruthy();
});

it('draws at most 200 items and says how many there are', () => {
  const many = Array.from({ length: MAX_SHOWN + 5 }, (_, n) => item('skill', `skill-${n}`, 'ready', 'A skill.'));
  show(inventory(many), 390);
  expect(names()).toHaveLength(200);
  expect(screen.getByText('Showing 200 of 205. Search to narrow.')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search inventory' }), { target: { value: 'skill-20' } });
  expect(names()).toEqual(['skill-20', 'skill-200', 'skill-201', 'skill-202', 'skill-203', 'skill-204']);
  expect(screen.queryByText(/Search to narrow/)).toBeNull();
});

it('registers a session-independent Inventory pane that reads the whole inventory in one fetch, and Refresh refetches', async () => {
  expect(getPane('fleet-inventory')).toMatchObject({ id: 'fleet-inventory', title: 'Inventory', needsSession: false });
  show(inventory(), 1440);
  const query = state.query as Query;
  expect(query.key).toBe('fleet-inventory');
  const signal = new AbortController().signal;
  await query.fetch(signal);
  expect(vi.mocked(apiGet).mock.calls).toEqual([[INVENTORY_PATH, signal]]);
  expect(INVENTORY_PATH).toBe('/api/verse/fleet/runs/inventory');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
});
