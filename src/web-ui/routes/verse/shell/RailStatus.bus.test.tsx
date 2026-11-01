import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RailBusChip } from './RailStatus.js';

const queries = vi.hoisted(() => ({ status: vi.fn(), page: vi.fn(), pageQuery: vi.fn() }));
vi.mock('../fleet-bus/agent-bus-queries.js', () => ({
  agentBusStatusQuery: { fetch: queries.status },
  agentBusPageQuery: queries.pageQuery,
}));
const row = (cursor: number, to: string) => ({ cursor, receivedAt: 1000,
  envelope: { id: `fake-${cursor}`, from: 'claude-leader', to, priority: 'P2', ttl: 1000, body: null } });
const status = { source: 'available', retainedCount: 102 };

beforeEach(() => {
  localStorage.clear();
  queries.status.mockReset().mockResolvedValue(status);
  queries.page.mockReset().mockResolvedValue({ messages: [row(101, 'mason'), row(102, 'MASON'), row(103, 'leader')] });
  queries.pageQuery.mockReset().mockReturnValue({ fetch: queries.page });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

it('opens the Bus and persists the newest addressed cursor on click and reload', async () => {
  const openBus = vi.fn();
  const view = render(<RailBusChip openBus={openBus} />);
  fireEvent.click(await screen.findByRole('button', { name: '2 new for you on the bus' }));
  expect(openBus).toHaveBeenCalledOnce();
  expect(localStorage.getItem('verse.bus.seen.v1')).toBe('{"cursor":102}');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(queries.pageQuery).toHaveBeenCalledWith(2, 100);
  view.unmount();
  render(<RailBusChip openBus={openBus} />);
  await waitFor(() => expect(queries.page).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  cleanup();
  queries.page.mockResolvedValue({ messages: [row(103, 'mason')] });
  render(<RailBusChip openBus={openBus} />);
  expect(await screen.findByRole('button', { name: '1 new for you on the bus (from claude-leader)' })).toBeInTheDocument();
});

it('does not render when no messages are addressed to Mason', async () => {
  queries.page.mockResolvedValue({ messages: [row(5, 'leader')] });
  render(<RailBusChip openBus={vi.fn()} />);
  await waitFor(() => expect(queries.page).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it.each([404, 503])('silently hides an unavailable bus (%s)', async code => {
  queries.status.mockRejectedValue(Object.assign(new Error('unavailable'), { status: code }));
  const log = vi.spyOn(console, 'error');
  render(<RailBusChip openBus={vi.fn()} />);
  await waitFor(() => expect(queries.status).toHaveBeenCalledOnce());
  expect(queries.page).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(log).not.toHaveBeenCalled();
});

it('hides the chip if the page becomes unavailable after the status read', async () => {
  queries.page.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
  const log = vi.spyOn(console, 'error');
  render(<RailBusChip openBus={vi.fn()} />);
  await waitFor(() => expect(queries.page).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(log).not.toHaveBeenCalled();
});

it('pauses polling while hidden and refreshes when visible', async () => {
  vi.useFakeTimers();
  let visible = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  render(<RailBusChip openBus={vi.fn()} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(queries.status).toHaveBeenCalledTimes(2);
  visible = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(queries.status).toHaveBeenCalledTimes(2);
  visible = true;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(queries.status).toHaveBeenCalledTimes(3);
});
