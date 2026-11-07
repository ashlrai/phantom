import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { MainHealthRows, mainHealthLine } from './MainHealthRows.js';

const body = {
  v: 1, generatedAt: '2026-11-02T12:00:00.000Z', known: true,
  repos: [
    { repo: 'o/one', state: 'red', redSince: '2026-11-02T10:00:00Z', redMinutes: 120, attempts: 2, currentJob: 'RQ-1' },
    { repo: 'o/two', state: 'red', redSince: '2026-11-02T11:30:00Z', redMinutes: 30, attempts: 0, currentJob: null },
    { repo: 'o/three', state: 'green', redSince: null, redMinutes: null, attempts: 1, currentJob: null },
    { repo: 'o/four', state: 'unknown', redSince: null, redMinutes: null, attempts: null, currentJob: null },
  ],
};

const serve = (data: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows one compact row per repo: state, minutes red, attempts and fix job', async () => {
  serve(body);
  render(<MainHealthRows />);
  const rows = await screen.findAllByRole('listitem');
  expect(rows).toHaveLength(4);
  const list = screen.getByRole('list', { name: 'Main health per repo' });
  expect(within(list).getByText('o/one').parentElement).toHaveTextContent('o/one · red 120 min · 2 attempts · fix RQ-1');
  expect(within(list).getByText('o/two').parentElement).toHaveTextContent('o/two · red 30 min · 0 attempts');
  expect(within(list).getByText('o/three').parentElement).toHaveTextContent('o/three · green · 1 attempt');
  expect(within(list).getByText('o/four').parentElement).toHaveTextContent('o/four · unknown · attempts unknown');
  expect(within(list).getByText('o/one').parentElement).toHaveAttribute('data-state', 'red');
});

it('says unknown plainly when the guardian state could not be read — never green', async () => {
  serve({ v: 1, generatedAt: '2026-11-02T12:00:00.000Z', known: false, repos: [] });
  render(<MainHealthRows />);
  expect(await screen.findByText('Unknown — the guardian state could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Main health per repo' })).not.toHaveTextContent('green');
});

it('says nothing when the route is not in this build', async () => {
  serve({}, 404);
  const { container } = render(<MainHealthRows />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it('formats the status half of a row like the CLI does', () => {
  expect(mainHealthLine({ repo: 'o/one', state: 'red', redSince: 'x', redMinutes: 120, attempts: 2, currentJob: 'RQ-1' }))
    .toBe('red 120 min · 2 attempts · fix RQ-1');
  expect(mainHealthLine({ repo: 'o/two', state: 'red', redSince: 'x', redMinutes: null, attempts: null, currentJob: null }))
    .toBe('red · attempts unknown');
  expect(mainHealthLine({ repo: 'o/three', state: 'green', redSince: null, redMinutes: null, attempts: 1, currentJob: null }))
    .toBe('green · 1 attempt');
});
