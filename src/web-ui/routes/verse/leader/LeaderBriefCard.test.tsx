import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { LEADER_BRIEF_COLLAPSED_KEY, LeaderBriefCard } from './LeaderBriefCard.js';

const SCHEMA = 'comms.owner-status.v1';
const at = () => new Date(Date.now() - 4 * 60_000).toISOString();
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

beforeEach(() => { evictAll(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders the brief lines as literal text with the age in the header', async () => {
  serve({ schema: SCHEMA, at: at(), text: 'Phantom status\nNeeds you: <b>pay now</b>\nQuota: claude 80%' });
  const { container } = render(<LeaderBriefCard />);
  expect(await screen.findByText('Needs you: <b>pay now</b>')).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/verse/comms/owner-thread/status');
  expect(screen.getByText('Quota: claude 80%')).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
  expect(screen.getByRole('button', { name: /Phantom status · 4m ago/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
});

it('refreshes on demand', async () => {
  serve({ schema: SCHEMA, at: at(), text: 'Phantom status\nline' });
  render(<LeaderBriefCard />);
  await screen.findByText('line');
  const fetchMock = vi.mocked(fetch);
  const before = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
});

it('persists the collapsed state', async () => {
  serve({ schema: SCHEMA, at: at(), text: 'Phantom status\nline' });
  const first = render(<LeaderBriefCard />);
  await screen.findByText('line');
  fireEvent.click(screen.getByRole('button', { name: /Phantom status/ }));
  expect(screen.queryByText('line')).toBeNull();
  expect(window.localStorage.getItem(LEADER_BRIEF_COLLAPSED_KEY)).toBe('1');
  first.unmount();
  render(<LeaderBriefCard />);
  await screen.findByRole('button', { name: /Phantom status/ });
  expect(screen.queryByText('line')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Phantom status/ }));
  expect(await screen.findByText('line')).toBeInTheDocument();
  expect(window.localStorage.getItem(LEADER_BRIEF_COLLAPSED_KEY)).toBe('0');
});

it('shows the command when the status read is unavailable', async () => {
  serve({ schema: SCHEMA, unavailable: true });
  render(<LeaderBriefCard />);
  expect(await screen.findByText(/Status read unavailable/)).toBeInTheDocument();
  expect(screen.getByText('ashlr fleet brief-send')).toBeInTheDocument();
});

it('treats a server error as unavailable too', async () => {
  serve({ error: 'boom' }, 500);
  render(<LeaderBriefCard />);
  expect(await screen.findByText(/Status read unavailable/)).toBeInTheDocument();
});
