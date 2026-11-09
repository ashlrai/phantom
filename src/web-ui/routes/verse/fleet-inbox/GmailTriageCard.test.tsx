import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { GmailTriageCard } from './GmailTriageCard.js';

const SCHEMA = 'fleet.gmail-triage-latest.v1';
const latest = (over: Record<string, unknown> = {}) => ({
  schema: SCHEMA, at: new Date(Date.now() - 2 * 3_600_000).toISOString(), dir: 'fixture-mail', scanned: 100, updates: 9,
  drafted: 4, review: 7, failed: 0, unreadInSample: 18, target: 100, archiveCandidateCount: 62, ...over,
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderNothing(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<GmailTriageCard visible />);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise(r => setTimeout(r, 20));
  expect(container).toBeEmptyDOMElement();
}

it('renders nothing on a 404', () => renderNothing(new Response('nope', { status: 404 })));
it('renders nothing on a server error', () => renderNothing(new Response('boom', { status: 500 })));
it('renders nothing on a malformed payload', () => renderNothing(Response.json({ schema: 'other', latest: null })));

it('says Gmail is not triaged yet and shows the command', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: SCHEMA, latest: null })));
  render(<GmailTriageCard visible />);
  expect(await screen.findByText('Gmail not triaged yet')).toBeInTheDocument();
  expect(screen.getByText('ashlr fleet gmail-triage --dir <eml dir>')).toBeInTheDocument();
});

it('shows the counts under target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: SCHEMA, latest: latest() })));
  render(<GmailTriageCard visible />);
  expect(await screen.findByText('Last triage 2h ago · 100 scanned · 4 drafted · 7 to review')).toBeInTheDocument();
  expect(screen.getByText('18 unread in the sample (target 100)')).toBeInTheDocument();
  expect(screen.getByText(/sample only/)).toBeInTheDocument();
  expect(screen.getByLabelText('Gmail triage')).not.toHaveAttribute('data-over-target');
});

it('marks the section and words the line when over target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: SCHEMA, latest: latest({ unreadInSample: 140 }) })));
  render(<GmailTriageCard visible />);
  expect(await screen.findByText('62 archive candidates, unread over target 100')).toBeInTheDocument();
  expect(screen.getByLabelText('Gmail triage')).toHaveAttribute('data-over-target', 'true');
});
