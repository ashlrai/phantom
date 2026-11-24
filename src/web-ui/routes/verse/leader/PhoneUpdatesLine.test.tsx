import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { PhoneUpdatesLine } from './PhoneUpdatesLine.js';

const report = { schema: 'owner-live.status.v1', anyOn: false, line: 'Phone updates: off (iMessage not set up)',
  channels: [{ channel: 'imessage', state: 'not-set-up', reason: 'x', decidedBy: [], nextStep: 'Set [imessage] bridge = "loopback".' }] };
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the one-line phone updates row with the next step', async () => {
  serve(report);
  render(<PhoneUpdatesLine />);
  expect(await screen.findByText(/Phone updates: off \(iMessage not set up\)/)).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/verse/fleet/runs/owner-live');
});

it('draws nothing when the report is missing', async () => {
  serve({ error: 'no' }, 503);
  const view = render(<PhoneUpdatesLine />);
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(view.container).toBeEmptyDOMElement();
});
