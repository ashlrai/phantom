import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { MergePulse } from './MergePulse.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const fixture = (ageSeconds: number, count: number) => ({
  generatedAt: new Date().toISOString(), lastTick: null, paused: false, claudeLane: null,
  workers: [{ ageSeconds }], mergesLastHour: { count }, events: [],
});

it('renders nothing for an absent route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })));
  const { container } = render(<MergePulse />);
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-runs').status).toBe('error'));
  expect(container).toBeEmptyDOMElement();
});

it('announces the incident headline as an alert', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture(34 * 60, 0))));
  render(<MergePulse />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Incident: nothing started for 34 min and nothing merged in the last hour');
  expect(alert).toHaveAttribute('data-state', 'incident');
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/runs', expect.anything());
});

it('announces a calm pulse politely', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture(180, 4))));
  render(<MergePulse />);
  expect(await screen.findByRole('status')).toHaveTextContent('Last start 3 min ago · 4 merged in the last hour');
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
});

it('renders nothing for an unknown snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  const { container } = render(<MergePulse />);
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-runs').status).toBe('success'));
  expect(container).toBeEmptyDOMElement();
});
