import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { QueueActionV1, QueueOrderV1 } from '../../../../core/queue/order-types.js';
import * as auth from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { FleetQueuePane } from './FleetQueuePane.js';
import { QueueOrderList } from './QueueOrderList.js';
import { QUEUE_ORDER_PATH, queueOrderQuery } from './queue-order-action.js';

const job = (position: number, id: string, lane: string, supersededBy: string | null = null) =>
  ({ position, id, repo: 'phantom', lane, tier: 'mid', ageSeconds: position === 1 ? 600 : null, family: null, supersededBy });
const order = (): QueueOrderV1 => ({ schema: 'queue.order.v1', version: 1, generatedAt: '2026-11-17T12:00:00Z', count: 3, parked: 0,
  lanes: ['claude', 'codex-personal', 'devin'], jobs: [job(1, 'RQ-FIRST', 'claude'), job(2, 'RQ-PHX-AREAC541', 'devin', 'RQ-PHX-AREAC544'), job(3, 'RQ-PHX-AREAC544', 'devin')] });
const done = (message: string) => Response.json({ schema: 'queue.action.v1', version: 1, action: 'top', id: 'x', dryRun: false, changed: true, verified: true,
  from: { position: 2, of: 3, lane: 'devin' }, to: { position: 1, lane: 'devin' }, backup: 'ready.tsv.bak', archive: null, message } satisfies QueueActionV1);

const fetchMock = vi.fn();
let viewport: ViewportMock | null = null;
beforeEach(() => {
  evictAll(); sessionStorage.clear(); fetchMock.mockReset();
  vi.spyOn(auth, 'getMutationToken').mockReturnValue('test-only');
  vi.spyOn(auth, 'touchMutationHold').mockImplementation(() => {});
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path, init]) => [path, JSON.parse(init.body as string)]);

describe.each([['desktop width', 1440], ['390 px', 390]])('Launch order at %s', (_name, width) => {
  function setup() {
    viewport = mockViewport(width);
    const onChanged = vi.fn();
    render(<QueueOrderList order={order()} onOpenJob={() => {}} onChanged={onChanged} />);
    return { onChanged, rows: within(screen.getByRole('region', { name: 'Launch order' })).getAllByRole('listitem') };
  }
  it('lists jobs in launch order with Top, Lane and Drop, and dims replaced rows', () => {
    const { rows } = setup();
    expect(rows.map(row => row.textContent?.split(' · ')[0])).toEqual(['1. RQ-FIRST', '2. RQ-PHX-AREAC541', '3. RQ-PHX-AREAC544']);
    expect(rows[0]!.textContent).toContain('phantom · claude · mid · 10m');
    expect(rows.map(row => row.getAttribute('data-superseded'))).toEqual([null, 'true', null]);
    expect(rows[1]!.textContent).toContain('replaced by RQ-PHX-AREAC544');
    for (const row of rows) expect(within(row).getAllByRole('button').slice(-3).map(button => button.textContent)).toEqual(['Top', 'Lane', 'Drop']);
    expect(screen.getByRole('button', { name: 'Move RQ-FIRST to the top' })).toBeDisabled();
  });
  it('Top posts once and shows what changed', async () => {
    fetchMock.mockResolvedValue(done('Moved RQ-PHX-AREAC544 to the top (was 3 of 3).'));
    const { onChanged } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move RQ-PHX-AREAC544 to the top' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Moved RQ-PHX-AREAC544 to the top (was 3 of 3).');
    expect(posted()).toEqual([[QUEUE_ORDER_PATH, { action: 'top', id: 'RQ-PHX-AREAC544' }]]);
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ 'x-ashlr-token': 'test-only' });
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it('Lane offers the other open lanes and moves on choice', async () => {
    fetchMock.mockResolvedValue(done('Moved RQ-FIRST from claude to devin.'));
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Change lane for RQ-FIRST' }));
    const picker = screen.getByLabelText('New lane for RQ-FIRST');
    expect(within(picker).getAllByRole('option').map(option => option.textContent)).toEqual(['Move to…', 'codex-personal', 'devin']);
    fireEvent.change(picker, { target: { value: 'devin' } });
    expect(await screen.findByRole('status')).toHaveTextContent('Moved RQ-FIRST from claude to devin.');
    expect(posted()).toEqual([[QUEUE_ORDER_PATH, { action: 'lane', id: 'RQ-FIRST', lane: 'devin' }]]);
  });
  it('Drop asks once, and Keep changes nothing', async () => {
    fetchMock.mockResolvedValue(done('Dropped RQ-FIRST (was 1 of 3). Its row is kept in queue/dropped.tsv.'));
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Drop RQ-FIRST' }));
    expect(screen.getByText('Drop RQ-FIRST?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Drop RQ-FIRST' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drop it' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Dropped RQ-FIRST');
    expect(posted()).toEqual([[QUEUE_ORDER_PATH, { action: 'drop', id: 'RQ-FIRST' }]]);
  });
  it('shows the server refusal in its own words', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'QUEUE_REFUSED', reason: 'job-not-found', error: 'That job is not in the queue.' }, { status: 404 }));
    const { onChanged } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move RQ-PHX-AREAC544 to the top' }));
    expect(await screen.findByRole('status')).toHaveTextContent('That job is not in the queue.');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

it('the Queue pane shows the list from the queue order API and leaves it out when the server has none', async () => {
  const queue = { v: 1, generatedAt: '2026-01-01T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' }, total: 3, ready: 3, parked: 0, malformed: 0, skipsLast24h: 0, byLane: [], groups: [], skips: [] };
  fetchMock.mockImplementation(async (path: string) => Response.json(path === QUEUE_ORDER_PATH ? order() : queue));
  const view = render(<FleetQueuePane {...({ visible: true, host: { openPane: () => {} } } as unknown as PaneProps)} />);
  expect(within(await screen.findByRole('region', { name: 'Launch order' })).getAllByRole('listitem')).toHaveLength(3);
  view.unmount(); evictAll();
  fetchMock.mockImplementation(async () => Response.json(queue));
  expect(await queueOrderQuery.fetch()).toBeNull();
  render(<FleetQueuePane {...({ visible: true, host: { openPane: () => {} } } as unknown as PaneProps)} />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'By lane' })).toBeInTheDocument());
  expect(screen.queryByRole('region', { name: 'Launch order' })).toBeNull();
});
